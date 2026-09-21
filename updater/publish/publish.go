// Package publish holds the decision the whole project turns on: whether what a source published
// today differs from what is already committed, and therefore whether to make a commit at all.
// It is pure except for the Repo it is handed, so the decision can be tested without GitHub.
package publish

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
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

// Update is one dataset's worth of freshly fetched days. Run takes a slice of them so a run that
// touches both series still produces a single commit: two commits would leave a moment in which
// the published manifest names one dataset's new hash and not the other's.
type Update struct {
	Key     string
	Fetched []sources.DailyRate
	// Provisional are days the dataset's own source has not published yet, filled from the
	// reference source. They lose to anything in Fetched and are republished from scratch every
	// run: the set handed in here is the whole truth, so a day that stops appearing disappears
	// from the published series too. That is the expiry rule — a fill the real source never
	// confirms leaves no trace once it ages out of the window.
	Provisional []sources.DailyRate
}

// DatasetReport is what one series did this run. ChangedYears empty is the normal outcome: each
// source publishes once a day and the lambda looks three times.
type DatasetReport struct {
	Key          string
	CheckedYears []string
	ChangedYears []string
	LatestDate   string
	// ProvisionalDates is what got flagged this run, for the logs. Empty is the good outcome:
	// it means the real source had already published everything inside the window.
	ProvisionalDates []string
}

// Report is what the run tells the logs.
type Report struct {
	Datasets []DatasetReport
	// IndexChanged is true when the manifest itself moved without any year file moving with it —
	// a flag that came or went, or an upgrade of the manifest format.
	IndexChanged bool
	CommitSha    string
	DryRun       bool
}

// Changed reports whether the run had something to publish.
func (r Report) Changed() bool {
	if r.IndexChanged {
		return true
	}
	for _, dataset := range r.Datasets {
		if len(dataset.ChangedYears) > 0 {
			return true
		}
	}
	return false
}

// Run merges what was fetched into what is published and commits only the years whose payload
// actually moved. Reading the current state and re-encoding it — instead of appending — is what
// makes a correction to an older day publishable: the sources do re-issue a rate now and then.
func Run(ctx context.Context, repo Repo, updates []Update, dryRun bool) (Report, error) {
	report := Report{DryRun: dryRun}
	if len(updates) == 0 {
		return report, fmt.Errorf("no se recibió ningún dataset que publicar")
	}

	published, publishedRaw, err := readManifest(ctx, repo)
	if err != nil {
		return report, err
	}

	changedFiles := map[string][]byte{}

	for _, update := range updates {
		datasetReport, err := runDataset(ctx, repo, &published, update, changedFiles)
		if err != nil {
			return report, err
		}
		report.Datasets = append(report.Datasets, datasetReport)
	}

	// Rendered with Generated still holding the published value, so this compares the index and
	// nothing else. It catches what the per-year hashes cannot: a provisional flag that came or
	// went while every payload stayed byte-identical, a year dropped from the index, an upgrade
	// of the manifest format.
	published.Version = manifest.Version
	rendered, err := manifest.Marshal(published)
	if err != nil {
		return report, err
	}
	report.IndexChanged = !bytes.Equal(rendered, publishedRaw)

	if len(changedFiles) == 0 && !report.IndexChanged {
		return report, nil
	}

	// Generated moves only here, on a real publish, which is why it can never take part in the
	// comparison above: hashing it would make every run look like a change.
	published.Generated = time.Now().Unix()
	if rendered, err = manifest.Marshal(published); err != nil {
		return report, err
	}
	// The manifest travels in the same commit as the .gz it describes. Split across two
	// commits, a client reading in between would see a hash with no file behind it.
	changedFiles[manifest.Path] = rendered

	if dryRun {
		return report, nil
	}

	report.CommitSha, err = repo.Commit(ctx, commitMessage(report), changedFiles)
	return report, err
}

