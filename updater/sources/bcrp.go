// BCRPData is the other half of this package: the BCRP's public series API, which is the only
// state-run endpoint that publishes a *market* quote — the interbank rate banks trade dollars
// between themselves at — instead of the accounting value SUNAT and the SBS publish. No API key,
// no registration; the whole cost of using it is the two quirks documented below.

package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// The two daily series published as "TC Interbancario (S/ por US$)". The BCRP declares them with
// three decimals even though it answers the weighted average with fourteen.
const (
	BcrpInterbankBuy  = "PD04637PD"
	BcrpInterbankSell = "PD04638PD"
)

// BcrpSeriesURL takes the series joined by a hyphen and the range as two dates.
//
// The range has to be YYYY-MM-DD. The BCRP documents a year-month form (2026-8), which belongs to
// the monthly series: asked of a daily series it is either blocked by the WAF or answered 200 with
// the right daily periods and every single value as "n.d." — a well-formed, entirely empty
// response, which is the worst possible failure for an unattended updater. Measured over seven
// attempts spaced a minute apart: six blocked, one empty, zero with data. The same ranges in
// YYYY-MM-DD answered with values every time.
const BcrpSeriesURL = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/%s-%s/json/%s/%s"

// bcrpUserAgent is a browser's, and not this project's, because estadisticas.bcrp.gob.pe sits
// behind Incapsula: to a client that does not look like a browser it answers a JavaScript
// challenge — with status 200, so only the body gives it away.
const bcrpUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/140.0.0.0 Safari/537.36"

// bcrpMissing is what the API puts where a day has no value: a holiday, a weekend, or today
// before the market closed.
const bcrpMissing = "n.d."

// bcrpResponse is the part of the payload that carries data. `config` also comes back, naming the
// series and its declared decimals, but nothing here needs it.
type bcrpResponse struct {
	Periods []struct {
		Name   string   `json:"name"`
		Values []string `json:"values"`
	} `json:"periods"`
}

// bcrpMonths maps the abbreviations the API prints in each period name. September is "Set", not
// "Sep", which is why this is a table and not a time layout.
var bcrpMonths = map[string]time.Month{
	"ene": time.January, "feb": time.February, "mar": time.March, "abr": time.April,
	"may": time.May, "jun": time.June, "jul": time.July, "ago": time.August,
	"set": time.September, "sep": time.September, "oct": time.October,
	"nov": time.November, "dic": time.December,
}

// FetchBCRP reads the interbank rate for [from, to], both inclusive. Both series travel in one
// request — the API takes up to ten — so a run costs the BCRP exactly one call no matter how wide
// the window is.
func FetchBCRP(ctx context.Context, client *http.Client, from, to time.Time) ([]DailyRate, error) {
	url := fmt.Sprintf(BcrpSeriesURL, BcrpInterbankBuy, BcrpInterbankSell,
		from.Format(time.DateOnly), to.Format(time.DateOnly))

	body, err := getWithRetry(ctx, client, url, bcrpUserAgent)
	if err != nil {
		return nil, err
	}

	var parsed bcrpResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("respuesta inesperada del BCRP (%s): %w", truncate(string(body), 120), err)
	}

	rates := make([]DailyRate, 0, len(parsed.Periods))
	for _, period := range parsed.Periods {
		if len(period.Values) != 2 {
			return nil, fmt.Errorf("periodo %q del BCRP trae %d valores y se pidieron 2",
				period.Name, len(period.Values))
		}
		if period.Values[0] == bcrpMissing || period.Values[1] == bcrpMissing {
			continue
		}

		date, err := parseBcrpDate(period.Name, from, to)
		if err != nil {
			return nil, err
		}
		// A day outside the window would mean the API widened the range on its own; dropping it
		// keeps the caller's promise that what comes back is what it asked for.
		if date.Before(from) || date.After(to) {
			continue
		}

		buy, err := parseScaled(period.Values[0])
		if err != nil {
			return nil, fmt.Errorf("compra del %s: %w", period.Name, err)
		}
		sell, err := parseScaled(period.Values[1])
		if err != nil {
			return nil, fmt.Errorf("venta del %s: %w", period.Name, err)
		}
		rates = append(rates, DailyRate{Date: date, Buy: buy, Sell: sell})
	}
	return rates, nil
}

// parseBcrpDate reads "03.Ago.26". The year is two digits, so the century is resolved against the
// window that was asked for instead of being assumed: "94" is 1994 in a request for the nineties
// and would be a bug if it silently became 2094.
func parseBcrpDate(name string, from, to time.Time) (time.Time, error) {
	parts := strings.Split(strings.TrimSpace(name), ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("periodo inesperado del BCRP: %q", name)
	}

	month, known := bcrpMonths[strings.ToLower(parts[1])]
	if !known {
		return time.Time{}, fmt.Errorf("mes inesperado del BCRP en %q: %q", name, parts[1])
	}

	var day, shortYear int
	if _, err := fmt.Sscanf(parts[0], "%d", &day); err != nil {
		return time.Time{}, fmt.Errorf("día inesperado del BCRP en %q: %w", name, err)
	}
	if _, err := fmt.Sscanf(parts[2], "%d", &shortYear); err != nil {
		return time.Time{}, fmt.Errorf("año inesperado del BCRP en %q: %w", name, err)
	}

	for _, century := range []int{2000, 1900} {
		date := time.Date(century+shortYear, month, day, 0, 0, 0, 0, time.UTC)
		if !date.Before(from.AddDate(-1, 0, 0)) && !date.After(to.AddDate(1, 0, 0)) {
			return date, nil
		}
	}
	return time.Time{}, fmt.Errorf("el periodo %q del BCRP no cae en el rango pedido (%s a %s)",
		name, from.Format(time.DateOnly), to.Format(time.DateOnly))
}
