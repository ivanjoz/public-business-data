package publish

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
	"github.com/ivanjoz/public-business-data/updater/manifest"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

// bcrp is a single-dataset update for the series that carries the fill.
func bcrp(fetched, provisional []sources.DailyRate) []Update {
	return []Update{{Key: manifest.ExchangeRateBCRP, Fetched: fetched, Provisional: provisional}}
}

func TestMissingWeekdaysSkipsTheWeekend(t *testing.T) {
	// Domingo 2026-09-20: los tres últimos días hábiles son el viernes 18, el jueves 17 y el
	// miércoles 16. Ni el sábado ni el propio domingo entran — el interbancario no opera.
	sunday := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
	confirmed := []sources.DailyRate{dayOf("2026-09-16", 3364, 3366), dayOf("2026-09-17", 3362, 3364)}

	missing := MissingWeekdays(confirmed, sunday, ProvisionalWindow)
	if len(missing) != 1 {
		t.Fatalf("se esperaba sólo el viernes 18, llegaron %v", missing)
	}
	if got := missing[0].Format(time.DateOnly); got != "2026-09-18" {
		t.Fatalf("día inesperado: %s", got)
	}
}

func TestMissingWeekdaysStopsAtTheWindow(t *testing.T) {
	// Sin nada confirmado, la ventana es el único límite: tres días hábiles y ni uno más, por
	// mucho que la serie lleve semanas vacía.
	friday := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)

	missing := MissingWeekdays(nil, friday, ProvisionalWindow)
	if len(missing) != 3 {
		t.Fatalf("la ventana debía dejar 3 días, dejó %d", len(missing))
	}
	if missing[0].Format(time.DateOnly) != "2026-09-16" || missing[2].Format(time.DateOnly) != "2026-09-18" {
		t.Fatalf("la ventana no es la esperada: %v", missing)
	}
}

// La ventana se cuenta en el calendario de quien llama, no en UTC. Importa porque el cron corre
// hasta las 20:15 de Lima, que ya es el día siguiente en UTC: sin esto, las dos últimas corridas
// de cada día intentarían rellenar un día que en Lima todavía no ha pasado, y dejarían caer el
// más viejo de la ventana cinco horas antes de tiempo.
func TestMissingWeekdaysCountsInTheCallersCalendar(t *testing.T) {
	lima := time.FixedZone("-05", -5*60*60)
	// Lunes 2026-09-21, 20:15 en Lima — o sea, martes 01:15 en UTC.
	evening := time.Date(2026, 9, 21, 20, 15, 0, 0, lima)
	if evening.UTC().Day() != 22 {
		t.Fatalf("la premisa de la prueba falla: en UTC son las %s", evening.UTC())
	}

	missing := MissingWeekdays(nil, evening, ProvisionalWindow)

	// Lunes 21, viernes 18 y jueves 17. El martes 22 no existe todavía en Lima.
	got := []string{}
	for _, day := range missing {
		got = append(got, day.Format(time.DateOnly))
	}
	want := []string{"2026-09-17", "2026-09-18", "2026-09-21"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("la ventana es %v y debía ser %v", got, want)
	}
}

func TestMedianSpreadAndWithSpread(t *testing.T) {
	confirmed := []sources.DailyRate{
		dayOf("2026-09-15", 3374, 3376), // 2
		dayOf("2026-09-16", 3364, 3367), // 3
		dayOf("2026-09-17", 3362, 3364), // 2
	}
	if spread := MedianSpread(confirmed); spread != 2 {
		t.Fatalf("mediana inesperada: %d", spread)
	}

	// Impar: la milésima suelta va al lado de la venta, que es el que nunca subestima lo que paga
	// quien compra dólares.
	buy, sell := WithSpread(3370, 3)
	if buy != 3369 || sell != 3372 {
		t.Fatalf("reparto inesperado de un spread impar: %d/%d", buy, sell)
	}
	if buy, sell := WithSpread(3370, 2); buy != 3369 || sell != 3371 {
		t.Fatalf("reparto inesperado: %d/%d", buy, sell)
	}
	// Sin nada que medir no se inventa una anchura.
	if buy, sell := WithSpread(3370, MedianSpread(nil)); buy != 3370 || sell != 3370 {
		t.Fatalf("un spread desconocido debía dejar el medio a ambos lados: %d/%d", buy, sell)
	}
}