// runDataset is Run for one series: it writes the years that moved into changedFiles and updates
// the dataset entry in published, which the caller renders once for all of them.
func runDataset(ctx context.Context, repo Repo, published *manifest.Manifest, update Update,
	changedFiles map[string][]byte) (DatasetReport, error) {
	report := DatasetReport{Key: update.Key}
	if len(update.Fetched) == 0 {
		return report, fmt.Errorf("%s: la fuente no devolvió ningún día", update.Key)
	}
	if !manifest.Known(update.Key) {
		return report, fmt.Errorf("dataset desconocido: %q", update.Key)
	}

	years := published.Datasets[update.Key]
	if years == nil {
		years = map[string]manifest.File{}
		published.Datasets[update.Key] = years
	}

	// What was flagged last time has to be read before the entry is overwritten: those are the
	// days the merge is allowed to drop, and the only ones — a day nobody ever flagged came from
	// the real source and is not this run's to remove.
	wasProvisional := published.ProvisionalDays(update.Key)
	report.ProvisionalDates = ProvisionalDates(update.Provisional)
	published.SetProvisional(update.Key, provisionalDays(update.Provisional))

	latestDay := int16(0)
	for _, year := range yearsTouched(update, wasProvisional) {
		report.CheckedYears = append(report.CheckedYears, year)

		merged, err := mergeYear(ctx, repo, update.Key, year, update, wasProvisional)
		if err != nil {
			return report, err
		}
		payload, err := binfmt.Encode(merged)
		if err != nil {
			return report, fmt.Errorf("%s año %s: %w", update.Key, year, err)
		}

		// A year can end up empty when the only thing it held was a fill that has now expired.
		// Dropping the entry is what keeps `d: 0` — which reads back as 1970-01-01 — out of the
		// index; the orphaned .gz is never named again and no client will ask for it.
		if len(merged) == 0 {
			if _, wasPublished := years[year]; wasPublished {
				delete(years, year)
				report.ChangedYears = append(report.ChangedYears, year)
			}
			continue
		}

		entry := manifest.Describe(merged, payload)
		if entry.LastDay > latestDay {
			latestDay = entry.LastDay
		}
		if years[year].Hash == entry.Hash {
			continue
		}

		compressed, err := binfmt.Gzip(payload)
		if err != nil {
			return report, fmt.Errorf("%s año %s: %w", update.Key, year, err)
		}
		changedFiles[docsPrefix+manifest.FilePath(update.Key, year)] = compressed
		years[year] = entry
		report.ChangedYears = append(report.ChangedYears, year)
	}

	if latestDay > 0 {
		report.LatestDate = binfmt.DateOf(latestDay).Format(time.DateOnly)
	}
	return report, nil
}

// commitMessage names every series that moved, so `git log --oneline` on the data branch reads as
// the history of what was published and not just as "data: update".
func commitMessage(report Report) string {
	parts := make([]string, 0, len(report.Datasets))
	for _, dataset := range report.Datasets {
		if len(dataset.ChangedYears) == 0 {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s hasta %s (%s)",
			dataset.Key, dataset.LatestDate, joinYears(dataset.ChangedYears)))
	}
	return "data: " + strings.Join(parts, ", ")
}

// readManifest loads the committed manifest and the exact bytes it was read as, which is what the
// caller compares against to decide whether the index moved. A manifest written in another version
// of the format stops the run rather than being guessed at (see manifest.Unmarshal).
func readManifest(ctx context.Context, repo Repo) (manifest.Manifest, []byte, error) {
	raw, err := repo.ReadFile(ctx, manifest.Path)
	if err != nil {
		return manifest.Manifest{}, nil, err
	}
	if raw == nil {
		return manifest.Empty(), nil, nil
	}

	published, err := manifest.Unmarshal(raw)
	if err != nil {
		return published, raw, fmt.Errorf("%s publicado es ilegible: %w", manifest.Path, err)
	}
	return published, raw, nil
}

// mergeYear reads the published year and lays this run's days over it, in three passes:
//
//  1. Drop whatever was flagged provisional last time. It is either confirmed below, re-filled
//     below, or gone — and "gone" is the point: an approximate day the real source never
//     published must not outlive its window.
//  2. Lay the real source's days over the rest. They win: when a source corrects a rate, the
//     correction is the one that has to survive.
//  3. Fill with provisional days, but only where the real source said nothing.
func mergeYear(ctx context.Context, repo Repo, datasetKey, year string, update Update,
	wasProvisional map[int16]bool) ([]binfmt.Rate, error) {
	compressed, err := repo.ReadFile(ctx, docsPrefix+manifest.FilePath(datasetKey, year))
	if err != nil {
		return nil, err
	}

	byDay := map[int16]binfmt.Rate{}
	if compressed != nil {
		payload, err := binfmt.Gunzip(compressed)
		if err != nil {
			return nil, fmt.Errorf("%s año %s publicado: %w", datasetKey, year, err)
		}
		stored, err := binfmt.Decode(payload)
		if err != nil {
			return nil, fmt.Errorf("%s año %s publicado: %w", datasetKey, year, err)
		}
		for _, rate := range stored {
			byDay[rate.UnixDay] = rate
		}
	}

	for unixDay := range wasProvisional {
		delete(byDay, unixDay)
	}

	for _, day := range update.Fetched {
		if day.Date.Format("2006") != year {
			continue
		}
		unixDay := binfmt.UnixDayOf(day.Date)
		byDay[unixDay] = binfmt.Rate{UnixDay: unixDay, Buy: day.Buy, Sell: day.Sell}
	}

	confirmed := datesOf(update.Fetched)
	for _, day := range update.Provisional {
		if day.Date.Format("2006") != year || confirmed[day.Date.Format(time.DateOnly)] {
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

// yearsTouched is which year files this run has to rewrite. Grouping by year is what makes the
// 31st of December need no special case: that run simply touches two files instead of one. Last
// run's provisional days count too — a fill from December has to be droppable in January.
func yearsTouched(update Update, wasProvisional map[int16]bool) []string {
	seen := map[string]bool{}
	for _, day := range update.Fetched {
		seen[day.Date.Format("2006")] = true
	}
	for _, day := range update.Provisional {
		seen[day.Date.Format("2006")] = true
	}
	for unixDay := range wasProvisional {
		seen[binfmt.DateOf(unixDay).Format("2006")] = true
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
