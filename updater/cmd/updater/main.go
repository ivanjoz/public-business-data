// Command updater keeps docs/ current. One binary, two entrypoints: the Lambda handler when
// the runtime sets AWS_LAMBDA_FUNCTION_NAME, and a single run otherwise — which is what a
// workstation, a --dry-run check and the GitHub Actions alternative all use.
//
//	go run ./cmd/updater -config ../config.toml -dry-run
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/ivanjoz/public-business-data/updater/config"
	"github.com/ivanjoz/public-business-data/updater/github"
	"github.com/ivanjoz/public-business-data/updater/manifest"
	"github.com/ivanjoz/public-business-data/updater/publish"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

// lima is the calendar every date in this program belongs to. Both fuentes publish on Peru's
// business day, so "qué día es hoy" has to be answered in Lima and not in UTC.
//
// It matters because the cron reaches past midnight UTC: 20:15 in Lima is 01:15 UTC of the next
// day, so a run anchored on UTC would ask SUNAT for next month on the 30th at seven in the evening
// —getting nothing, and failing the run— and would let the provisional fill reach a day Lima has
// not lived yet.
//
// A fixed offset and not time.LoadLocation("America/Lima"): provided.al2023 ships no tzdata, so
// loading by name fails on the Lambda and silently falls back to UTC. Peru has had no DST since
// 1994 and −05:00 is the whole story.
var lima = time.FixedZone("-05", -5*60*60)

func main() {
	configPath := flag.String("config", "../config.toml", "config.toml a leer")
	dryRun := flag.Bool("dry-run", false, "calcula los hashes y reporta, sin commitear")
	flag.Parse()

	loaded, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if *dryRun {
		loaded.Updater.DryRun = true
	}

	if config.IsLambda() {
		lambda.Start(func(ctx context.Context, _ any) (publish.Report, error) {
			return run(ctx, loaded)
		})
		return
	}

	report, err := run(context.Background(), loaded)
	if err != nil {
		log.Fatalf("updater: %v", err)
	}
	if report.DryRun && report.Changed() {
		os.Exit(2) // Un CI puede distinguir "hay algo que publicar" de "todo al día".
	}
}

