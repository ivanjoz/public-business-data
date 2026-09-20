// Package manifest is the master hash file published at docs/manifest.json. It is the only
// thing the lambda has to read to answer "did anything change?", and the only thing a client
// has to read to know which year files it already has cached.
package manifest

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
)

// Path is where the manifest lives inside the published folder.
const Path = "docs/manifest.json"

// Site is where the published folder is served from — the base the lambda reads the current
// files from. It is not a manifest field: a client that just fetched the manifest already knows
// the origin it came from.
const Site = "https://public-business-data.un.pe"

// ExchangeRateSunat is the dataset key and the folder holding its year files.
const ExchangeRateSunat = "sunat-usd-pen"

// File is one published year, keyed by the year itself — which is also its filename, so the
// path is {datasetKey}/{year}.gz and is never stored. Hash is over the uncompressed payload
// (see binfmt.Hash), so it stays comparable no matter which compressor wrote the .gz, and it is
// the only field the lambda and the client actually need. Records and LastDate are the two
// questions a human or a `latest()` asks without downloading the file; everything else that
// used to live here — path, byte sizes, the first day — was derivable from these or from the key.
type File struct {
	Hash     string `json:"hash"`
	Records  int    `json:"records"`
	LastDate string `json:"lastDate"`
}

// Dataset describes one published series well enough that a consumer can decode it without
// reading any code: the record layout and the fixed-point scale are part of the contract.
type Dataset struct {
	Title     string          `json:"title"`
	Source    string          `json:"source"`
	SourceURL string          `json:"sourceUrl"`
	Unit      string          `json:"unit"`
	Record    string          `json:"record"`
	Scale     int             `json:"scale"`
	HashAlgo  string          `json:"hashAlgo"`
	Files     map[string]File `json:"files"`
}

// Manifest is the whole file. Generated is a unix timestamp: it moves on every publish, which
// is why it can never be part of what the lambda hashes.
type Manifest struct {
	Version   int                `json:"version"`
	Generated int64              `json:"generated"`
	Datasets  map[string]Dataset `json:"datasets"`
}

// NewExchangeRateDataset is the fixed description of the SUNAT series. Only Files changes
// between publishes.
func NewExchangeRateDataset() Dataset {
	return Dataset{
		Title:     "Tipo de cambio oficial SUNAT — dólar estadounidense (compra y venta)",
		Source:    "SUNAT — Superintendencia Nacional de Aduanas y de Administración Tributaria (Perú)",
		SourceURL: "https://www.sunat.gob.pe/a/txt/tipoCambio.txt",
		Unit:      "PEN por 1 USD",
		// One prose line instead of a record/recordSize/endianness trio: nothing parses this,
		// it is here so a human who curls the manifest can write a decoder.
		Record:   fmt.Sprintf("unixDay:int16, buy:int32, sell:int32 — little endian, %d bytes", binfmt.RecordSize),
		Scale:    binfmt.Scale,
		HashAlgo: "fnv-1a-64",
		Files:    map[string]File{},
	}
}

// FilePath is where a year of a dataset is published. The manifest does not store it because
// the dataset key is the folder and the entry key is the filename.
func FilePath(datasetKey, year string) string {
	return fmt.Sprintf("%s/%s.gz", datasetKey, year)
}

// Describe turns an encoded year into its manifest entry.
func Describe(rates []binfmt.Rate, payload []byte) File {
	sort.Slice(rates, func(a, b int) bool { return rates[a].UnixDay < rates[b].UnixDay })
	entry := File{Hash: binfmt.Hash(payload), Records: len(rates)}
	if len(rates) > 0 {
		entry.LastDate = binfmt.DateOf(rates[len(rates)-1].UnixDay).Format("2006-01-02")
	}
	return entry
}

// Marshal renders the manifest the way it is committed: indented, so a diff is readable and a
// review can see which year changed.
func Marshal(m Manifest) ([]byte, error) {
	rendered, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(rendered, '\n'), nil
}

// Unmarshal reads the published manifest back.
func Unmarshal(raw []byte) (Manifest, error) {
	var m Manifest
	err := json.Unmarshal(raw, &m)
	return m, err
}
