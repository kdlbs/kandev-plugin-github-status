package main

import (
	"testing"
	"time"
)

// transition_test.go covers the "only notify on change" rule. The headline
// case is TestDetectTransition_RepeatedIdenticalPollDoesNotRenotify: a poller
// that re-toasts every 60s during a two-hour outage is the failure mode this
// whole file exists to prevent.

var testNow = time.Date(2026, 8, 7, 22, 0, 0, 0, time.UTC)

// snapshotAt builds a snapshot whose overall severity is exactly sev, by way
// of a key component carrying it — so the tests exercise computeOverall
// rather than assigning Overall by hand.
func snapshotAt(t *testing.T, sev Severity) *Snapshot {
	t.Helper()
	status := map[Severity]string{
		SeverityOperational: "operational",
		SeverityMaintenance: "under_maintenance",
		SeverityMinor:       "degraded_performance",
		SeverityMajor:       "partial_outage",
		SeverityCritical:    "major_outage",
	}[sev]
	snap := &Snapshot{
		SourceID:    "github",
		DisplayName: "GitHub",
		KeyComponents: []Component{
			{Name: "Git Operations", Status: "operational", Severity: SeverityOperational, Key: true},
			{Name: "Actions", Status: status, Severity: sev, Key: true},
		},
	}
	snap.Overall = computeOverall(snap)
	if snap.Overall != sev {
		t.Fatalf("snapshotAt(%v) produced Overall=%v", sev, snap.Overall)
	}
	return snap
}

// THE regression test. A steady-state outage polled every 60s must produce
// exactly one notification, not one per poll.
func TestDetectTransition_RepeatedIdenticalPollDoesNotRenotify(t *testing.T) {
	src := testSource(t)
	baseline := Baseline{Known: true, Severity: SeverityOperational}

	first := detectTransition(src, baseline, snapshotAt(t, SeverityMajor), testNow)
	if first == nil {
		t.Fatal("first degradation must notify")
	}

	// Ten more identical polls, each rebasing off the previous poll's result
	// exactly as the poller does.
	baseline = baselineFrom(snapshotAt(t, SeverityMajor))
	for i := 0; i < 10; i++ {
		at := testNow.Add(time.Duration(i+1) * time.Minute)
		if got := detectTransition(src, baseline, snapshotAt(t, SeverityMajor), at); got != nil {
			t.Fatalf("poll %d re-notified: %+v", i+1, got)
		}
		baseline = baselineFrom(snapshotAt(t, SeverityMajor))
	}
}

// Same severity, but the incident text, component list, and timestamps all
// changed. Still not a notification — GitHub posts an update every ~20
// minutes during a long incident.
func TestDetectTransition_IncidentUpdateAtSameSeverityDoesNotNotify(t *testing.T) {
	src := testSource(t)
	baseline := Baseline{Known: true, Severity: SeverityMajor}

	snap := snapshotAt(t, SeverityMajor)
	snap.Incidents = []Incident{{
		ID: "i1", Name: "Incident with Git Operations", Status: "identified",
		Impact: "major", Severity: SeverityMajor, AffectsKey: true,
		LatestUpdate: "We have identified the cause.", LatestUpdateAt: "2026-08-07T21:40:00Z",
	}}
	if got := detectTransition(src, baseline, snap, testNow); got != nil {
		t.Errorf("incident-text-only change notified: %+v", got)
	}

	snap.Incidents[0].Status = "monitoring"
	snap.Incidents[0].LatestUpdate = "A fix has been applied and we are monitoring."
	snap.Incidents[0].LatestUpdateAt = "2026-08-07T22:10:00Z"
	if got := detectTransition(src, baseline, snap, testNow.Add(time.Hour)); got != nil {
		t.Errorf("later incident update notified: %+v", got)
	}
}

// The very first successful poll has nothing to compare against. Notifying
// here would toast "GitHub is degraded" at every backend start during an
// outage the user has been watching for an hour.
func TestDetectTransition_FirstPollNeverNotifies(t *testing.T) {
	src := testSource(t)
	for _, sev := range []Severity{SeverityOperational, SeverityMinor, SeverityMajor, SeverityCritical} {
		if got := detectTransition(src, Baseline{}, snapshotAt(t, sev), testNow); got != nil {
			t.Errorf("first poll at %v notified: %+v", sev, got)
		}
	}
}

func TestDetectTransition_Kinds(t *testing.T) {
	src := testSource(t)
	cases := []struct {
		name string
		from Severity
		to   Severity
		want TransitionKind
	}{
		{"healthy to minor", SeverityOperational, SeverityMinor, TransitionDegraded},
		{"healthy to critical", SeverityOperational, SeverityCritical, TransitionDegraded},
		{"maintenance to minor", SeverityMaintenance, SeverityMinor, TransitionDegraded},
		{"minor to healthy", SeverityMinor, SeverityOperational, TransitionRecovered},
		{"critical to maintenance", SeverityCritical, SeverityMaintenance, TransitionRecovered},
		{"minor to major", SeverityMinor, SeverityMajor, TransitionEscalated},
		{"major to critical", SeverityMajor, SeverityCritical, TransitionEscalated},
		{"critical to minor", SeverityCritical, SeverityMinor, TransitionImproved},
		{"major to minor", SeverityMajor, SeverityMinor, TransitionImproved},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectTransition(src, Baseline{Known: true, Severity: tc.from}, snapshotAt(t, tc.to), testNow)
			if got == nil {
				t.Fatalf("%v -> %v did not notify", tc.from, tc.to)
			}
			if got.Kind != tc.want {
				t.Errorf("Kind = %q, want %q", got.Kind, tc.want)
			}
			if got.From != tc.from || got.To != tc.to {
				t.Errorf("From/To = %v/%v, want %v/%v", got.From, got.To, tc.from, tc.to)
			}
			if got.Title == "" {
				t.Error("Title is empty")
			}
			if got.At != testNow.Format(time.RFC3339) {
				t.Errorf("At = %q", got.At)
			}
		})
	}
}

