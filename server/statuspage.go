package main

import (
	"encoding/json"
	"fmt"
	"html"
	"regexp"
	"sort"
	"strings"
	"time"
)

// statuspage.go decodes the Statuspage v2 summary.json payload and projects
// it onto this plugin's own vocabulary (Severity + Snapshot). Everything here
// is pure: bytes in, snapshot out, no clock and no network — the poller owns
// those.

// Severity is the ordered scale every surface colors off. It deliberately has
// one more level than Statuspage's page indicator (maintenance), because
// planned maintenance must stay quiet while a real degradation goes loud.
type Severity int

const (
	// SeverityOperational — nothing to report.
	SeverityOperational Severity = iota
	// SeverityMaintenance — planned work in progress. Quiet: chip only.
	SeverityMaintenance
	// SeverityMinor — degraded performance / Statuspage "minor".
	SeverityMinor
	// SeverityMajor — partial outage / Statuspage "major".
	SeverityMajor
	// SeverityCritical — major outage / Statuspage "critical".
	SeverityCritical
)

// severityNames are the stable strings the UI switches on. Changing one is a
// wire-format change for ui/bundle.js.
var severityNames = map[Severity]string{
	SeverityOperational: "operational",
	SeverityMaintenance: "maintenance",
	SeverityMinor:       "minor",
	SeverityMajor:       "major",
	SeverityCritical:    "critical",
}

func (s Severity) String() string {
	if name, ok := severityNames[s]; ok {
		return name
	}
	return "operational"
}

// MarshalJSON renders a Severity as its stable name rather than its ordinal,
// so the UI never depends on the numeric ordering.
func (s Severity) MarshalJSON() ([]byte, error) { return json.Marshal(s.String()) }

// Loud reports whether this severity should escalate past the recessed
// status-bar chip: a visible top-bar banner, a colored chip, and a
// transition toast. Planned maintenance is intentionally not loud.
func (s Severity) Loud() bool { return s >= SeverityMinor }

// severityFromComponentStatus maps a Statuspage component status onto the
// scale. Unknown values are treated as operational rather than as a failure:
// Statuspage adds statuses over time and a new one must not paint the whole
// UI red.
func severityFromComponentStatus(status string) Severity {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "degraded_performance":
		return SeverityMinor
	case "partial_outage":
		return SeverityMajor
	case "major_outage":
		return SeverityCritical
	case "under_maintenance":
		return SeverityMaintenance
	default:
		return SeverityOperational
	}
}

// severityFromIndicator maps the page-level rollup (status.indicator) onto
// the scale. This is reported for context but never drives loudness — see
// Snapshot.Overall.
func severityFromIndicator(indicator string) Severity {
	switch strings.ToLower(strings.TrimSpace(indicator)) {
	case "minor":
		return SeverityMinor
	case "major":
		return SeverityMajor
	case "critical":
		return SeverityCritical
	case "maintenance":
		return SeverityMaintenance
	default:
		return SeverityOperational
	}
}

// severityFromImpact maps an incident's impact onto the scale. "maintenance"
// impact belongs to scheduled maintenances, which are surfaced separately.
func severityFromImpact(impact string) Severity {
	switch strings.ToLower(strings.TrimSpace(impact)) {
	case "minor":
		return SeverityMinor
	case "major":
		return SeverityMajor
	case "critical":
		return SeverityCritical
	case "maintenance":
		return SeverityMaintenance
	default:
		return SeverityOperational
	}
}

// ---- raw Statuspage payload ------------------------------------------------

type rawSummary struct {
	Page struct {
		Name      string `json:"name"`
		URL       string `json:"url"`
		UpdatedAt string `json:"updated_at"`
	} `json:"page"`
	Components            []rawComponent `json:"components"`
	Incidents             []rawIncident  `json:"incidents"`
	ScheduledMaintenances []rawIncident  `json:"scheduled_maintenances"`
	Status                struct {
		Indicator   string `json:"indicator"`
		Description string `json:"description"`
	} `json:"status"`
}

type rawComponent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	Showcase    bool   `json:"showcase"`
	Group       bool   `json:"group"`
	UpdatedAt   string `json:"updated_at"`
}

