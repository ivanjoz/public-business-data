// Command backfill seeds docs/ with the history of one dataset. It exists for the first publish
// and for a rebuild after a format change; day-to-day the lambda keeps the files current. It goes
// through the same binfmt encoder the lambda uses, so a rebuild can never produce bytes the
// lambda would then "fix" on its next run.
//
// SUNAT comes from the JSON snapshot in data/, because its own portal will not answer a range
// without a browser. The BCRP comes from its API, which answers any range:
//
//	go run ./cmd/backfill -dataset sunat -source ../data/tipo-cambio-sunat-usd-pen.json -out ../docs
//	go run ./cmd/backfill -dataset bcrp -from 2021-01-01 -out ../docs
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
	"github.com/ivanjoz/public-business-data/updater/manifest"
	"github.com/ivanjoz/public-business-data/updater/publish"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

// sourceSnapshot mirrors data/tipo-cambio-sunat-usd-pen.json — only the fields the encoder needs.
type sourceSnapshot struct {
	Registros []struct {
		Fecha  string  `json:"fecha"`
		Compra float64 `json:"compra"`
		Venta  float64 `json:"venta"`
	} `json:"registros"`
}

// bcrpYearPause spaces the per-year requests. The BCRP is behind Incapsula and a backfill is the
// only thing here that makes more than one call in a row; a run of six years takes half a minute
// and never sees a challenge, which is cheaper than retrying through one.
const bcrpYearPause = 5 * time.Second

func main() {
	dataset := flag.String("dataset", "sunat", "sunat (desde el snapshot JSON) o bcrp (desde la API)")
	sourcePath := flag.String("source", "../data/tipo-cambio-sunat-usd-pen.json", "JSON snapshot to read, sólo para sunat")
	outDir := flag.String("out", "../docs", "published folder to write")
	from := flag.String("from", "2021-01-01", "primer día a pedir, sólo para bcrp")
	to := flag.String("to", "", "último día a pedir, sólo para bcrp; vacío = hoy")
	flag.Parse()

	var key string
	var ratesByYear map[string][]binfmt.Rate
	var provisional []int16
	var err error

	switch *dataset {
	case "sunat":
		key = manifest.ExchangeRateSunat
		ratesByYear, err = readSnapshot(*sourcePath)
	case "bcrp":
		key = manifest.ExchangeRateBCRP
		ratesByYear, provisional, err = fetchBCRPHistory(*from, *to)
	default:
		log.Fatalf("dataset desconocido: %q (sunat o bcrp)", *dataset)
	}
	if err != nil {
		log.Fatal(err)
	}
	if len(ratesByYear) == 0 {
		log.Fatal("no se obtuvo ningún día: no hay nada que escribir")
	}

	if err := write(key, ratesByYear, provisional, *outDir); err != nil {
		log.Fatal(err)
	}
}

// readSnapshot turns the committed JSON into the years it covers.
func readSnapshot(path string) (map[string][]binfmt.Rate, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no se pudo leer el snapshot: %w", err)
	}

	var snapshot sourceSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, fmt.Errorf("snapshot inválido: %w", err)
	}

	ratesByYear := map[string][]binfmt.Rate{}
	for _, record := range snapshot.Registros {
		date, err := time.Parse(time.DateOnly, record.Fecha)
		if err != nil {
			return nil, fmt.Errorf("fecha inválida %q: %w", record.Fecha, err)
		}
		year := date.Format("2006")
		ratesByYear[year] = append(ratesByYear[year], binfmt.Rate{
			UnixDay: binfmt.UnixDayOf(date),
			// Rounding, not truncation: 3.7129 published as 3713 is the value SUNAT shows.
			Buy:  int32(record.Compra*binfmt.Scale + 0.5),
			Sell: int32(record.Venta*binfmt.Scale + 0.5),
		})
	}
	return ratesByYear, nil
}

