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

// memoryRepo stands in for GitHub: it keeps the committed files and counts the commits, which
// is the assertion that matters — the point of the hash gate is that most runs commit nothing.
type memoryRepo struct {
	files    map[string][]byte
	commits  int
	messages []string
}

func newMemoryRepo() *memoryRepo { return &memoryRepo{files: map[string][]byte{}} }

func (r *memoryRepo) ReadFile(_ context.Context, path string) ([]byte, error) {
	return r.files[path], nil
}

func (r *memoryRepo) Commit(_ context.Context, message string, files map[string][]byte) (string, error) {
	for path, content := range files {
		r.files[path] = content
	}
	r.commits++
	r.messages = append(r.messages, message)
	return "0123456789abcdef", nil
}

func dayOf(date string, buy, sell int32) sources.DailyRate {
	parsed, err := time.Parse(time.DateOnly, date)
	if err != nil {
		panic(err)
	}
	return sources.DailyRate{Date: parsed, Buy: buy, Sell: sell}
}

// sunat wraps days as the single-dataset update most of these tests exercise.
func sunat(days ...sources.DailyRate) []Update {
	return []Update{{Key: manifest.ExchangeRateSunat, Fetched: days}}
}

// only is the one dataset report a single-dataset run produced.
func only(t *testing.T, report Report) DatasetReport {
	t.Helper()
	if len(report.Datasets) != 1 {
		t.Fatalf("se esperaba un dataset en el reporte, hubo %d", len(report.Datasets))
	}
	return report.Datasets[0]
}

func TestFirstRunPublishesAndSecondRunDoesNot(t *testing.T) {
	repo := newMemoryRepo()
	fetched := sunat(dayOf("2026-09-18", 3350, 3358), dayOf("2026-09-19", 3354, 3362))

	first, err := Run(context.Background(), repo, fetched, false)
	if err != nil {
		t.Fatal(err)
	}
	changed := only(t, first).ChangedYears
	if len(changed) != 1 || changed[0] != "2026" {
		t.Fatalf("la primera corrida debía publicar 2026, publicó %v", changed)
	}
	if repo.commits != 1 {
		t.Fatalf("commits=%d tras la primera corrida", repo.commits)
	}
	if _, written := repo.files["docs/sunat-usd-pen/2026.gz"]; !written {
		t.Fatal("no se escribió el .gz del año")
	}
	if _, written := repo.files[manifest.Path]; !written {
		t.Fatal("el manifest no viajó en el mismo commit que el .gz")
	}

	// El mismo dato otra vez: es el caso normal, la lambda mira 3 veces al día.
	second, err := Run(context.Background(), repo, fetched, false)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Fatalf("una corrida sin novedad publicó %+v", second.Datasets)
	}
	if repo.commits != 1 {
		t.Fatalf("commits=%d: se commiteó sin que cambiara el dato", repo.commits)
	}
}

func TestNewDayPublishesAndKeepsWhatWasThere(t *testing.T) {
	repo := newMemoryRepo()
	if _, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3350, 3358)), false); err != nil {
		t.Fatal(err)
	}

	report, err := Run(context.Background(), repo, sunat(dayOf("2026-09-21", 3360, 3368)), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ChangedYears) != 1 {
		t.Fatalf("un día nuevo no se publicó: %+v", report)
	}

	stored := decodeYear(t, repo, manifest.ExchangeRateSunat, "2026")
	if len(stored) != 2 {
		t.Fatalf("el merge perdió días: quedaron %d", len(stored))
	}
	if stored[0].Buy != 3350 || stored[1].Buy != 3360 {
		t.Fatalf("merge inesperado: %+v", stored)
	}
}

func TestCorrectionOverwritesThePublishedDay(t *testing.T) {
	repo := newMemoryRepo()
	if _, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3350, 3358)), false); err != nil {
		t.Fatal(err)
	}

	// SUNAT reemite una cotización: la corrección tiene que ganar, no ignorarse.
	report, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3351, 3359)), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ChangedYears) != 1 {
		t.Fatal("una corrección no se publicó")
	}
	stored := decodeYear(t, repo, manifest.ExchangeRateSunat, "2026")
	if len(stored) != 1 || stored[0].Buy != 3351 || stored[0].Sell != 3359 {
		t.Fatalf("la corrección no sobrescribió el día: %+v", stored)
	}
}

