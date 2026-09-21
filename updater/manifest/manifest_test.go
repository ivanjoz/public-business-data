package manifest

import (
	"encoding/json"
	"strings"
	"testing"
)

func sample() Manifest {
	return Manifest{
		Version:   Version,
		Generated: 1789948537,
		Datasets: map[string]map[string]File{
			ExchangeRateSunat: {
				"2025": {Hash: "843d4f53f5904c4c", Records: 365, LastDay: 20453},
				"2026": {Hash: "7da90ae37e84eae0", Records: 264, LastDay: 20717},
			},
			ExchangeRateBCRP: {
				"2026": {Hash: "4c984be6f7415b22", Records: 176, LastDay: 20714},
			},
		},
		Provisional: map[string][]int16{ExchangeRateBCRP: {20714}},
	}
}

func TestMarshalPutsOneYearPerLine(t *testing.T) {
	rendered, err := Marshal(sample())
	if err != nil {
		t.Fatal(err)
	}
	text := string(rendered)

	// Un año por línea es lo que hace legible el diff de cada publicación: json.MarshalIndent
	// gastaría cinco líneas por año y una sola línea compacta no diría cuál se movió.
	if !strings.Contains(text, `"2026": {"h":"7da90ae37e84eae0","r":264,"d":20717}`) {
		t.Fatalf("el año no salió compacto en una línea:\n%s", text)
	}
	if !strings.Contains(text, `"provisional": {`) || !strings.Contains(text, `[20714]`) {
		t.Fatalf("la sección provisional no salió como se espera:\n%s", text)
	}
	if strings.HasSuffix(text, "}") {
		t.Fatal("el archivo debía acabar en salto de línea")
	}

	// Y sigue siendo JSON válido, que es lo que arriesga escribirlo a mano.
	var parsed map[string]any
	if err := json.Unmarshal(rendered, &parsed); err != nil {
		t.Fatalf("el manifest renderizado no es JSON válido: %v", err)
	}
}

func TestMarshalIsStableAndRoundTrips(t *testing.T) {
	first, err := Marshal(sample())
	if err != nil {
		t.Fatal(err)
	}
	second, err := Marshal(sample())
	if err != nil {
		t.Fatal(err)
	}
	// Las claves salen ordenadas: si el orden siguiera al mapa, cada publicación sería un diff
	// completo y la comparación de índice del publicador daría siempre "cambió".
	if string(first) != string(second) {
		t.Fatal("dos renderizados del mismo manifest no coinciden")
	}

	back, err := Unmarshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if back.Years(ExchangeRateSunat)["2026"].LastDay != 20717 {
		t.Fatalf("el round-trip perdió el último día: %+v", back.Years(ExchangeRateSunat)["2026"])
	}
	if !back.ProvisionalDays(ExchangeRateBCRP)[20714] {
		t.Fatal("el round-trip perdió el flag")
	}
	if len(back.ProvisionalDays(ExchangeRateSunat)) != 0 {
		t.Fatal("el flag se filtró al dataset que no lo tenía")
	}
}

func TestProvisionalSectionDisappearsWhenEmpty(t *testing.T) {
	m := sample()
	m.SetProvisional(ExchangeRateBCRP, nil)

	rendered, err := Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rendered), "provisional") {
		t.Fatalf("la sección debía desaparecer al quedarse vacía:\n%s", rendered)
	}
}

// Leer una versión que no es la de esta build tiene que parar, en las dos direcciones. Más nueva
// es evidente. Más vieja importa igual: leerla como índice vacío parecería inofensivo —los años se
// recalculan— pero cualquier dataset que no se estuviera escribiendo en esa misma corrida
// desaparecería del índice con sus archivos intactos en disco.
func TestAnotherVersionIsAnError(t *testing.T) {
	for _, version := range []int{1, Version + 1} {
		raw := []byte(`{"version":` + itoa(version) + `,"generated":1,"datasets":{}}`)
		if _, err := Unmarshal(raw); err == nil {
			t.Fatalf("la versión %d debía ser un error", version)
		}
	}
}

// Un v1 de verdad, con la prosa y el año anidado bajo "files". Lo que se comprueba no es que falle
// —eso ya está arriba— sino *cómo*: sin mirar la versión primero, encoding/json se queja de que no
// puede meter un string en un manifest.File y el operador nunca se entera de que lo que pasa es
// que el formato cambió.
func TestAV1ManifestSaysThatTheFormatChanged(t *testing.T) {
	raw := []byte(`{"version":1,"generated":1,"datasets":{"sunat-usd-pen":{` +
		`"title":"Tipo de cambio oficial SUNAT","scale":1000,` +
		`"files":{"2026":{"hash":"abc","records":264,"lastDate":"2026-09-21"}}}}}`)

	_, err := Unmarshal(raw)
	if err == nil {
		t.Fatal("un manifest v1 tenía que ser un error")
	}
	if !strings.Contains(err.Error(), "versión 1") || !strings.Contains(err.Error(), "cmd/backfill") {
		t.Fatalf("el error no dice qué pasó ni qué hacer: %v", err)
	}
}

func itoa(value int) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
