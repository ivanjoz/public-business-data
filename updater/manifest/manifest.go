// Package manifest is the master index published at docs/manifest.json. It is the only thing the
// lambda has to read to answer "did anything change?", and the only thing a client has to read to
// know which year files it already has cached.
//
// It is an index and not a document. Everything that described a series in prose — title, source,
// unit, record layout, scale — was the same bytes on every publish, re-downloaded by every visitor
// forever, to say something that only changes when the code changes. That description now lives in
// the client, and what travels here is what actually moves: a hash, a count and a last day per
// year. The keys are one letter for the same reason.
package manifest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
)

// Path is where the manifest lives inside the published folder.
const Path = "docs/manifest.json"

// Version is the shape of the file. 2 dropped the prose and shortened the per-year keys; a reader
// that finds a version it does not know must say so instead of silently reading nothing.
const Version = 2

// Site is where the published folder is served from — the base the lambda reads the current
// files from. It is not a manifest field: a client that just fetched the manifest already knows
// the origin it came from.
const Site = "https://public-business-data.un.pe"

// The dataset keys, which are also the folders holding each one's year files. The key names the
// publisher and not just the pair, because the two series answer different questions: SUNAT's is
// the accounting rate the tax code points at, the BCRP's is what the market actually traded at.
const (
	ExchangeRateSunat = "sunat-usd-pen"
	ExchangeRateBCRP  = "bcrp-interbancario-usd-pen"
)

// Known reports whether a key is a dataset this publisher knows how to write. It is the guard
// that stops a typo from creating a folder nobody reads.
func Known(key string) bool {
	return key == ExchangeRateSunat || key == ExchangeRateBCRP
}

// File is one published year, keyed by the year itself — which is also its filename, so the path
// is {datasetKey}/{year}.gz and is never stored.
//
//	h  hash of the uncompressed payload (see binfmt.Hash), so it stays comparable no matter which
//	   compressor wrote the .gz. It is the only field the lambda strictly needs.
//	r  records, the day count.
//	d  the last day, as the same unixDay the records carry — not an ISO string. The client already
//	   converts unixDays in every record it decodes, so a date here would be the only place in the
//	   format that needs a different parser.
type File struct {
	Hash    string `json:"h"`
	Records int    `json:"r"`
	LastDay int16  `json:"d"`
}

// Manifest is the whole file: an index of years by dataset, plus the provisional flag.
//
// Generated is a unix timestamp and moves on every publish, which is why it can never be part of
// what the lambda hashes.
type Manifest struct {
	Version   int                        `json:"version"`
	Generated int64                      `json:"generated"`
	Datasets  map[string]map[string]File `json:"datasets"`
	// Provisional lists, per dataset, the days that did not come from its own source — as
	// unixDays, same as everywhere else. Omitted when there are none, which is the normal state
	// once the real source has caught up. It is a section of its own rather than a field inside
	// each dataset so that a dataset entry stays exactly "years to files" and nothing else.
	Provisional map[string][]int16 `json:"provisional,omitempty"`
}

// Empty is a manifest with nothing published yet — the starting point for the first run, and for
// a run that finds a version it cannot read.
func Empty() Manifest {
	return Manifest{Version: Version, Datasets: map[string]map[string]File{}}
}

// Years is the index of one dataset, or an empty one when it has never been published.
func (m Manifest) Years(datasetKey string) map[string]File {
	if years, published := m.Datasets[datasetKey]; published {
		return years
	}
	return map[string]File{}
}

// ProvisionalDays reads the flag back as a set, tolerating a dataset that has none.
func (m Manifest) ProvisionalDays(datasetKey string) map[int16]bool {
	days := map[int16]bool{}
	for _, day := range m.Provisional[datasetKey] {
		days[day] = true
	}
	return days
}