func TestYearBoundaryTouchesBothFiles(t *testing.T) {
	repo := newMemoryRepo()
	fetched := sunat(dayOf("2026-12-31", 3400, 3408), dayOf("2027-01-01", 3402, 3410))

	report, err := Run(context.Background(), repo, fetched, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ChangedYears) != 2 {
		t.Fatalf("el cruce de año debía tocar dos archivos, tocó %v", only(t, report).ChangedYears)
	}
	if repo.commits != 1 {
		t.Fatalf("los dos años debían ir en un solo commit, hubo %d", repo.commits)
	}
	if decodeYear(t, repo, manifest.ExchangeRateSunat, "2026")[0].Buy != 3400 ||
		decodeYear(t, repo, manifest.ExchangeRateSunat, "2027")[0].Buy != 3402 {
		t.Fatal("los días no cayeron en el archivo de su año")
	}
}

func TestDryRunReportsWithoutCommitting(t *testing.T) {
	repo := newMemoryRepo()
	report, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3350, 3358)), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(only(t, report).ChangedYears) != 1 {
		t.Fatal("el dry-run debía reportar lo que publicaría")
	}
	if repo.commits != 0 {
		t.Fatal("el dry-run commiteó")
	}
	if report.CommitSha != "" {
		t.Fatal("el dry-run devolvió un sha")
	}
}

// Los dos datasets en una sola corrida: un commit, dos carpetas, y el manifest describiendo
// ambos. Dos commits dejarían un instante en el que el manifest publicado nombra el hash nuevo
// de una serie y el viejo de la otra.
func TestBothDatasetsPublishInOneCommit(t *testing.T) {
	repo := newMemoryRepo()
	updates := []Update{
		{Key: manifest.ExchangeRateSunat, Fetched: []sources.DailyRate{dayOf("2026-09-18", 3350, 3358)}},
		{Key: manifest.ExchangeRateBCRP, Fetched: []sources.DailyRate{dayOf("2026-09-18", 3362, 3364)}},
	}

	report, err := Run(context.Background(), repo, updates, false)
	if err != nil {
		t.Fatal(err)
	}
	if repo.commits != 1 {
		t.Fatalf("los dos datasets debían ir en un solo commit, hubo %d", repo.commits)
	}
	if len(report.Datasets) != 2 {
		t.Fatalf("el reporte trae %d datasets", len(report.Datasets))
	}
	if _, written := repo.files["docs/bcrp-interbancario-usd-pen/2026.gz"]; !written {
		t.Fatal("no se escribió el .gz del BCRP")
	}

	published := readManifestFile(t, repo)
	for _, key := range []string{manifest.ExchangeRateSunat, manifest.ExchangeRateBCRP} {
		years, indexed := published.Datasets[key]
		if !indexed {
			t.Fatalf("el manifest no indexa %s", key)
		}
		if years["2026"].Records != 1 {
			t.Fatalf("%s: el manifest declara %d días", key, years["2026"].Records)
		}
	}
	if !strings.Contains(repo.messages[0], manifest.ExchangeRateBCRP) {
		t.Fatalf("el mensaje del commit no nombra el dataset nuevo: %q", repo.messages[0])
	}
}

// Una serie que no se movió no puede arrastrar a la otra a un commit vacío, ni perder su
// descripción en el manifest cuando la otra sí se publica.
func TestOneDatasetMovingDoesNotRewriteTheOther(t *testing.T) {
	repo := newMemoryRepo()
	both := []Update{
		{Key: manifest.ExchangeRateSunat, Fetched: []sources.DailyRate{dayOf("2026-09-18", 3350, 3358)}},
		{Key: manifest.ExchangeRateBCRP, Fetched: []sources.DailyRate{dayOf("2026-09-18", 3362, 3364)}},
	}
	if _, err := Run(context.Background(), repo, both, false); err != nil {
		t.Fatal(err)
	}
	sunatHashBefore := readManifestFile(t, repo).Datasets[manifest.ExchangeRateSunat]["2026"].Hash

	both[1].Fetched = append(both[1].Fetched, dayOf("2026-09-21", 3370, 3372))
	report, err := Run(context.Background(), repo, both, false)
	if err != nil {
		t.Fatal(err)
	}
	if repo.commits != 2 {
		t.Fatalf("commits=%d", repo.commits)
	}
	if len(report.Datasets[0].ChangedYears) != 0 {
		t.Fatalf("SUNAT no se movió y se publicó igual: %+v", report.Datasets[0])
	}
	if len(report.Datasets[1].ChangedYears) != 1 {
		t.Fatalf("el día nuevo del BCRP no se publicó: %+v", report.Datasets[1])
	}

	published := readManifestFile(t, repo)
	if published.Datasets[manifest.ExchangeRateSunat]["2026"].Hash != sunatHashBefore {
		t.Fatal("el hash de SUNAT cambió sin que cambiara su dato")
	}
	if len(decodeYear(t, repo, manifest.ExchangeRateBCRP, "2026")) != 2 {
		t.Fatal("el BCRP perdió un día en el merge")
	}
}

