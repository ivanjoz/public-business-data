// Package binfmt is the on-disk format of every published dataset: the packing, the gzip
// envelope and the FNV hash the updater compares to decide whether a commit is needed.
// It is the single encoder — the backfill and the lambda both go through it, so a published
// file can never disagree with the one the lambda would have produced.
package binfmt

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"io"
	"sort"
	"time"
)

// RecordSize is what one published day occupies: int16 day + int32 buy + int32 sell.
// Deliberately unaligned — the reader is a DataView on the JS side and encoding/binary here,
// and both handle it, so padding would only waste 20% of every file.
const RecordSize = 10

// Scale is the fixed-point factor every published rate carries: 3.354 travels as 3354.
// Same scale the genix frontend already stores rates with, so a value crosses with no conversion.
const Scale = 1000

// unixDayEpoch is 1970-01-01 in UTC, the origin of the day counter stored in each record.
var unixDayEpoch = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)

// MaxUnixDay is the last day an int16 counter can hold (2059-09-18). Encoding refuses anything
// past it instead of silently wrapping into a negative day.
const MaxUnixDay = 32767

// Rate is one published day. UnixDay is days since the unix epoch; Buy and Sell are already
// scaled by Scale, because that is how they are stored and how the consumers want them.
type Rate struct {
	UnixDay int16
	Buy     int32
	Sell    int32
}

// UnixDayOf converts a calendar date to the stored day counter.
func UnixDayOf(date time.Time) int16 {
	return int16(date.UTC().Truncate(24*time.Hour).Sub(unixDayEpoch).Hours() / 24)
}

// DateOf is the inverse of UnixDayOf.
func DateOf(unixDay int16) time.Time {
	return unixDayEpoch.AddDate(0, 0, int(unixDay))
}

// Encode packs the rates into the published payload: little endian, sorted ascending by day,
// one record per day. The order is part of the format — the TypeScript client binary-searches
// the buffer instead of building a map, so an unsorted file would silently answer wrong.
func Encode(rates []Rate) ([]byte, error) {
	sorted := make([]Rate, len(rates))
	copy(sorted, rates)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a].UnixDay < sorted[b].UnixDay })

	payload := make([]byte, 0, len(sorted)*RecordSize)
	previousDay := int16(-1)

	for _, rate := range sorted {
		if rate.UnixDay <= previousDay {
			return nil, fmt.Errorf("día duplicado en el dataset: %d (%s)", rate.UnixDay, DateOf(rate.UnixDay).Format(time.DateOnly))
		}
		if rate.Buy <= 0 || rate.Sell <= 0 {
			return nil, fmt.Errorf("día %s con una cotización no publicable: compra=%d venta=%d", DateOf(rate.UnixDay).Format(time.DateOnly), rate.Buy, rate.Sell)
		}
		previousDay = rate.UnixDay

		payload = binary.LittleEndian.AppendUint16(payload, uint16(rate.UnixDay))
		payload = binary.LittleEndian.AppendUint32(payload, uint32(rate.Buy))
		payload = binary.LittleEndian.AppendUint32(payload, uint32(rate.Sell))
	}
	return payload, nil
}

// Decode reads back a payload produced by Encode. The lambda uses it to load the year it is
// about to update, so the merge happens against exactly what is published.
func Decode(payload []byte) ([]Rate, error) {
	if len(payload)%RecordSize != 0 {
		return nil, fmt.Errorf("payload de %d bytes: no es múltiplo de %d", len(payload), RecordSize)
	}

	rates := make([]Rate, 0, len(payload)/RecordSize)
	for offset := 0; offset < len(payload); offset += RecordSize {
		rates = append(rates, Rate{
			UnixDay: int16(binary.LittleEndian.Uint16(payload[offset:])),
			Buy:     int32(binary.LittleEndian.Uint32(payload[offset+2:])),
			Sell:    int32(binary.LittleEndian.Uint32(payload[offset+6:])),
		})
	}
	return rates, nil
}

// Hash is the fingerprint the manifest stores and the lambda compares. It is taken over the
// uncompressed payload on purpose: gzip bytes depend on the compressor, so hashing them would
// make the "did the data change?" question answerable only by the exact same Go version.
func Hash(payload []byte) string {
	hasher := fnv.New64a()
	hasher.Write(payload)
	return fmt.Sprintf("%016x", hasher.Sum64())
}

// Gzip wraps the payload as it is published. Name and ModTime are cleared so the same data
// always produces the same bytes and an unchanged year never shows up as a diff.
func Gzip(payload []byte) ([]byte, error) {
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	writer.Header.ModTime = time.Time{}
	if _, err := writer.Write(payload); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return compressed.Bytes(), nil
}

// Gunzip reads a published file back into its payload.
func Gunzip(compressed []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}
