// Command backfill seeds docs/ from the JSON snapshot in data/. It exists for the first
// publish and for a rebuild after a format change; day-to-day the lambda keeps the files
// current. It goes through the same binfmt encoder the lambda uses, so a rebuild can never
// produce bytes the lambda would then "fix" on its next run.
//
//	go run ./cmd/backfill -source ../data/tipo-cambio-sunat-usd-pen.json -out ../docs
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
	"github.com/ivanjoz/public-business-data/updater/manifest"
)

// sourceSnapshot mirrors data/tipo-cambio-sunat-usd-pen.json — only the fields the encoder needs.
type sourceSnapshot struct {
	Registros []struct {
		Fecha  string  `json:"fecha"`
		Compra float64 `json:"compra"`
		Venta  float64 `json:"venta"`
	} `json:"registros"`
}

func main() {
	sourcePath := flag.String("source", "../data/tipo-cambio-sunat-usd-pen.json", "JSON snapshot to read")
	outDir := flag.String("out", "../docs", "published folder to write")
	flag.Parse()

	raw, err := os.ReadFile(*sourcePath)
	if err != nil {
		log.Fatalf("no se pudo leer el snapshot: %v", err)
	}

	var snapshot sourceSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		log.Fatalf("snapshot inválido: %v", err)
	}

	ratesByYear := map[string][]binfmt.Rate{}
	for _, record := range snapshot.Registros {
		date, err := time.Parse(time.DateOnly, record.Fecha)
		if err != nil {
			log.Fatalf("fecha inválida %q: %v", record.Fecha, err)
		}
		year := date.Format("2006")
		ratesByYear[year] = append(ratesByYear[year], binfmt.Rate{
			UnixDay: binfmt.UnixDayOf(date),
			// Rounding, not truncation: 3.7129 published as 3713 is the value SUNAT shows.
			Buy:  int32(record.Compra*binfmt.Scale + 0.5),
			Sell: int32(record.Venta*binfmt.Scale + 0.5),
		})
	}

	dataset := manifest.NewExchangeRateDataset()
	for year, rates := range ratesByYear {
		payload, err := binfmt.Encode(rates)
		if err != nil {
			log.Fatalf("año %s: %v", year, err)
		}
		compressed, err := binfmt.Gzip(payload)
		if err != nil {
			log.Fatalf("año %s: %v", year, err)
		}

		entry := manifest.Describe(rates, payload)
		publishedPath := manifest.FilePath(manifest.ExchangeRateSunat, year)
		filePath := filepath.Join(*outDir, filepath.FromSlash(publishedPath))
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			log.Fatalf("año %s: %v", year, err)
		}
		if err := os.WriteFile(filePath, compressed, 0o644); err != nil {
			log.Fatalf("año %s: %v", year, err)
		}
		dataset.Files[year] = entry

		fmt.Printf("%s  %4d días  %5d B → %5d B gz  fnv=%s  hasta %s\n",
			publishedPath, entry.Records, len(payload), len(compressed), entry.Hash, entry.LastDate)
	}

	published := manifest.Manifest{
		Version:   1,
		Generated: time.Now().Unix(),
		Datasets:  map[string]manifest.Dataset{manifest.ExchangeRateSunat: dataset},
	}
	rendered, err := manifest.Marshal(published)
	if err != nil {
		log.Fatalf("manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "manifest.json"), rendered, 0o644); err != nil {
		log.Fatalf("manifest: %v", err)
	}
	fmt.Printf("manifest.json escrito con %d años\n", len(dataset.Files))
}