func TestMergePrefersTheOfficialFile(t *testing.T) {
	mirror := []sources.DailyRate{dayOf("2026-09-20", 3300, 3308), dayOf("2026-09-19", 3354, 3362)}
	official := dayOf("2026-09-20", 3354, 3362)

	merged := Merge(mirror, &official)
	if len(merged) != 2 {
		t.Fatalf("Merge duplicó o perdió días: %d", len(merged))
	}
	if !merged[0].Date.Before(merged[1].Date) {
		t.Fatal("Merge no ordenó por fecha")
	}
	if merged[1].Buy != 3354 {
		t.Fatalf("ganó el espejo en vez del archivo oficial: %+v", merged[1])
	}
}

func TestKeepLastDaysNarrowsOnlyWhenAsked(t *testing.T) {
	now := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	month := []sources.DailyRate{
		dayOf("2026-09-01", 3300, 3308),
		dayOf("2026-09-19", 3350, 3358),
		dayOf("2026-09-21", 3354, 3362),
	}

	if kept := KeepLastDays(month, 0, now); len(kept) != 3 {
		t.Fatalf("lookback 0 debía dejar el mes entero, dejó %d", len(kept))
	}
	kept := KeepLastDays(month, 2, now)
	if len(kept) != 2 {
		t.Fatalf("lookback 2 dejó %d días", len(kept))
	}
	if kept[0].Date.Day() != 19 {
		t.Fatalf("lookback 2 recortó mal: %+v", kept[0])
	}
}

func TestEmptyFetchIsAnError(t *testing.T) {
	// Una fuente caída que devuelve una lista vacía no puede leerse como "no hay novedad":
	// eso publicaría el año entero vacío en cuanto el merge se aplicara sobre nada.
	if _, err := Run(context.Background(), newMemoryRepo(), sunat(), false); err == nil {
		t.Fatal("una fuente vacía debía ser un error")
	}
	if _, err := Run(context.Background(), newMemoryRepo(), nil, false); err == nil {
		t.Fatal("una corrida sin datasets debía ser un error")
	}
}

func TestUnknownDatasetIsAnError(t *testing.T) {
	updates := []Update{{Key: "sbs-usd-pen", Fetched: []sources.DailyRate{dayOf("2026-09-18", 3350, 3358)}}}
	_, err := Run(context.Background(), newMemoryRepo(), updates, false)
	if err == nil || !strings.Contains(err.Error(), "desconocido") {
		t.Fatalf("un dataset sin descripción debía detener la corrida, dio: %v", err)
	}
}

func TestUnreadableManifestStopsTheRun(t *testing.T) {
	repo := newMemoryRepo()
	repo.files[manifest.Path] = []byte("{ esto no es json")

	_, err := Run(context.Background(), repo, sunat(dayOf("2026-09-18", 3350, 3358)), false)
	if err == nil || !strings.Contains(err.Error(), "ilegible") {
		t.Fatalf("un manifest corrupto debía detener la corrida, dio: %v", err)
	}
}

func decodeYear(t *testing.T, repo *memoryRepo, datasetKey, year string) []binfmt.Rate {
	t.Helper()
	compressed := repo.files["docs/"+manifest.FilePath(datasetKey, year)]
	if compressed == nil {
		t.Fatalf("no hay archivo publicado para %s %s", datasetKey, year)
	}
	payload, err := binfmt.Gunzip(compressed)
	if err != nil {
		t.Fatal(err)
	}
	rates, err := binfmt.Decode(payload)
	if err != nil {
		t.Fatal(err)
	}
	return rates
}

func readManifestFile(t *testing.T, repo *memoryRepo) manifest.Manifest {
	t.Helper()
	published, err := manifest.Unmarshal(repo.files[manifest.Path])
	if err != nil {
		t.Fatal(err)
	}
	return published
}