// fetchBCRPHistory asks the API one calendar year at a time. One request for the whole history
// would work too, but a year is the unit that gets written, so a failure halfway through costs
// one year's request and not all of them.
func fetchBCRPHistory(fromText, toText string) (map[string][]binfmt.Rate, []int16, error) {
	from, err := time.Parse(time.DateOnly, fromText)
	if err != nil {
		return nil, nil, fmt.Errorf("-from inválido: %w", err)
	}
	to := time.Now().UTC()
	if toText != "" {
		if to, err = time.Parse(time.DateOnly, toText); err != nil {
			return nil, nil, fmt.Errorf("-to inválido: %w", err)
		}
	}
	if to.Before(from) {
		return nil, nil, fmt.Errorf("-to (%s) es anterior a -from (%s)", to.Format(time.DateOnly), fromText)
	}

	ctx := context.Background()
	client := &http.Client{Timeout: 60 * time.Second}
	ratesByYear := map[string][]binfmt.Rate{}
	var confirmed []sources.DailyRate

	for year := from.Year(); year <= to.Year(); year++ {
		windowStart := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC)
		if windowStart.Before(from) {
			windowStart = from
		}
		windowEnd := time.Date(year, time.December, 31, 0, 0, 0, 0, time.UTC)
		if windowEnd.After(to) {
			windowEnd = to
		}

		if year > from.Year() {
			time.Sleep(bcrpYearPause)
		}
		days, err := sources.FetchBCRP(ctx, client, windowStart, windowEnd)
		if err != nil {
			return nil, nil, fmt.Errorf("BCRP %d: %w", year, err)
		}

		yearKey := fmt.Sprintf("%d", year)
		for _, day := range days {
			ratesByYear[yearKey] = append(ratesByYear[yearKey], binfmt.Rate{
				UnixDay: binfmt.UnixDayOf(day.Date),
				Buy:     day.Buy,
				Sell:    day.Sell,
			})
		}
		confirmed = append(confirmed, days...)
		fmt.Printf("BCRP %d: %d días\n", year, len(days))
	}

	// The same fill the lambda applies, so a locally seeded docs/ is byte-for-byte what the next
	// published run would produce instead of differing in the last days of the series.
	fill := fillProvisional(ctx, client, confirmed, to)
	days := make([]int16, 0, len(fill))
	for _, day := range fill {
		unixDay := binfmt.UnixDayOf(day.Date)
		yearKey := day.Date.Format("2006")
		ratesByYear[yearKey] = append(ratesByYear[yearKey], binfmt.Rate{
			UnixDay: unixDay,
			Buy:     day.Buy,
			Sell:    day.Sell,
		})
		days = append(days, unixDay)
	}
	return ratesByYear, days, nil
}

// fillProvisional covers the last weekdays the BCRP has not published, exactly as the updater
// does. Failures are skipped: a day that cannot be filled is a day the series does not have yet.
func fillProvisional(ctx context.Context, client *http.Client, confirmed []sources.DailyRate,
	now time.Time) []sources.DailyRate {
	missing := publish.MissingWeekdays(confirmed, now, publish.ProvisionalWindow)
	if len(missing) == 0 {
		return nil
	}
	spread := publish.MedianSpread(confirmed)

	fill := make([]sources.DailyRate, 0, len(missing))
	for _, day := range missing {
		mid, err := sources.FetchProvisionalMid(ctx, client, day)
		if err != nil {
			fmt.Printf("provisional %s: sin dato (%v)\n", day.Format(time.DateOnly), err)
			continue
		}
		buy, sell := publish.WithSpread(mid, spread)
		fill = append(fill, sources.DailyRate{Date: day, Buy: buy, Sell: sell})
		fmt.Printf("provisional %s: %d/%d (referencia)\n", day.Format(time.DateOnly), buy, sell)
	}
	return fill
}

// write encodes every year, then folds the dataset into whatever manifest is already in outDir.
// Merging instead of replacing is what makes seeding a second dataset safe: writing a fresh
// manifest would drop the first one's years while leaving its .gz files orphaned on disk.
func write(key string, ratesByYear map[string][]binfmt.Rate, provisional []int16, outDir string) error {
	if !manifest.Known(key) {
		return fmt.Errorf("dataset desconocido: %q", key)
	}
	years := map[string]manifest.File{}

	for year, rates := range ratesByYear {
		payload, err := binfmt.Encode(rates)
		if err != nil {
			return fmt.Errorf("año %s: %w", year, err)
		}
		compressed, err := binfmt.Gzip(payload)
		if err != nil {
			return fmt.Errorf("año %s: %w", year, err)
		}

		entry := manifest.Describe(rates, payload)
		publishedPath := manifest.FilePath(key, year)
		filePath := filepath.Join(outDir, filepath.FromSlash(publishedPath))
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return fmt.Errorf("año %s: %w", year, err)
		}
		if err := os.WriteFile(filePath, compressed, 0o644); err != nil {
			return fmt.Errorf("año %s: %w", year, err)
		}
		years[year] = entry

		fmt.Printf("%s  %4d días  %5d B → %5d B gz  fnv=%s  hasta %s\n",
			publishedPath, entry.Records, len(payload), len(compressed),
			entry.Hash, binfmt.DateOf(entry.LastDay).Format(time.DateOnly))
	}

	manifestPath := filepath.Join(outDir, "manifest.json")
	published := manifest.Empty()
	if raw, err := os.ReadFile(manifestPath); err == nil {
		if published, err = manifest.Unmarshal(raw); err != nil {
			return fmt.Errorf("%s existente es ilegible: %w", manifestPath, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	published.Version = manifest.Version
	published.Generated = time.Now().Unix()
	published.Datasets[key] = years
	published.SetProvisional(key, provisional)

	rendered, err := manifest.Marshal(published)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	if err := os.WriteFile(manifestPath, rendered, 0o644); err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	fmt.Printf("manifest.json: %s con %d años, %d datasets en total\n", key, len(years), len(published.Datasets))
	return nil
}
