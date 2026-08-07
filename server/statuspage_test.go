package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testSource is the shipped GitHub source; the fixtures are GitHub payloads,
// so the key-component list has to be the real one.
func testSource(t *testing.T) Source {
	t.Helper()
	src, ok := primarySource()
	if !ok {
		t.Fatal("primarySource(): no enabled source")
	}
	return src
}

func parseFixture(t *testing.T, name string) *Snapshot {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("fixtures", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	snap, err := parseSummary(testSource(t), body)
	if err != nil {
		t.Fatalf("parseSummary(%s): %v", name, err)
	}
	return snap
}

func TestParseSummary_HealthyFixture(t *testing.T) {
	snap := parseFixture(t, "healthy.json")

	if snap.Overall != SeverityOperational {
		t.Errorf("Overall = %v, want operational", snap.Overall)
	}
	if snap.Overall.Loud() {
		t.Error("healthy snapshot must not be loud")
	}
	if snap.IndicatorRaw != "none" {
		t.Errorf("IndicatorRaw = %q, want none", snap.IndicatorRaw)
	}
	if snap.IndicatorDescription != "All Systems Operational" {
		t.Errorf("IndicatorDescription = %q", snap.IndicatorDescription)
	}
	if len(snap.Incidents) != 0 || len(snap.Maintenances) != 0 {
		t.Errorf("expected no incidents/maintenances, got %d/%d", len(snap.Incidents), len(snap.Maintenances))
	}
}

// The six components a kandev user actually depends on must come back in the
// declared order, flagged Key, regardless of the order the page publishes.
func TestParseSummary_KeyComponentsAreOrderedAndComplete(t *testing.T) {
	snap := parseFixture(t, "healthy.json")

	want := []string{"Git Operations", "API Requests", "Webhooks", "Actions", "Pull Requests", "Issues"}
	if len(snap.KeyComponents) != len(want) {
		t.Fatalf("KeyComponents = %d entries, want %d: %+v", len(snap.KeyComponents), len(want), snap.KeyComponents)
	}
	for i, name := range want {
		if snap.KeyComponents[i].Name != name {
			t.Errorf("KeyComponents[%d] = %q, want %q", i, snap.KeyComponents[i].Name, name)
		}
		if !snap.KeyComponents[i].Key {
			t.Errorf("KeyComponents[%d] (%s) not flagged Key", i, name)
		}
	}
	for _, c := range snap.OtherComponents {
		if c.Key {
			t.Errorf("OtherComponents contains a Key component: %s", c.Name)
		}
	}
}

// The GitHub page carries a non-service placeholder row ("Visit
// www.githubstatus.com for more information"). Rendering it as a component
// would be nonsense, so it must be dropped.
func TestParseSummary_DropsPlaceholderComponents(t *testing.T) {
	snap := parseFixture(t, "healthy.json")
	for _, c := range append(append([]Component{}, snap.KeyComponents...), snap.OtherComponents...) {
		if strings.HasPrefix(strings.ToLower(c.Name), "visit ") {
			t.Errorf("placeholder component survived parsing: %q", c.Name)
		}
	}
}

func TestParseSummary_DegradedFixture(t *testing.T) {
	snap := parseFixture(t, "degraded.json")

	if snap.Overall != SeverityMinor {
		t.Errorf("Overall = %v, want minor", snap.Overall)
	}
	if !snap.Overall.Loud() {
		t.Error("a minor degradation of a key component must be loud")
	}
	actions := findComponent(t, snap.KeyComponents, "Actions")
	if actions.Status != "degraded_performance" || actions.Severity != SeverityMinor {
		t.Errorf("Actions = %+v, want degraded_performance/minor", actions)
	}
	if len(snap.Incidents) != 1 {
		t.Fatalf("Incidents = %d, want 1", len(snap.Incidents))
	}
	inc := snap.Incidents[0]
	if !inc.AffectsKey {
		t.Error("incident naming Actions must be flagged AffectsKey")
	}
	if inc.Status != "investigating" || inc.Impact != "minor" {
		t.Errorf("incident status/impact = %q/%q", inc.Status, inc.Impact)
	}
}

func TestParseSummary_IncidentFixtureEscalatesToMajor(t *testing.T) {
	snap := parseFixture(t, "incident.json")

	// partial_outage is the worst key-component status in this fixture, and
	// it maps to major — the same rollup Statuspage itself uses.
	if snap.Overall != SeverityMajor {
		t.Errorf("Overall = %v, want major", snap.Overall)
	}
	git := findComponent(t, snap.KeyComponents, "Git Operations")
	if git.Severity != SeverityMajor {
		t.Errorf("Git Operations severity = %v, want major", git.Severity)
	}
}

func TestParseSummary_CriticalFixture(t *testing.T) {
	snap := parseFixture(t, "critical.json")
	if snap.Overall != SeverityCritical {
		t.Errorf("Overall = %v, want critical", snap.Overall)
	}
	if snap.Indicator != SeverityCritical {
		t.Errorf("Indicator = %v, want critical", snap.Indicator)
	}
}

// Planned maintenance must stay quiet: it is reported, but it never crosses
// the loud boundary that drives the banner and the toast.
func TestParseSummary_MaintenanceIsQuiet(t *testing.T) {
	snap := parseFixture(t, "maintenance.json")

	if snap.Overall.Loud() {
		t.Errorf("Overall = %v; scheduled maintenance must not be loud", snap.Overall)
	}
	if len(snap.Maintenances) != 2 {
		t.Fatalf("Maintenances = %d, want 2", len(snap.Maintenances))
	}
	var upcoming, running *Incident
	for i := range snap.Maintenances {
		switch snap.Maintenances[i].Status {
		case "scheduled":
			upcoming = &snap.Maintenances[i]
		case "in_progress":
			running = &snap.Maintenances[i]
		}
	}
	if upcoming == nil || upcoming.ScheduledFor == "" || upcoming.ScheduledUntil == "" {
		t.Fatalf("upcoming maintenance missing schedule window: %+v", upcoming)
	}
	if running == nil {
		t.Fatal("expected an in-progress maintenance")
	}
	// The in-progress window touches Codespaces, not a key component, so it
	// must not even reach the quiet maintenance level.
	if snap.Overall != SeverityOperational {
		t.Errorf("Overall = %v; maintenance on a non-key component must not move it", snap.Overall)
	}
}

// A non-key component going down (Copilot, Codespaces, Packages, Pages) must
// never turn the chip red — that is the entire point of the key-component
// list.
func TestComputeOverall_IgnoresNonKeyComponents(t *testing.T) {
	src := testSource(t)
	body := []byte(`{
	  "components": [
	    {"name":"Git Operations","status":"operational","showcase":true},
	    {"name":"Copilot","status":"major_outage","showcase":true},
	    {"name":"Codespaces","status":"partial_outage","showcase":true}
	  ],
	  "incidents": [],
	  "scheduled_maintenances": [],
	  "status": {"indicator":"major","description":"Partial System Outage"}
	}`)
	snap, err := parseSummary(src, body)
	if err != nil {
		t.Fatalf("parseSummary: %v", err)
	}
	if snap.Overall != SeverityOperational {
		t.Errorf("Overall = %v, want operational (only non-key components are down)", snap.Overall)
	}
	// The page-level rollup is still reported, just not obeyed.
	if snap.Indicator != SeverityMajor {
		t.Errorf("Indicator = %v, want major", snap.Indicator)
	}
}

// GitHub routinely opens an incident minutes before it flips the component
// status. An unresolved incident naming a key component must escalate on its
// own.
func TestComputeOverall_IncidentEscalatesBeforeComponentsFlip(t *testing.T) {
	src := testSource(t)
	body := []byte(`{
	  "components": [{"name":"Git Operations","status":"operational","showcase":true}],
	  "incidents": [{
	    "id":"x","name":"Investigating push failures","status":"investigating","impact":"major",
	    "components":[{"id":"c1","name":"Git Operations"}],
	    "incident_updates":[]
	  }],
	  "scheduled_maintenances": [],
	  "status": {"indicator":"major","description":"Partial System Outage"}
	}`)
	snap, err := parseSummary(src, body)
	if err != nil {
		t.Fatalf("parseSummary: %v", err)
	}
	if snap.Overall != SeverityMajor {
		t.Errorf("Overall = %v, want major", snap.Overall)
	}
}

// The same incident on a non-key component must not escalate.
func TestComputeOverall_IncidentOnNonKeyComponentDoesNotEscalate(t *testing.T) {
	src := testSource(t)
	body := []byte(`{
	  "components": [{"name":"Copilot","status":"operational","showcase":true}],
	  "incidents": [{
	    "id":"x","name":"Copilot is slow","status":"investigating","impact":"critical",
	    "components":[{"id":"c1","name":"Copilot"}],
	    "incident_updates":[]
	  }],
	  "scheduled_maintenances": [],
	  "status": {"indicator":"critical","description":"Major Service Outage"}
	}`)
	snap, err := parseSummary(src, body)
	if err != nil {
		t.Fatalf("parseSummary: %v", err)
	}
	if snap.Overall != SeverityOperational {
		t.Errorf("Overall = %v, want operational", snap.Overall)
	}
}

// Incident update bodies are real HTML. The UI renders them as text, so the
// markup has to be gone by the time it leaves the backend.
func TestParseSummary_StripsHTMLFromIncidentUpdates(t *testing.T) {
	snap := parseFixture(t, "incident.json")
	inc := snap.Incidents[0]
	if inc.LatestUpdate == "" {
		t.Fatal("LatestUpdate is empty")
	}
	if strings.Contains(inc.LatestUpdate, "<") || strings.Contains(inc.LatestUpdate, "&amp;") {
		t.Errorf("LatestUpdate still contains markup: %q", inc.LatestUpdate)
	}
	if !strings.Contains(inc.LatestUpdate, "shared storage tier") {
		t.Errorf("LatestUpdate lost its text: %q", inc.LatestUpdate)
	}
}

// Statuspage returns updates newest-first today, but that is not contractual.
// The latest update must be picked by timestamp.
func TestProjectIncident_PicksNewestUpdateByTimestamp(t *testing.T) {
	src := testSource(t)
	body := []byte(`{
	  "components": [{"name":"Actions","status":"degraded_performance","showcase":true}],
	  "incidents": [{
	    "id":"x","name":"Slow","status":"investigating","impact":"minor",
	    "components":[{"id":"c1","name":"Actions"}],
	    "incident_updates":[
	      {"id":"old","status":"investigating","body":"first","display_at":"2026-08-07T10:00:00Z"},
	      {"id":"new","status":"identified","body":"second","display_at":"2026-08-07T12:00:00Z"},
	      {"id":"mid","status":"investigating","body":"middle","display_at":"2026-08-07T11:00:00Z"}
	    ]
	  }],
	  "scheduled_maintenances": [],
	  "status": {"indicator":"minor","description":"Minor Service Outage"}
	}`)
	snap, err := parseSummary(src, body)
	if err != nil {
		t.Fatalf("parseSummary: %v", err)
	}
	if got := snap.Incidents[0].LatestUpdate; got != "second" {
		t.Errorf("LatestUpdate = %q, want %q", got, "second")
	}
	if got := snap.Incidents[0].LatestUpdateAt; got != "2026-08-07T12:00:00Z" {
		t.Errorf("LatestUpdateAt = %q", got)
	}
}

func TestSeverityMapping(t *testing.T) {
	componentCases := map[string]Severity{
		"operational":          SeverityOperational,
		"degraded_performance": SeverityMinor,
		"partial_outage":       SeverityMajor,
		"major_outage":         SeverityCritical,
		"under_maintenance":    SeverityMaintenance,
		"":                     SeverityOperational,
		// A status Statuspage has not invented yet must degrade to
		// operational, not paint the UI red.
		"some_future_status": SeverityOperational,
	}
	for status, want := range componentCases {
		if got := severityFromComponentStatus(status); got != want {
			t.Errorf("severityFromComponentStatus(%q) = %v, want %v", status, got, want)
		}
	}

	indicatorCases := map[string]Severity{
		"none":     SeverityOperational,
		"minor":    SeverityMinor,
		"major":    SeverityMajor,
		"critical": SeverityCritical,
		"":         SeverityOperational,
	}
	for indicator, want := range indicatorCases {
		if got := severityFromIndicator(indicator); got != want {
			t.Errorf("severityFromIndicator(%q) = %v, want %v", indicator, got, want)
		}
	}
}

func TestSeverityLoudBoundary(t *testing.T) {
	quiet := []Severity{SeverityOperational, SeverityMaintenance}
	loud := []Severity{SeverityMinor, SeverityMajor, SeverityCritical}
	for _, s := range quiet {
		if s.Loud() {
			t.Errorf("%v must be quiet", s)
		}
	}
	for _, s := range loud {
		if !s.Loud() {
			t.Errorf("%v must be loud", s)
		}
	}
}

func TestSeverityMarshalsAsName(t *testing.T) {
	b, err := SeverityMajor.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if string(b) != `"major"` {
		t.Errorf("MarshalJSON = %s, want \"major\"", b)
	}
}

func TestStripHTML(t *testing.T) {
	cases := map[string]string{
		"plain text":                     "plain text",
		"one<br />two":                   "one\ntwo",
		"one<br/><br/>two":               "one\n\ntwo",
		"HTTPS &amp; SSH":                "HTTPS & SSH",
		`see <a href="http://x">x</a>`:   "see x",
		"  padded  <br /> lines   here ": "padded\nlines here",
	}
	for in, want := range cases {
		if got := stripHTML(in); got != want {
			t.Errorf("stripHTML(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseSummary_RejectsMalformedJSON(t *testing.T) {
	if _, err := parseSummary(testSource(t), []byte("not json")); err == nil {
		t.Error("expected an error for malformed JSON")
	}
}

// An empty-but-valid body must not panic and must read as operational, so a
// provider serving a stub during their own incident cannot crash the plugin.
func TestParseSummary_EmptyObject(t *testing.T) {
	snap, err := parseSummary(testSource(t), []byte(`{}`))
	if err != nil {
		t.Fatalf("parseSummary: %v", err)
	}
	if snap.Overall != SeverityOperational || snap.IndicatorRaw != "none" {
		t.Errorf("snapshot = %+v", snap)
	}
	if snap.KeyComponents == nil || snap.Incidents == nil {
		t.Error("slices must be non-nil so the UI never sees JSON null")
	}
}

func findComponent(t *testing.T, comps []Component, name string) Component {
	t.Helper()
	for _, c := range comps {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("component %q not found in %+v", name, comps)
	return Component{}
}