// SetProvisional records the flag for one dataset, dropping the entry — and the whole section
// when it was the last one — as soon as there is nothing to flag.
func (m *Manifest) SetProvisional(datasetKey string, days []int16) {
	if len(days) == 0 {
		delete(m.Provisional, datasetKey)
		if len(m.Provisional) == 0 {
			m.Provisional = nil
		}
		return
	}
	if m.Provisional == nil {
		m.Provisional = map[string][]int16{}
	}
	sorted := append([]int16(nil), days...)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })
	m.Provisional[datasetKey] = sorted
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
		entry.LastDay = rates[len(rates)-1].UnixDay
	}
	return entry
}

// Marshal renders the manifest as it is committed: one line per year.
//
// Not json.MarshalIndent, which would spend five lines on each year, and not a single compact line
// either — this file is committed on every publish, and a diff that points at the one year that
// moved is worth the few bytes the newlines cost.
func Marshal(m Manifest) ([]byte, error) {
	var out bytes.Buffer
	fmt.Fprintf(&out, "{\n  \"version\": %d,\n  \"generated\": %d,\n  \"datasets\": {", m.Version, m.Generated)

	for index, datasetKey := range sortedKeys(m.Datasets) {
		if index > 0 {
			out.WriteByte(',')
		}
		out.WriteString("\n    ")
		if err := writeKey(&out, datasetKey); err != nil {
			return nil, err
		}
		out.WriteString(": {")

		years := m.Datasets[datasetKey]
		for yearIndex, year := range sortedKeys(years) {
			if yearIndex > 0 {
				out.WriteByte(',')
			}
			out.WriteString("\n      ")
			if err := writeKey(&out, year); err != nil {
				return nil, err
			}
			out.WriteString(": ")
			// The entry itself goes through encoding/json: hand-writing the values would be the
			// one place in here where a quote or a stray byte could produce invalid JSON.
			entry, err := json.Marshal(years[year])
			if err != nil {
				return nil, err
			}
			out.Write(entry)
		}
		out.WriteString("\n    }")
	}
	out.WriteString("\n  }")

	if len(m.Provisional) > 0 {
		out.WriteString(",\n  \"provisional\": {")
		for index, datasetKey := range sortedKeys(m.Provisional) {
			if index > 0 {
				out.WriteByte(',')
			}
			out.WriteString("\n    ")
			if err := writeKey(&out, datasetKey); err != nil {
				return nil, err
			}
			out.WriteString(": ")
			days, err := json.Marshal(m.Provisional[datasetKey])
			if err != nil {
				return nil, err
			}
			out.Write(days)
		}
		out.WriteString("\n  }")
	}

	out.WriteString("\n}\n")
	return out.Bytes(), nil
}

// Unmarshal reads a published manifest.
//
// A version that is not this one stops the read, in both directions. Newer is obvious: a binary
// that cannot read what is published must not overwrite it. Older matters just as much, and less
// obviously — reading it as an empty index would look harmless, because the years get recomputed
// anyway, but any dataset *not* being written in that same run would silently vanish from the
// index while its files stayed on disk. Upgrading the format is a re-seed, not a guess.
func Unmarshal(raw []byte) (Manifest, error) {
	var m Manifest

	// The version is read on its own first, because every other shape changed with it: decoding
	// the whole file would fail on a v1 dataset entry — "cannot unmarshal string into File" — and
	// bury the one thing the operator needs to be told.
	var probe struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return m, err
	}
	if probe.Version != Version {
		return m, fmt.Errorf("el manifest publicado es versión %d y esta build escribe la %d: "+
			"borra docs/manifest.json y vuelve a sembrar todos los datasets con cmd/backfill",
			probe.Version, Version)
	}

	if err := json.Unmarshal(raw, &m); err != nil {
		return m, err
	}
	if m.Datasets == nil {
		m.Datasets = map[string]map[string]File{}
	}
	return m, nil
}

func sortedKeys[V any](entries map[string]V) []string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// writeKey emits an object key through encoding/json so escaping is never this file's problem.
func writeKey(out *bytes.Buffer, key string) error {
	encoded, err := json.Marshal(key)
	if err != nil {
		return err
	}
	out.Write(encoded)
	return nil
}
