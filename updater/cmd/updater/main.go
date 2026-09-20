// Command updater keeps docs/ current. One binary, two entrypoints: the Lambda handler when
// the runtime sets AWS_LAMBDA_FUNCTION_NAME, and a single run otherwise — which is what a
// workstation, a --dry-run check and the GitHub Actions alternative all use.
//
//	go run ./cmd/updater -config ../config.toml -dry-run
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/ivanjoz/public-business-data/updater/config"
	"github.com/ivanjoz/public-business-data/updater/github"
	"github.com/ivanjoz/public-business-data/updater/publish"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

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
	if report.DryRun && len(report.ChangedYears) > 0 {
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
	now := time.Now().UTC()

	monthRates, err := sources.FetchMonth(ctx, client, now.Year(), now.Month())
	if err != nil {
		return publish.Report{}, fmt.Errorf("espejo: %w", err)
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

	fetched := publish.KeepLastDays(publish.Merge(monthRates, official), loaded.Updater.LookbackDays, now)

	repo := github.New(loaded.GitHub.Owner, loaded.GitHub.Repo, loaded.GitHub.Branch,
		loaded.GitHub.CommitName, loaded.GitHub.CommitEmail, token)

	report, err := publish.Run(ctx, repo, fetched, loaded.Updater.DryRun)
	if err != nil {
		return report, err
	}

	switch {
	case len(report.ChangedYears) == 0:
		logLine("sin cambios: %d días revisados, último %s", len(fetched), report.LatestDate)
	case report.DryRun:
		logLine("dry-run: publicaría %v (último %s)", report.ChangedYears, report.LatestDate)
	default:
		logLine("publicado %v hasta %s en %s", report.ChangedYears, report.LatestDate, shortSha(report.CommitSha))
	}
	return report, nil
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