type rawIncident struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	Status          string      `json:"status"`
	Impact          string      `json:"impact"`
	Shortlink       string      `json:"shortlink"`
	CreatedAt       string      `json:"created_at"`
	UpdatedAt       string      `json:"updated_at"`
	StartedAt       string      `json:"started_at"`
	ScheduledFor    string      `json:"scheduled_for"`
	ScheduledUntil  string      `json:"scheduled_until"`
	IncidentUpdates []rawUpdate `json:"incident_updates"`
	Components      []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"components"`
}

type rawUpdate struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
	DisplayAt string `json:"display_at"`
}

// ---- projected snapshot ----------------------------------------------------

// Component is one provider component as the UI renders it.
type Component struct {
	Name     string   `json:"name"`
	Status   string   `json:"status"`   // raw Statuspage status, e.g. "partial_outage"
	Severity Severity `json:"severity"` // projected level
	Key      bool     `json:"key"`      // one of Source.KeyComponents
	// Description is the provider's own one-line explanation of what the
	// component covers ("Performance of git clones, pulls, pushes...").
	Description string `json:"description,omitempty"`
}

// Incident is an unresolved incident or an unfinished scheduled maintenance.
type Incident struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Status         string   `json:"status"` // investigating | identified | monitoring | scheduled | in_progress ...
	Impact         string   `json:"impact"`
	Severity       Severity `json:"severity"`
	URL            string   `json:"url"`
	StartedAt      string   `json:"startedAt,omitempty"`
	ScheduledFor   string   `json:"scheduledFor,omitempty"`
	ScheduledUntil string   `json:"scheduledUntil,omitempty"`
	// LatestUpdate is the most recent incident update, HTML stripped.
	LatestUpdate   string `json:"latestUpdate,omitempty"`
	LatestUpdateAt string `json:"latestUpdateAt,omitempty"`
	// Components are the affected component names.
	Components []string `json:"components,omitempty"`
	// AffectsKey is true when at least one affected component is a key
	// component for this source.
	AffectsKey bool `json:"affectsKey"`
}

// Snapshot is the projected, UI-ready view of one source at one point in time.
type Snapshot struct {
	SourceID    string `json:"sourceId"`
	DisplayName string `json:"displayName"`
	PageURL     string `json:"pageUrl"`

	// Overall is the severity every surface colors off. It is computed from
	// the key components and from unresolved incidents that touch a key
	// component — deliberately NOT from Indicator, so an outage confined to
	// Copilot or Codespaces never turns this chip red.
	Overall Severity `json:"overall"`
	// Indicator/Description carry GitHub's own page-level rollup for context
	// ("Partial System Outage"). Display only; never drives loudness.
	Indicator            Severity `json:"indicator"`
	IndicatorRaw         string   `json:"indicatorRaw"`
	IndicatorDescription string   `json:"indicatorDescription"`

	KeyComponents   []Component `json:"keyComponents"`
	OtherComponents []Component `json:"otherComponents"`
	Incidents       []Incident  `json:"incidents"`
	Maintenances    []Incident  `json:"maintenances"`

	// PageUpdatedAt is the provider's own "last updated" stamp.
	PageUpdatedAt string `json:"pageUpdatedAt,omitempty"`
}

// noiseComponentPattern matches the placeholder rows Statuspage pages carry
// that are not services at all ("Visit www.githubstatus.com for more
// information"). They are also flagged showcase:false, which is the signal
// actually used; this is the belt to that suspenders.
var noiseComponentPattern = regexp.MustCompile(`(?i)^visit .*for more information$`)

// parseSummary projects a raw summary.json body onto a Snapshot for the given
// source. It fails only on malformed JSON — a payload with unexpected status
// strings or missing sections still yields a usable snapshot.
func parseSummary(src Source, body []byte) (*Snapshot, error) {
	var raw rawSummary
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("parse %s summary: %w", src.ID, err)
	}

	keyOrder := make(map[string]int, len(src.KeyComponents))
	for i, name := range src.KeyComponents {
		keyOrder[strings.ToLower(name)] = i
	}

	snap := &Snapshot{
		SourceID:             src.ID,
		DisplayName:          src.DisplayName,
		PageURL:              src.PageURL,
		IndicatorRaw:         strings.ToLower(strings.TrimSpace(raw.Status.Indicator)),
		Indicator:            severityFromIndicator(raw.Status.Indicator),
		IndicatorDescription: strings.TrimSpace(raw.Status.Description),
		PageUpdatedAt:        raw.Page.UpdatedAt,
		KeyComponents:        []Component{},
		OtherComponents:      []Component{},
		Incidents:            []Incident{},
		Maintenances:         []Incident{},
	}
	if snap.IndicatorRaw == "" {
		snap.IndicatorRaw = "none"
	}

	// Components. Groups and non-showcase placeholder rows are dropped.
	type keyed struct {
		order int
		comp  Component
	}
	var keyComps []keyed
	for _, rc := range raw.Components {
		name := strings.TrimSpace(rc.Name)
		if name == "" || rc.Group {
			continue
		}
		if !rc.Showcase || noiseComponentPattern.MatchString(name) {
			continue
		}
		comp := Component{
			Name:        name,
			Status:      strings.ToLower(strings.TrimSpace(rc.Status)),
			Severity:    severityFromComponentStatus(rc.Status),
			Description: strings.TrimSpace(rc.Description),
		}
		if order, ok := keyOrder[strings.ToLower(name)]; ok {
			comp.Key = true
			keyComps = append(keyComps, keyed{order: order, comp: comp})
			continue
		}
		snap.OtherComponents = append(snap.OtherComponents, comp)
	}
	// Key components render in the order the source declares, not the order
	// the provider's page happens to publish them.
	sort.SliceStable(keyComps, func(i, j int) bool { return keyComps[i].order < keyComps[j].order })
	for _, k := range keyComps {
		snap.KeyComponents = append(snap.KeyComponents, k.comp)
	}

	keyNames := make(map[string]bool, len(src.KeyComponents))
	for _, name := range src.KeyComponents {
		keyNames[strings.ToLower(name)] = true
	}

	for _, ri := range raw.Incidents {
		snap.Incidents = append(snap.Incidents, projectIncident(ri, keyNames))
	}
	for _, rm := range raw.ScheduledMaintenances {
		snap.Maintenances = append(snap.Maintenances, projectIncident(rm, keyNames))
	}

	snap.Overall = computeOverall(snap)
	return snap, nil
}

// projectIncident flattens one raw incident/maintenance into the UI shape.
func projectIncident(ri rawIncident, keyNames map[string]bool) Incident {
	inc := Incident{
		ID:             ri.ID,
		Name:           strings.TrimSpace(ri.Name),
		Status:         strings.ToLower(strings.TrimSpace(ri.Status)),
		Impact:         strings.ToLower(strings.TrimSpace(ri.Impact)),
		Severity:       severityFromImpact(ri.Impact),
		URL:            ri.Shortlink,
		StartedAt:      ri.StartedAt,
		ScheduledFor:   ri.ScheduledFor,
		ScheduledUntil: ri.ScheduledUntil,
	}
	for _, c := range ri.Components {
		name := strings.TrimSpace(c.Name)
		if name == "" {
			continue
		}
		inc.Components = append(inc.Components, name)
		if keyNames[strings.ToLower(name)] {
			inc.AffectsKey = true
		}
	}
	// Statuspage returns incident_updates newest-first, but that is not
	// contractual — pick by display_at/created_at instead of trusting order.
	var newest *rawUpdate
	var newestAt time.Time
	for i := range ri.IncidentUpdates {
		u := &ri.IncidentUpdates[i]
		at := parseTime(firstNonEmpty(u.DisplayAt, u.CreatedAt))
		if newest == nil || at.After(newestAt) {
			newest, newestAt = u, at
		}
	}
	if newest != nil {
		inc.LatestUpdate = stripHTML(newest.Body)
		inc.LatestUpdateAt = firstNonEmpty(newest.DisplayAt, newest.CreatedAt)
	}
	return inc
}

// computeOverall derives the severity that drives every visual surface.
//
// Two contributors, both restricted to what a kandev user actually depends on:
//   - the key components' own statuses, and
//   - unresolved incidents that name a key component (GitHub often opens an
//     incident minutes before it flips the component status).
//
// Non-key components (Copilot, Codespaces, Packages, Pages) and the page-level
// indicator never escalate. In-progress maintenance contributes only the quiet
// SeverityMaintenance level.
func computeOverall(snap *Snapshot) Severity {
	overall := SeverityOperational
	for _, c := range snap.KeyComponents {
		if c.Severity > overall {
			overall = c.Severity
		}
	}
	for _, inc := range snap.Incidents {
		if inc.AffectsKey && inc.Severity > overall {
			overall = inc.Severity
		}
	}
	for _, m := range snap.Maintenances {
		if m.AffectsKey && m.Status == "in_progress" && overall < SeverityMaintenance {
			overall = SeverityMaintenance
		}
	}
	return overall
}

// ---- small helpers ---------------------------------------------------------

var (
	brPattern  = regexp.MustCompile(`(?i)<br\s*/?>`)
	tagPattern = regexp.MustCompile(`<[^>]*>`)
	wsPattern  = regexp.MustCompile(`[ \t]+`)
)

// stripHTML turns an incident update body into plain text. Statuspage bodies
// carry real HTML (`<br />` is routine, links appear occasionally), and the UI
// renders them as text — so the markup has to come out here rather than being
// injected into the DOM downstream.
func stripHTML(s string) string {
	s = brPattern.ReplaceAllString(s, "\n")
	s = tagPattern.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = wsPattern.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	out := lines[:0]
	for _, line := range lines {
		out = append(out, strings.TrimSpace(line))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// parseTime is a lenient RFC3339 parse; an unparseable stamp sorts oldest.
func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
