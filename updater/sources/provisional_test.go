package sources

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// provisionalFrom runs FetchProvisionalMid against a server that answers with the given status
// and body, for the date 2026-09-18.
func provisionalFrom(t *testing.T, status int, body string) (int32, error) {
	t.Helper()

	previous := retryBaseDelay
	retryBaseDelay = time.Millisecond
	t.Cleanup(func() { retryBaseDelay = previous })

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		attempts++
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(body))
	}))
	t.Cleanup(func() {
		server.Close()
		// A 404 is an answer, not a failure: retrying it three more times would only make every
		// unfilled day cost four requests and half a minute of backoff.
		if status == http.StatusNotFound && attempts != 1 {
			t.Errorf("un 404 se reintentó %d veces", attempts)
		}
	})

	client := &http.Client{Transport: &redirectTo{host: server.Listener.Addr().String()}}
	date := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	return FetchProvisionalMid(context.Background(), client, date)
}

func TestProvisionalMidScalesTheReferenceRate(t *testing.T) {
	mid, err := provisionalFrom(t, http.StatusOK, `{"date":"2026-09-18","usd":{"pen":3.37553637,"eur":0.85}}`)
	if err != nil {
		t.Fatal(err)
	}
	// 3.37553… a milésimas son 3376, redondeando y no truncando.
	if mid != 3376 {
		t.Fatalf("escala o redondeo inesperados: %d", mid)
	}
}

func TestProvisionalMidTreatsANotFoundAsNoData(t *testing.T) {
	_, err := provisionalFrom(t, http.StatusNotFound, "Couldn't find the requested release version")
	if !errors.Is(err, ErrNotPublished) {
		t.Fatalf("un 404 debía ser ErrNotPublished y no un fallo: %v", err)
	}
}

// La URL lleva la fecha, así que un payload fechado en otro día significa que el CDN resolvió la
// etiqueta a otra cosa — normalmente `latest`. Publicar la cotización de hoy bajo un día anterior
// sería invisible en el dato y erróneo en todos los consumidores.
func TestProvisionalMidRejectsADateItDidNotAskFor(t *testing.T) {
	_, err := provisionalFrom(t, http.StatusOK, `{"date":"2026-09-20","usd":{"pen":3.37}}`)
	if err == nil {
		t.Fatal("una fecha distinta a la pedida debía ser un error")
	}
	if errors.Is(err, ErrNotPublished) {
		t.Fatal("una fecha cambiada no es 'no hay dato': es una respuesta que no se puede usar")
	}
}

func TestProvisionalMidRejectsAMissingPen(t *testing.T) {
	if _, err := provisionalFrom(t, http.StatusOK, `{"date":"2026-09-18","usd":{"eur":0.85}}`); err == nil {
		t.Fatal("una respuesta sin PEN debía ser un error")
	}
	if _, err := provisionalFrom(t, http.StatusOK, `{"date":"2026-09-18","usd":{"pen":0}}`); err == nil {
		t.Fatal("una cotización en cero debía ser un error")
	}
}