func TestProvisionalDayIsPublishedAndFlagged(t *testing.T) {
	repo := newMemoryRepo()
	fetched := []sources.DailyRate{dayOf("2026-09-17", 3362, 3364)}
	fill := []sources.DailyRate{dayOf("2026-09-18", 3374, 3376)}

	report, err := Run(context.Background(), repo, bcrp(fetched, fill), false)
	if err != nil {
		t.Fatal(err)
	}
	if got := only(t, report).ProvisionalDates; len(got) != 1 || got[0] != "2026-09-18" {
		t.Fatalf("el reporte no marcó el día provisional: %v", got)
	}

	stored := decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")
	if len(stored) != 2 {
		t.Fatalf("el día provisional no se publicó: %d días", len(stored))
	}

	published := readManifestFile(t, repo)
	flagged := published.ProvisionalDays(manifest.ExchangeRateBCRP)
	if len(flagged) != 1 || !flagged[binfmt.UnixDayOf(mustDate(t, "2026-09-18"))] {
		t.Fatalf("el flag no nombra el día: %v", published.Provisional)
	}
	// El otro dataset no tiene relleno y no puede aparecer en la sección.
	if len(published.ProvisionalDays(manifest.ExchangeRateSunat)) != 0 {
		t.Fatal("un dataset sin relleno quedó marcado")
	}
}

func mustDate(t *testing.T, date string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.DateOnly, date)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestTheRealSourceOverwritesTheProvisionalDay(t *testing.T) {
	repo := newMemoryRepo()
	fill := []sources.DailyRate{dayOf("2026-09-18", 3374, 3376)}
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2026-09-17", 3362, 3364)}, fill), false); err != nil {
		t.Fatal(err)
	}

	// El BCRP publica el 18 con su propio valor: gana, y el flag desaparece.
	confirmed := []sources.DailyRate{dayOf("2026-09-17", 3362, 3364), dayOf("2026-09-18", 3369, 3371)}
	report, err := Run(context.Background(), repo, bcrp(confirmed, nil), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ProvisionalDates) != 0 {
		t.Fatalf("el día siguió marcado tras confirmarse: %v", only(t, report).ProvisionalDates)
	}

	stored := decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")
	if len(stored) != 2 {
		t.Fatalf("se perdió o se duplicó un día: %d", len(stored))
	}
	if stored[1].Buy != 3369 || stored[1].Sell != 3371 {
		t.Fatalf("el valor provisional sobrevivió al real: %+v", stored[1])
	}
	if readManifestFile(t, repo).Provisional != nil {
		t.Fatal("el manifest siguió declarando días provisionales que ya no existen")
	}
}

// La regla de caducidad, que es lo que impide contaminar la serie: un feriado peruano en el que el
// mercado global sí operó se rellena, el BCRP no lo confirma nunca, y al salir de la ventana el
// día tiene que desaparecer en vez de quedarse para siempre.
func TestAnUnconfirmedProvisionalDayIsDroppedWhenItAgesOut(t *testing.T) {
	repo := newMemoryRepo()
	fill := []sources.DailyRate{dayOf("2026-07-28", 3400, 3402)}
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2026-07-27", 3398, 3400)}, fill), false); err != nil {
		t.Fatal(err)
	}
	if len(decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")) != 2 {
		t.Fatal("el relleno no llegó a publicarse")
	}

	// Días después: el BCRP sigue sin el 28 y ya no hay relleno para él.
	later := []sources.DailyRate{dayOf("2026-07-27", 3398, 3400), dayOf("2026-07-29", 3396, 3398)}
	if _, err := Run(context.Background(), repo, bcrp(later, nil), false); err != nil {
		t.Fatal(err)
	}

	stored := decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")
	if len(stored) != 2 {
		t.Fatalf("el día provisional caducado no se borró: quedaron %d días", len(stored))
	}
	for _, rate := range stored {
		if rate.Buy == 3400 {
			t.Fatal("el valor provisional sigue publicado fuera de su ventana")
		}
	}
}