// Planned maintenance starting or ending is not an incident. Crossing between
// operational and maintenance must stay silent in both directions.
func TestDetectTransition_QuietBandChangesDoNotNotify(t *testing.T) {
	src := testSource(t)
	if got := detectTransition(src, Baseline{Known: true, Severity: SeverityOperational}, snapshotAt(t, SeverityMaintenance), testNow); got != nil {
		t.Errorf("operational -> maintenance notified: %+v", got)
	}
	if got := detectTransition(src, Baseline{Known: true, Severity: SeverityMaintenance}, snapshotAt(t, SeverityOperational), testNow); got != nil {
		t.Errorf("maintenance -> operational notified: %+v", got)
	}
}

func TestDetectTransition_NilSnapshot(t *testing.T) {
	if got := detectTransition(testSource(t), Baseline{Known: true, Severity: SeverityMajor}, nil, testNow); got != nil {
		t.Errorf("nil snapshot notified: %+v", got)
	}
}

// The transition ID must depend only on (source, from, to) — not on the
// clock. Two deliveries of the same change must present the same ID so an
// acknowledged toast stays acknowledged.
func TestTransitionID_IsStableAcrossTimeAndDistinctPerChange(t *testing.T) {
	src := testSource(t)
	base := Baseline{Known: true, Severity: SeverityOperational}

	a := detectTransition(src, base, snapshotAt(t, SeverityMajor), testNow)
	b := detectTransition(src, base, snapshotAt(t, SeverityMajor), testNow.Add(3*time.Hour))
	if a.ID != b.ID {
		t.Errorf("same change produced different IDs: %q vs %q", a.ID, b.ID)
	}

	c := detectTransition(src, base, snapshotAt(t, SeverityMinor), testNow)
	if a.ID == c.ID {
		t.Errorf("different changes share an ID: %q", a.ID)
	}

	d := detectTransition(src, Baseline{Known: true, Severity: SeverityMajor}, snapshotAt(t, SeverityOperational), testNow)
	if d.ID == a.ID {
		t.Errorf("degradation and recovery share an ID: %q", a.ID)
	}
}

// The toast has to say what broke, otherwise the user opens the modal anyway.
func TestTransitionDetail_NamesTheAffectedThing(t *testing.T) {
	src := testSource(t)

	// With an incident, prefer its title.
	snap := snapshotAt(t, SeverityMajor)
	snap.Incidents = []Incident{{ID: "i1", Name: "Incident with Git Operations", AffectsKey: true}}
	got := detectTransition(src, Baseline{Known: true, Severity: SeverityOperational}, snap, testNow)
	if got.Detail != "Incident with Git Operations" {
		t.Errorf("Detail = %q, want the incident title", got.Detail)
	}

	// Without one, list the affected key components.
	bare := snapshotAt(t, SeverityMajor)
	got = detectTransition(src, Baseline{Known: true, Severity: SeverityOperational}, bare, testNow)
	if got.Detail != "Actions" {
		t.Errorf("Detail = %q, want %q", got.Detail, "Actions")
	}

	// A recovery says so rather than listing nothing.
	rec := detectTransition(src, Baseline{Known: true, Severity: SeverityMajor}, snapshotAt(t, SeverityOperational), testNow)
	if rec.Detail == "" {
		t.Error("recovery Detail is empty")
	}
}

// Baseline round-trips through Host state as JSON. The stored form must be
// severity *names*, so reordering the Severity constants can never silently
// reinterpret a stored baseline.
func TestBaselineStateRoundTrip(t *testing.T) {
	for _, sev := range []Severity{SeverityOperational, SeverityMaintenance, SeverityMinor, SeverityMajor, SeverityCritical} {
		in := Baseline{Known: true, Severity: sev, SeverityName: sev.String()}
		out := baselineFromState(in.toState())
		if out != in {
			t.Errorf("round trip of %v = %+v, want %+v", sev, out, in)
		}
	}
}

func TestBaselineFromState_UnusableValues(t *testing.T) {
	cases := map[string]map[string]any{
		"nil":              nil,
		"empty":            {},
		"not known":        {"known": false, "severityName": "major"},
		"unknown severity": {"known": true, "severityName": "apocalyptic"},
		"missing name":     {"known": true},
	}
	for name, value := range cases {
		if got := baselineFromState(value); got.Known {
			t.Errorf("%s: baselineFromState = %+v, want an unknown baseline", name, got)
		}
	}
}
