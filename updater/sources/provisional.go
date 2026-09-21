// The provisional fill. The BCRP posts its interbank rate with a couple of business days' lag, so
// the last days of that series are missing right when someone is most likely to ask for them. This
// covers the gap with a reference rate, marked as such, until the real value lands.
//
// The source is @fawazahmed0/currency-api served by jsDelivr: no API key, and — the reason it was
// chosen over the alternatives — it answers a *dated* URL, which is what filling three days back
// requires. Measured against the BCRP over six business days its error stayed inside ±0,5 %
// (±1,5 céntimos). Yahoo Finance was measured first and rejected: its daily USD/PEN bars swung
// between −0,3 % and −3,6 % with no pattern, and invented bars on Sundays.
//
// It is a reference rate and not the Lima interbank, so nothing here is authoritative: every day
// it produces is published flagged, and the BCRP's own value overwrites it the moment it arrives.

package sources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ProvisionalSourceURL takes the date as YYYY-MM-DD. The .min.json is the same payload as the
// pretty one — same `date`, same rate — for a kilobyte less.
const ProvisionalSourceURL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@%s/v1/currencies/usd.min.json"

// provisionalResponse is the part of the payload this needs: the date it is really answering, and
// the USD table it came for.
type provisionalResponse struct {
	Date string             `json:"date"`
	Usd  map[string]float64 `json:"usd"`
}

// ErrNotPublished means the source has no data for that date — a 404. It is not a failure: the
// caller asked for a day the reference source never covered, and simply goes without it.
var ErrNotPublished = errors.New("la fuente provisional no publica ese día")

// FetchProvisionalMid reads the reference USD/PEN for one date and returns it scaled, as a single
// mid rate: this source quotes one number, not a bid and an ask.
func FetchProvisionalMid(ctx context.Context, client *http.Client, date time.Time) (int32, error) {
	wanted := date.Format(time.DateOnly)

	body, err := getWithRetry(ctx, client, fmt.Sprintf(ProvisionalSourceURL, wanted), userAgent)
	if err != nil {
		var status statusError
		if errors.As(err, &status) && status.Code == http.StatusNotFound {
			return 0, fmt.Errorf("%s: %w", wanted, ErrNotPublished)
		}
		return 0, err
	}

	var parsed provisionalResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, fmt.Errorf("respuesta inesperada de la fuente provisional (%s): %w", truncate(string(body), 120), err)
	}

	// The URL carries the date, so a payload dated differently means jsDelivr resolved the tag to
	// something else — most likely `latest`. Publishing today's rate under an older day would be
	// invisible in the data and wrong in every consumer.
	if parsed.Date != wanted {
		return 0, fmt.Errorf("se pidió %s a la fuente provisional y respondió %s", wanted, parsed.Date)
	}

	rate, quoted := parsed.Usd["pen"]
	if !quoted || rate <= 0 {
		return 0, fmt.Errorf("la fuente provisional no cotizó PEN el %s", wanted)
	}
	return int32(rate*1000 + 0.5), nil
}
