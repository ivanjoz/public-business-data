// The rules of the provisional fill, kept pure so they can be exercised without a network or a
// repo. The fetching itself lives in sources; what is decided here is *which* days may be filled
// and what a filled day looks like.

package publish

import (
	"sort"
	"time"

	"github.com/ivanjoz/public-business-data/updater/binfmt"
	"github.com/ivanjoz/public-business-data/updater/sources"
)

// ProvisionalWindow is how far back a fill may reach, counted in weekdays including today. Three
// is what covers the BCRP's usual lag over a weekend — Friday's rate still missing on Monday —
// without ever reaching into a week the real source has already settled.
const ProvisionalWindow = 3

// MissingWeekdays is which days inside the window the confirmed series does not have.
//
// Weekdays only: the interbank market does not operate on a Saturday, so filling one would create
// a day the BCRP can never confirm. Peruvian holidays cannot be known here and do slip through —
// they are caught by the expiry rule instead, which drops any provisional day that ages out of the
// window unconfirmed. That is what keeps the invariant simple: every day older than the window
// came from the dataset's own source.
func MissingWeekdays(confirmed []sources.DailyRate, now time.Time, window int) []time.Time {
	have := map[string]bool{}
	for _, day := range confirmed {
		have[day.Date.Format(time.DateOnly)] = true
	}

	missing := []time.Time{}
	// The calendar date as the caller sees it, re-anchored to UTC midnight because that is what a
	// day is everywhere else in the format. Truncating now.UTC() instead would throw away the
	// caller's timezone, and with it the whole point of the updater running on Lima's calendar:
	// past 19:00 in Lima it is already tomorrow in UTC, and the window would reach a day ahead.
	year, month, dayOfMonth := now.Date()
	day := time.Date(year, month, dayOfMonth, 0, 0, 0, 0, time.UTC)
	for seen := 0; seen < window; day = day.AddDate(0, 0, -1) {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		seen++
		if !have[day.Format(time.DateOnly)] {
			missing = append(missing, day)
		}
	}

	sort.Slice(missing, func(a, b int) bool { return missing[a].Before(missing[b]) })
	return missing
}

// MedianSpread is the typical distance between buy and sell in the confirmed series, used to give
// a provisional day two rates when the reference source quotes only one. Zero when there is
// nothing to measure, which leaves the mid on both sides rather than inventing a width.
func MedianSpread(confirmed []sources.DailyRate) int32 {
	spreads := make([]int, 0, len(confirmed))
	for _, day := range confirmed {
		if spread := int(day.Sell - day.Buy); spread > 0 {
			spreads = append(spreads, spread)
		}
	}
	if len(spreads) == 0 {
		return 0
	}
	sort.Ints(spreads)
	return int32(spreads[len(spreads)/2])
}

// WithSpread turns a single mid rate into the buy/sell pair a record needs, splitting the spread
// around it. The halves are unequal when the spread is odd — the extra thousandth goes to the sell
// side, which is the direction that never understates what a buyer pays.
func WithSpread(mid, spread int32) (buy, sell int32) {
	if spread <= 0 {
		return mid, mid
	}
	half := spread / 2
	return mid - half, mid + (spread - half)
}

// ProvisionalDates is the fill as ISO strings, for the report and the logs — the one place a
// person reads these days.
func ProvisionalDates(fill []sources.DailyRate) []string {
	dates := make([]string, 0, len(fill))
	for _, day := range fill {
		dates = append(dates, day.Date.Format(time.DateOnly))
	}
	sort.Strings(dates)
	return dates
}

// provisionalDays is the same fill as it goes into the manifest: unixDays, the unit the format
// already speaks everywhere else.
func provisionalDays(fill []sources.DailyRate) []int16 {
	days := make([]int16, 0, len(fill))
	for _, day := range fill {
		days = append(days, binfmt.UnixDayOf(day.Date))
	}
	return days
}

// datesOf is the same as a set, for the merge.
func datesOf(days []sources.DailyRate) map[string]bool {
	dates := map[string]bool{}
	for _, day := range days {
		dates[day.Date.Format(time.DateOnly)] = true
	}
	return dates
}
