// Package publish holds the decision the whole project turns on: whether what SUNAT published
// today differs from what is already committed, and therefore whether to make a commit at all.
// It is pure except for the Repo it is handed, so the decision can be tested without GitHub.
package publish

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
	"github.com/ivanjoz/public-business-data/updater/manifest"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

// docsPrefix is the folder GitHub Pages publishes; every path written goes through it.
const docsPrefix = "docs/"

// Repo is the part of the GitHub client publishing needs. An interface only so the decision
// can be exercised against an in-memory repo in the tests.
type Repo interface {
	ReadFile(ctx context.Context, path string) ([]byte, error)
	Commit(ctx context.Context, message string, files map[string][]byte) (string, error)
}

// Report is what the run tells the logs. ChangedYears empty is the normal outcome: SUNAT
// publishes once a day and the lambda looks three times.
type Report struct {
	CheckedYears []string
	ChangedYears []string
	LatestDate   string
	CommitSha    string
	DryRun       bool
}

// Run merges what was fetched into what is published and commits only the years whose payload
// actually moved. Reading the current state and re-encoding it — instead of appending — is what
// makes a correction to an older day publishable: SUNAT does re-issue a rate now and then.
func Run(ctx context.Context, repo Repo, fetched []sources.DailyRate, dryRun bool) (Report, error) {
	report := Report{DryRun: dryRun}
	if len(fetched) == 0 {
		return report, fmt.Errorf("la fuente no devolvió ningún día")
	}

	published, err := readManifest(ctx, repo)
	if err != nil {
		return report, err
	}
	dataset, hasDataset := published.Datasets[manifest.ExchangeRateSunat]
	if !hasDataset {
		dataset = manifest.NewExchangeRateDataset()
	}

	changedFiles := map[string][]byte{}

	for _, year := range yearsOf(fetched) {
		report.CheckedYears = append(report.CheckedYears, year)

		merged, err := mergeYear(ctx, repo, year, fetched)
		if err != nil {
			return report, err
		}
		payload, err := binfmt.Encode(merged)
		if err != nil {
			return report, fmt.Errorf("año %s: %w", year, err)
		}

		entry := manifest.Describe(merged, payload)
		if entry.LastDate > report.LatestDate {
			report.LatestDate = entry.LastDate
		}
		if dataset.Files[year].Hash == entry.Hash {
			continue
		}

		compressed, err := binfmt.Gzip(payload)
		if err != nil {
			return report, fmt.Errorf("año %s: %w", year, err)
		}
		changedFiles[docsPrefix+manifest.FilePath(manifest.ExchangeRateSunat, year)] = compressed
		dataset.Files[year] = entry
		report.ChangedYears = append(report.ChangedYears, year)
	}

	if len(changedFiles) == 0 {
		return report, nil
	}

	// Generated moves only here, on a real publish, which is why it can never take part in the
	// comparison above: hashing it would make every run look like a change.
	published.Version = 1
	published.Generated = time.Now().Unix()
	published.Datasets[manifest.ExchangeRateSunat] = dataset

	rendered, err := manifest.Marshal(published)
	if err != nil {
		return report, err
	}
	// The manifest travels in the same commit as the .gz it describes. Split across two
	// commits, a client reading in between would see a hash with no file behind it.
	changedFiles[manifest.Path] = rendered

	if dryRun {
		return report, nil
	}

	message := fmt.Sprintf("data: tipo de cambio SUNAT hasta %s (%s)",
		report.LatestDate, joinYears(report.ChangedYears))
	report.CommitSha, err = repo.Commit(ctx, message, changedFiles)
	return report, err
}

