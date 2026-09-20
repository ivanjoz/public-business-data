// Package sources fetches what SUNAT published. Two endpoints with different jobs: the .txt
// on sunat.gob.pe is authoritative but only ever answers today, and the apis.net.pe mirror
// answers a whole month at a time. The portal that would answer both, e-consulta.sunat.gob.pe,
// sits behind a WAF with reCAPTCHA and rejects automated requests.
package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SunatTodayURL publishes a single line: "20/09/2026|3.354|3.362|".
const SunatTodayURL = "https://www.sunat.gob.pe/a/txt/tipoCambio.txt"

// MirrorMonthURL answers the whole month as JSON. It rate-limits bursts with a 429.
const MirrorMonthURL = "https://api.apis.net.pe/v1/tipo-cambio-sunat?month=%02d&year=%d"

// userAgent is sent because both endpoints answer differently to a bare Go client.
const userAgent = "public-business-data/1.0 (+https://github.com/ivanjoz/public-business-data)"

// DailyRate is one published day, already scaled by binfmt.Scale.
type DailyRate struct {
	Date time.Time
	Buy  int32
	Sell int32
}

// FetchToday reads the official file. It is the only authoritative endpoint reachable without
// a browser, which is why its value wins over the mirror's for the same day.
func FetchToday(ctx context.Context, client *http.Client) (DailyRate, error) {
	body, err := get(ctx, client, SunatTodayURL)
	if err != nil {
		return DailyRate{}, err
	}

	fields := strings.Split(strings.TrimSpace(string(body)), "|")
	if len(fields) < 3 {
		return DailyRate{}, fmt.Errorf("respuesta inesperada de SUNAT: %q", string(body))
	}
	date, err := time.Parse("02/01/2006", fields[0])
	if err != nil {
		return DailyRate{}, fmt.Errorf("fecha inesperada de SUNAT %q: %w", fields[0], err)
	}
	buy, err := parseScaled(fields[1])
	if err != nil {
		return DailyRate{}, err
	}
	sell, err := parseScaled(fields[2])
	if err != nil {
		return DailyRate{}, err
	}
	return DailyRate{Date: date, Buy: buy, Sell: sell}, nil
}

// mirrorDay is the mirror's JSON shape.
type mirrorDay struct {
	Fecha  string  `json:"fecha"`
	Compra float64 `json:"compra"`
	Venta  float64 `json:"venta"`
	Moneda string  `json:"moneda"`
}

// FetchMonth reads a full month from the mirror, retrying its 429. Asking for the whole month
// costs the same single request as asking for two days and makes the update self-healing: a
// run that was missed, or a day SUNAT later corrected, is picked up by the next run.
func FetchMonth(ctx context.Context, client *http.Client, year int, month time.Month) ([]DailyRate, error) {
	var body []byte
	var err error

	for attempt := range 4 {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt*attempt) * 2 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		body, err = get(ctx, client, fmt.Sprintf(MirrorMonthURL, int(month), year))
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}

	var days []mirrorDay
	if err := json.Unmarshal(body, &days); err != nil {
		return nil, fmt.Errorf("respuesta inesperada del espejo (%s): %w", truncate(string(body), 120), err)
	}

	rates := make([]DailyRate, 0, len(days))
	for _, day := range days {
		if day.Moneda != "" && day.Moneda != "USD" {
			continue
		}
		date, err := time.Parse(time.DateOnly, day.Fecha)
		if err != nil {
			return nil, fmt.Errorf("fecha inesperada del espejo %q: %w", day.Fecha, err)
		}
		rates = append(rates, DailyRate{
			Date: date,
			Buy:  int32(day.Compra*1000 + 0.5),
			Sell: int32(day.Venta*1000 + 0.5),
		})
	}
	return rates, nil
}

// parseScaled turns "3.354" into 3354 without going through a float wide enough to drift.
func parseScaled(text string) (int32, error) {
	value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil {
		return 0, fmt.Errorf("cotización inesperada %q: %w", text, err)
	}
	return int32(value*1000 + 0.5), nil
}

func get(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", userAgent)

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s respondió %d: %s", url, response.StatusCode, truncate(string(body), 120))
	}
	return body, nil
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}