// Un día que nunca estuvo marcado viene de la fuente real y no es de este mecanismo borrarlo,
// aunque la fuente deje de mencionarlo en la ventana que pidió.
func TestADayNeverFlaggedIsNeverDropped(t *testing.T) {
	repo := newMemoryRepo()
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{
		dayOf("2026-03-02", 3700, 3702), dayOf("2026-03-03", 3705, 3707),
	}, nil), false); err != nil {
		t.Fatal(err)
	}

	// La corrida siguiente sólo trae el 3: el 2 no se toca.
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2026-03-03", 3705, 3707)}, nil), false); err != nil {
		t.Fatal(err)
	}
	if len(decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")) != 2 {
		t.Fatal("se borró un día que la fuente real había publicado")
	}
}

// Un relleno de diciembre tiene que poder caducar en enero, y eso obliga a reescribir el archivo
// del año anterior aunque la corrida no traiga ningún día suyo.
func TestAProvisionalDayExpiresAcrossTheYearBoundary(t *testing.T) {
	repo := newMemoryRepo()
	fill := []sources.DailyRate{dayOf("2026-12-31", 3500, 3502)}
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2026-12-30", 3498, 3500)}, fill), false); err != nil {
		t.Fatal(err)
	}

	// Enero: la ventana ya no alcanza al 31 de diciembre y nadie lo confirmó.
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2027-01-05", 3490, 3492)}, nil), false); err != nil {
		t.Fatal(err)
	}

	stored := decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")
	if len(stored) != 1 || stored[0].Buy != 3498 {
		t.Fatalf("el relleno de diciembre no caducó: %+v", stored)
	}
}

// El caso que la compuerta de hashes por año no ve: el BCRP confirma el día provisional con
// exactamente el mismo valor, así que el payload —y su hash, y el .gz— no se mueven, pero el flag
// tiene que desaparecer igual. Sin comparar el índice renderizado, el manifest se quedaría
// diciendo que un día confirmado es de relleno.
func TestAFlagThatGoesAwayIsPublishedEvenIfNoPayloadMoves(t *testing.T) {
	repo := newMemoryRepo()
	same := dayOf("2026-09-18", 3375, 3378)
	if _, err := Run(context.Background(), repo, bcrp([]sources.DailyRate{dayOf("2026-09-17", 3362, 3364)},
		[]sources.DailyRate{same}), false); err != nil {
		t.Fatal(err)
	}
	hashBefore := readManifestFile(t, repo).Years(manifest.ExchangeRateBCRP)["2026"].Hash

	report, err := Run(context.Background(), repo, bcrp(
		[]sources.DailyRate{dayOf("2026-09-17", 3362, 3364), same}, nil), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ChangedYears) != 0 {
		t.Fatalf("ningún año se movió y aun así se reportó cambio: %+v", only(t, report))
	}
	if !report.IndexChanged || !report.Changed() {
		t.Fatal("el cambio de índice no se detectó: el flag se habría quedado obsoleto")
	}
	if repo.commits != 2 {
		t.Fatalf("commits=%d: el manifest con el flag retirado no se publicó", repo.commits)
	}

	published := readManifestFile(t, repo)
	if published.Years(manifest.ExchangeRateBCRP)["2026"].Hash != hashBefore {
		t.Fatal("el hash del año cambió y este test ya no prueba lo que dice probar")
	}
	if published.Provisional != nil {
		t.Fatal("el flag sobrevivió a la confirmación del día")
	}
}

func TestAnUnreadableVersionStopsTheRun(t *testing.T) {
	repo := newMemoryRepo()
	repo.files[manifest.Path] = []byte(`{"version":99,"generated":1,"datasets":{}}`)

	_, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3350, 3358)), false)
	if err == nil || !strings.Contains(err.Error(), "versión") {
		t.Fatalf("un manifest de otra versión debía detener la corrida, dio: %v", err)
	}
	if repo.commits != 0 {
		t.Fatal("se commiteó encima de un manifest que este binario no sabe leer")
	}
}

// La fuente real gana incluso si las dos traen el mismo día en la misma corrida.
func TestFetchedWinsOverProvisionalInTheSameRun(t *testing.T) {
	repo := newMemoryRepo()
	updates := bcrp(
		[]sources.DailyRate{dayOf("2026-09-18", 3369, 3371)},
		[]sources.DailyRate{dayOf("2026-09-18", 3374, 3376)},
	)

	if _, err := Run(context.Background(), repo, updates, false); err != nil {
		t.Fatal(err)
	}
	stored := decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")
	if len(stored) != 1 || stored[0].Buy != 3369 {
		t.Fatalf("ganó el provisional sobre el real: %+v", stored)
	}
}