// readManifest loads the committed manifest, or an empty one the first time the repo has none.
func readManifest(ctx context.Context, repo Repo) (manifest.Manifest, error) {
	raw, err := repo.ReadFile(ctx, manifest.Path)
	if err != nil {
		return manifest.Manifest{}, err
	}
	if raw == nil {
		return manifest.Manifest{Version: 1, Datasets: map[string]manifest.Dataset{}}, nil
	}

	published, err := manifest.Unmarshal(raw)
	if err != nil {
		return published, fmt.Errorf("%s publicado es ilegible: %w", manifest.Path, err)
	}
	if published.Datasets == nil {
		published.Datasets = map[string]manifest.Dataset{}
	}
	return published, nil
}

// mergeYear reads the published year and lays the fetched days over it. The fetched value wins:
// when SUNAT corrects a rate, the correction is the one that has to survive.
func mergeYear(ctx context.Context, repo Repo, year string, fetched []sources.DailyRate) ([]binfmt.Rate, error) {
	compressed, err := repo.ReadFile(ctx, docsPrefix+manifest.FilePath(manifest.ExchangeRateSunat, year))
	if err != nil {
		return nil, err
	}

	byDay := map[int16]binfmt.Rate{}
	if compressed != nil {
		payload, err := binfmt.Gunzip(compressed)
		if err != nil {
			return nil, fmt.Errorf("año %s publicado: %w", year, err)
		}
		stored, err := binfmt.Decode(payload)
		if err != nil {
			return nil, fmt.Errorf("año %s publicado: %w", year, err)
		}
		for _, rate := range stored {
			byDay[rate.UnixDay] = rate
		}
	}

	for _, day := range fetched {
		if day.Date.Format("2006") != year {
			continue
		}
		unixDay := binfmt.UnixDayOf(day.Date)
		byDay[unixDay] = binfmt.Rate{UnixDay: unixDay, Buy: day.Buy, Sell: day.Sell}
	}

	merged := make([]binfmt.Rate, 0, len(byDay))
	for _, rate := range byDay {
		merged = append(merged, rate)
	}
	return merged, nil
}

// yearsOf is which year files the fetched days touch. Grouping by year is what makes the 31st
// of December need no special case: that run simply touches two files instead of one.
func yearsOf(fetched []sources.DailyRate) []string {
	seen := map[string]bool{}
	for _, day := range fetched {
		seen[day.Date.Format("2006")] = true
	}
	years := make([]string, 0, len(seen))
	for year := range seen {
		years = append(years, year)
	}
	sort.Strings(years)
	return years
}

// Merge collapses the mirror's month and SUNAT's own line into one series. The official file
// wins for the day it answers: the mirror is a copy, and a disagreement means the copy is stale.
func Merge(mirrorMonth []sources.DailyRate, official *sources.DailyRate) []sources.DailyRate {
	byDay := map[string]sources.DailyRate{}
	for _, day := range mirrorMonth {
		byDay[day.Date.Format(time.DateOnly)] = day
	}
	if official != nil {
		byDay[official.Date.Format(time.DateOnly)] = *official
	}

	merged := make([]sources.DailyRate, 0, len(byDay))
	for _, day := range byDay {
		merged = append(merged, day)
	}
	sort.Slice(merged, func(a, b int) bool { return merged[a].Date.Before(merged[b].Date) })
	return merged
}

// KeepLastDays narrows the fetched series when lookback_days is set. Zero means "keep the whole
// month", which is the default because it costs the same request and repairs missed runs.
func KeepLastDays(fetched []sources.DailyRate, lookbackDays int, now time.Time) []sources.DailyRate {
	if lookbackDays <= 0 {
		return fetched
	}
	cutoff := now.UTC().AddDate(0, 0, -lookbackDays)
	kept := make([]sources.DailyRate, 0, lookbackDays+1)
	for _, day := range fetched {
		if !day.Date.Before(cutoff) {
			kept = append(kept, day)
		}
	}
	return kept
}

func joinYears(years []string) string {
	joined := ""
	for index, year := range years {
		if index > 0 {
			joined += ", "
		}
		joined += year
	}
	if joined == "" {
		return strconv.Itoa(time.Now().Year())
	}
	return joined
}
