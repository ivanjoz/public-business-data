package sources

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// redirectTo sends every request to the test server, whatever host the URL names. It is how the
// production URL — quirks and all — stays the one under test.
type redirectTo struct{ host string }

func (r *redirectTo) RoundTrip(request *http.Request) (*http.Response, error) {
	request.URL.Scheme = "http"
	request.URL.Host = r.host
	return http.DefaultTransport.RoundTrip(request)
}

// fetchFrom runs FetchBCRP against a server that answers the given body.
func fetchFrom(t *testing.T, body, from, to string) ([]DailyRate, error) {
	t.Helper()

	// The retry backoff is measured in seconds against a WAF; a test that exercised the real one
	// would spend half a minute asleep.
	previous := retryBaseDelay
	retryBaseDelay = time.Millisecond
	t.Cleanup(func() { retryBaseDelay = previous })

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(body))
	}))
	t.Cleanup(server.Close)

	client := &http.Client{Transport: &redirectTo{host: server.Listener.Addr().String()}}
	start, err := time.Parse(time.DateOnly, from)
	if err != nil {
		t.Fatal(err)
	}
	end, err := time.Parse(time.DateOnly, to)
	if err != nil {
		t.Fatal(err)
	}
	return FetchBCRP(context.Background(), client, start, end)
}

const twoGoodDays = `{"config":{"title":"Tipo de cambio","series":[
 {"name":"TC Interbancario - Compra","dec":"3"},{"name":"TC Interbancario - Venta","dec":"3"}]},
 "periods":[
 {"name":"03.Ago.26","values":["3.39428571428571","3.39585714285714"]},
 {"name":"06.Ago.26","values":["n.d.","n.d."]},
 {"name":"07.Ago.26","values":["3.37928571428571","3.38078571428571"]}]}`

func TestBCRPRoundsToThreeDecimalsAndSkipsMissingDays(t *testing.T) {
	rates, err := fetchFrom(t, twoGoodDays, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 2 {
		t.Fatalf("un día en n.d. debía quedarse fuera: llegaron %d días", len(rates))
	}
	// 3.39428… escalado son 3394, y 3.39585… son 3396: el BCRP declara la serie con 3 decimales
	// aunque responda el promedio ponderado con catorce.
	if rates[0].Buy != 3394 || rates[0].Sell != 3396 {
		t.Fatalf("redondeo inesperado: %+v", rates[0])
	}
	if rates[0].Date.Format(time.DateOnly) != "2026-08-03" {
		t.Fatalf("fecha inesperada: %s", rates[0].Date)
	}
	if rates[1].Date.Format(time.DateOnly) != "2026-08-07" {
		t.Fatalf("fecha inesperada: %s", rates[1].Date)
	}
}

// "Set" y no "Sep": es la abreviatura que imprime el BCRP y la razón de que el mes se lea con
// una tabla propia en vez de con un layout de time.
func TestBCRPReadsSeptemberAbbreviation(t *testing.T) {
	body := `{"periods":[{"name":"17.Set.26","values":["3.36214285714286","3.36371428571429"]}]}`
	rates, err := fetchFrom(t, body, "2026-09-01", "2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 1 || rates[0].Date.Format(time.DateOnly) != "2026-09-17" {
		t.Fatalf("no se leyó septiembre: %+v", rates)
	}
	if rates[0].Buy != 3362 || rates[0].Sell != 3364 {
		t.Fatalf("cotización inesperada: %+v", rates[0])
	}
}

// El año viene en dos dígitos, así que el siglo sale del rango pedido y no de una constante.
func TestBCRPResolvesTheCenturyFromTheWindow(t *testing.T) {
	body := `{"periods":[{"name":"04.Ene.94","values":["2.15","2.16"]}]}`
	rates, err := fetchFrom(t, body, "1994-01-01", "1994-12-31")
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 1 || rates[0].Date.Year() != 1994 {
		t.Fatalf("el siglo se resolvió mal: %+v", rates)
	}
}

// El caso que motiva todo el fetcher: la respuesta con el esqueleto de días correcto y todo en
// n.d., que es lo que devuelve la API cuando se le pide un rango en formato año-mes. No es un
// error de parseo — es una serie vacía, y quien llame tiene que poder verla como tal.
func TestBCRPAllMissingIsAnEmptySeriesAndNotAnError(t *testing.T) {
	body := `{"periods":[
	 {"name":"03.Ago.26","values":["n.d.","n.d."]},
	 {"name":"04.Ago.26","values":["n.d.","n.d."]}]}`
	rates, err := fetchFrom(t, body, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 0 {
		t.Fatalf("se esperaba una serie vacía, llegaron %d días", len(rates))
	}
}

// El challenge de Incapsula llega con status 200, así que el código de estado no basta: sin esta
// detección el error que se reporta es "respuesta inesperada" y no el bloqueo reintentable.
func TestBCRPDetectsTheWAFChallenge(t *testing.T) {
	body := `<!DOCTYPE html><html><head><script src="/_Incapsula_Resource"></script></head><body></body></html>`
	_, err := fetchFrom(t, body, "2026-08-01", "2026-08-31")
	if err == nil {
		t.Fatal("un challenge del WAF debía ser un error")
	}
	if !strings.Contains(err.Error(), "challenge") {
		t.Fatalf("el error no identifica el bloqueo: %v", err)
	}
}

func TestBCRPRejectsAPeriodOutsideTheWindow(t *testing.T) {
	// Un periodo que no cae ni en el siglo XX ni en el XXI del rango pedido sólo puede ser un
	// cambio de formato, y publicarlo en el año equivocado sería peor que fallar.
	body := `{"periods":[{"name":"04.Ene.70","values":["2.15","2.16"]}]}`
	if _, err := fetchFrom(t, body, "2026-08-01", "2026-08-31"); err == nil {
		t.Fatal("un periodo fuera del rango debía ser un error")
	}
}
