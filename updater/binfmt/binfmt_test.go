package binfmt

import (
	"testing"
	"time"
)

func TestUnixDayRoundTrip(t *testing.T) {
	for _, date := range []string{"1970-01-01", "2021-01-01", "2026-09-20", "2059-09-18"} {
		parsed, err := time.Parse(time.DateOnly, date)
		if err != nil {
			t.Fatal(err)
		}
		unixDay := UnixDayOf(parsed)
		if unixDay < 0 {
			t.Fatalf("%s desbordó el contador int16: %d", date, unixDay)
		}
		if got := DateOf(unixDay).Format(time.DateOnly); got != date {
			t.Fatalf("%s → %d → %s", date, unixDay, got)
		}
	}
}

func TestEncodeSortsAndDecodeRestores(t *testing.T) {
	// Deliberately out of order: Encode owns the sort, because the client binary-searches.
	rates := []Rate{
		{UnixDay: 20701, Buy: 3354, Sell: 3362},
		{UnixDay: 18628, Buy: 3618, Sell: 3624},
		{UnixDay: 20700, Buy: 3350, Sell: 3358},
	}

	payload, err := Encode(rates)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) != 3*RecordSize {
		t.Fatalf("payload de %d bytes, se esperaban %d", len(payload), 3*RecordSize)
	}

	decoded, err := Decode(payload)
	if err != nil {
		t.Fatal(err)
	}
	want := []Rate{
		{UnixDay: 18628, Buy: 3618, Sell: 3624},
		{UnixDay: 20700, Buy: 3350, Sell: 3358},
		{UnixDay: 20701, Buy: 3354, Sell: 3362},
	}
	for index, rate := range want {
		if decoded[index] != rate {
			t.Fatalf("registro %d: %+v, se esperaba %+v", index, decoded[index], rate)
		}
	}
}

func TestEncodeRejectsDuplicatedDay(t *testing.T) {
	_, err := Encode([]Rate{{UnixDay: 20700, Buy: 1, Sell: 1}, {UnixDay: 20700, Buy: 2, Sell: 2}})
	if err == nil {
		t.Fatal("un día duplicado debería impedir la publicación")
	}
}

func TestGzipRoundTripIsDeterministic(t *testing.T) {
	payload, err := Encode([]Rate{{UnixDay: 20700, Buy: 3350, Sell: 3358}})
	if err != nil {
		t.Fatal(err)
	}

	first, err := Gzip(payload)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Gzip(payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("el mismo payload produjo dos .gz distintos: el archivo cambiaría sin que cambien los datos")
	}

	restored, err := Gunzip(first)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(payload) {
		t.Fatal("el round trip de gzip no devolvió el payload original")
	}
}

func TestHashChangesWithTheData(t *testing.T) {
	base, _ := Encode([]Rate{{UnixDay: 20700, Buy: 3350, Sell: 3358}})
	same, _ := Encode([]Rate{{UnixDay: 20700, Buy: 3350, Sell: 3358}})
	moved, _ := Encode([]Rate{{UnixDay: 20700, Buy: 3351, Sell: 3358}})

	if Hash(base) != Hash(same) {
		t.Fatal("el mismo dato dio dos hashes: la lambda commitearía en cada corrida")
	}
	if Hash(base) == Hash(moved) {
		t.Fatal("un cambio de cotización no movió el hash: la lambda no publicaría")
	}
}