func run(ctx context.Context, loaded config.Config) (publish.Report, error) {
	// Leer el repo público no necesita credencial, así que un dry-run sin token sigue siendo
	// una verificación completa de todo salvo el commit. Es lo que permite probar el pipeline
	// antes de emitir el PAT.
	token, err := config.ResolveToken(ctx, loaded)
	if err != nil {
		if !loaded.Updater.DryRun {
			return publish.Report{}, err
		}
		logLine("aviso: sin token, el dry-run lee el repositorio público sin autenticar (%v)", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	now := time.Now().In(lima)

	updates := []publish.Update{}

	sunat, err := fetchSunat(ctx, client, now, loaded.Updater.LookbackDays)
	if err != nil {
		return publish.Report{}, err
	}
	updates = append(updates, publish.Update{Key: manifest.ExchangeRateSunat, Fetched: sunat})

	// The BCRP is allowed to fail without failing the run. Its endpoint is behind a WAF and the
	// series it answers is a different one from SUNAT's: losing it for a few hours costs the
	// market rate being a day stale, and the next run repairs it because the window is the whole
	// month. Failing the run instead would also hold back the SUNAT rate, which did arrive.
	if bcrp, err := fetchBCRP(ctx, client, now, loaded.Updater.LookbackDays); err != nil {
		logLine("aviso: no se pudo leer el interbancario del BCRP: %v", err)
	} else if len(bcrp.Fetched) == 0 {
		logLine("aviso: el BCRP no publicó ningún día del mes en curso todavía")
	} else {
		updates = append(updates, bcrp)
	}

	repo := github.New(loaded.GitHub.Owner, loaded.GitHub.Repo, loaded.GitHub.Branch,
		loaded.GitHub.CommitName, loaded.GitHub.CommitEmail, token)

	report, err := publish.Run(ctx, repo, updates, loaded.Updater.DryRun)
	if err != nil {
		return report, err
	}

	for _, dataset := range report.Datasets {
		if len(dataset.ProvisionalDates) > 0 {
			logLine("%s provisional: %v (fuente de referencia, se sobrescriben al publicarse)",
				dataset.Key, dataset.ProvisionalDates)
		}
		switch {
		case len(dataset.ChangedYears) == 0:
			logLine("%s sin cambios: %d años revisados, último %s",
				dataset.Key, len(dataset.CheckedYears), dataset.LatestDate)
		case report.DryRun:
			logLine("%s dry-run: publicaría %v (último %s)",
				dataset.Key, dataset.ChangedYears, dataset.LatestDate)
		default:
			logLine("%s publicado %v hasta %s en %s",
				dataset.Key, dataset.ChangedYears, dataset.LatestDate, shortSha(report.CommitSha))
		}
	}
	return report, nil
}

// fetchSunat is the mirror's month plus the official file for today, collapsed into one series.
func fetchSunat(ctx context.Context, client *http.Client, now time.Time, lookbackDays int) ([]sources.DailyRate, error) {
	monthRates, err := sources.FetchMonth(ctx, client, now.Year(), now.Month())
	if err != nil {
		return nil, fmt.Errorf("espejo: %w", err)
	}

	// The official file is allowed to fail without failing the run: it answers only today, and
	// the mirror already carries that day. Losing the cross-check is worth less than the update.
	var official *sources.DailyRate
	if today, err := sources.FetchToday(ctx, client); err != nil {
		logLine("aviso: no se pudo leer el archivo oficial de SUNAT: %v", err)
	} else {
		official = &today
		reportDisagreement(monthRates, today)
	}

	return publish.KeepLastDays(publish.Merge(monthRates, official), lookbackDays, now), nil
}

// fetchBCRP asks for the month to date and then fills what the BCRP has not published yet.
//
// The month is the self-healing part, same as the mirror's: the interbank rate of a day is only
// firm after the market closes, so the last day of any window is usually still missing, and
// re-asking for the whole month is what fills it in the next run. The window also reaches back at
// least ten days regardless of the calendar, so a provisional day filled on the 1st of a month is
// still inside the range that can confirm it on the 2nd.
func fetchBCRP(ctx context.Context, client *http.Client, now time.Time, lookbackDays int) (publish.Update, error) {
	update := publish.Update{Key: manifest.ExchangeRateBCRP}

	from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	if reachBack := now.AddDate(0, 0, -10); reachBack.Before(from) {
		from = reachBack
	}

	rates, err := sources.FetchBCRP(ctx, client, from, now)
	if err != nil {
		return update, err
	}
	update.Fetched = publish.KeepLastDays(rates, lookbackDays, now)
	update.Provisional = fillProvisional(ctx, client, update.Fetched, now, lookbackDays)
	return update, nil
}

// fillProvisional covers the days the BCRP still owes with the reference source. Every failure
// here is survivable and none of them stops the run: a day that cannot be filled is simply a day
// the series does not have yet, which is exactly what it was before trying.
func fillProvisional(ctx context.Context, client *http.Client, confirmed []sources.DailyRate,
	now time.Time, lookbackDays int) []sources.DailyRate {
	// A lookback narrower than the window is an explicit "only touch these days"; filling past it
	// would publish days the same run was told not to consider.
	window := publish.ProvisionalWindow
	if lookbackDays > 0 && lookbackDays < window {
		window = lookbackDays
	}

	missing := publish.MissingWeekdays(confirmed, now, window)
	if len(missing) == 0 {
		return nil
	}
	spread := publish.MedianSpread(confirmed)

	fill := make([]sources.DailyRate, 0, len(missing))
	for _, day := range missing {
		mid, err := sources.FetchProvisionalMid(ctx, client, day)
		switch {
		case errors.Is(err, sources.ErrNotPublished):
			// Normal for today and for a global holiday: nobody quoted, so there is nothing to fill.
			continue
		case err != nil:
			logLine("aviso: no se pudo rellenar el %s desde la fuente provisional: %v",
				day.Format(time.DateOnly), err)
			continue
		}
		buy, sell := publish.WithSpread(mid, spread)
		fill = append(fill, sources.DailyRate{Date: day, Buy: buy, Sell: sell})
	}
	return fill
}

func shortSha(sha string) string {
	if len(sha) < 7 {
		return sha
	}
	return sha[:7]
}

// reportDisagreement logs when the mirror and the official file differ for the same day. It
// does not fail the run — the official value already won the merge — but a recurring mismatch
// is the signal that the mirror went stale and the source needs replacing.
func reportDisagreement(monthRates []sources.DailyRate, official sources.DailyRate) {
	for _, day := range monthRates {
		if !day.Date.Equal(official.Date) {
			continue
		}
		if day.Buy != official.Buy || day.Sell != official.Sell {
			logLine("aviso: el espejo discrepa de SUNAT el %s: espejo %d/%d, oficial %d/%d",
				official.Date.Format(time.DateOnly), day.Buy, day.Sell, official.Buy, official.Sell)
		}
		return
	}
}

// logLine prefixes with "*" because that is the only thing core-style log filters keep in
// CloudWatch, which is the only place a scheduled run can be observed.
func logLine(format string, args ...any) {
	log.Printf("*"+format, args...)
}
