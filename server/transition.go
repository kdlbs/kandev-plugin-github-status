package main

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// transition.go owns the "only notify on change" rule. It is deliberately a
// pure function over (baseline, snapshot): the poller supplies the clock and
// the persistence, so every branch here is directly testable.

// Baseline is the last state a notification decision was made against. It is
// persisted in Host state so a plugin restart does not replay a toast the user
// has already seen.
type Baseline struct {
	// Known is false before the first successful poll ever observed by this
	// install. The first poll establishes the baseline and never notifies —
	// otherwise every backend start would toast "GitHub is degraded" at a
	// user who has been staring at the degradation for an hour.
	Known bool `json:"known"`
	// Severity is the last overall severity a decision was made against.
	Severity Severity `json:"severity"`
	// SeverityName mirrors Severity as a string so the persisted Host-state
	// JSON stays readable and survives a reordering of the Severity constants.
	SeverityName string `json:"severityName"`
}

// TransitionKind classifies a notify-worthy change.
type TransitionKind string

const (
	// TransitionDegraded — healthy (or quiet maintenance) became loud.
	TransitionDegraded TransitionKind = "degraded"
	// TransitionRecovered — loud became healthy (or quiet maintenance).
	TransitionRecovered TransitionKind = "recovered"
	// TransitionEscalated — already loud, and got worse.
	TransitionEscalated TransitionKind = "escalated"
	// TransitionImproved — already loud, and got better without recovering.
	TransitionImproved TransitionKind = "improved"
)

// Transition is a single user-visible status change, delivered to the UI in
// the status payload and acknowledged by ID once its toast has been shown.
type Transition struct {
	// ID is stable for a given (source, from, to) change and is what the UI
	// acknowledges. It deliberately excludes the timestamp so a duplicate
	// delivery of the same transition cannot produce two distinct toasts.
	ID       string         `json:"id"`
	SourceID string         `json:"sourceId"`
	Kind     TransitionKind `json:"kind"`
	From     Severity       `json:"from"`
	To       Severity       `json:"to"`
	// Title/Detail are the toast copy, assembled here so the notification
	// text is covered by the same tests as the decision to notify.
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	At     string `json:"at"`
}

// detectTransition decides whether moving from prev to snap warrants a
// user-visible notification, and returns the transition when it does.
//
// The rules, in order:
//  1. No baseline yet -> never notify (record only).
//  2. Same overall severity -> never notify. This is the rule that makes a
//     repeated identical poll a no-op, including when the incident text,
//     component list, or timestamps changed underneath.
//  3. A change entirely inside the quiet band (operational <-> maintenance)
//     -> never notify. Planned work is not an incident.
//  4. Otherwise notify, classified by which side of the loud boundary the two
//     severities fall on.
func detectTransition(src Source, prev Baseline, snap *Snapshot, now time.Time) *Transition {
	if snap == nil || !prev.Known {
		return nil
	}
	from, to := prev.Severity, snap.Overall
	if from == to {
		return nil
	}
	if !from.Loud() && !to.Loud() {
		return nil
	}

	kind := TransitionEscalated
	switch {
	case !from.Loud() && to.Loud():
		kind = TransitionDegraded
	case from.Loud() && !to.Loud():
		kind = TransitionRecovered
	case to < from:
		kind = TransitionImproved
	}

	t := &Transition{
		ID:       transitionID(src.ID, from, to),
		SourceID: src.ID,
		Kind:     kind,
		From:     from,
		To:       to,
		Title:    transitionTitle(src, kind, to),
		Detail:   transitionDetail(snap),
		At:       now.UTC().Format(time.RFC3339),
	}
	return t
}

// transitionID hashes the source and the two endpoints. Two polls that report
// the same change produce the same ID, so an already-acknowledged toast stays
// acknowledged.
func transitionID(sourceID string, from, to Severity) string {
	sum := sha1.Sum([]byte(sourceID + "|" + from.String() + "|" + to.String()))
	return hex.EncodeToString(sum[:8])
}

func transitionTitle(src Source, kind TransitionKind, to Severity) string {
	switch kind {
	case TransitionRecovered:
		return fmt.Sprintf("%s is back to normal", src.DisplayName)
	case TransitionEscalated:
		return fmt.Sprintf("%s degradation is getting worse", src.DisplayName)
	case TransitionImproved:
		return fmt.Sprintf("%s is recovering", src.DisplayName)
	default:
		switch to {
		case SeverityCritical:
			return fmt.Sprintf("%s is having a major outage", src.DisplayName)
		case SeverityMajor:
			return fmt.Sprintf("%s has a partial outage", src.DisplayName)
		default:
			return fmt.Sprintf("%s is degraded", src.DisplayName)
		}
	}
}

// transitionDetail names what is actually affected, so the toast answers
// "is it me or is it GitHub?" without needing the modal opened.
func transitionDetail(snap *Snapshot) string {
	if snap == nil {
		return ""
	}
	for _, inc := range snap.Incidents {
		if inc.AffectsKey && inc.Name != "" {
			return inc.Name
		}
	}
	var affected []string
	for _, c := range snap.KeyComponents {
		if c.Severity.Loud() {
			affected = append(affected, c.Name)
		}
	}
	if len(affected) > 0 {
		return strings.Join(affected, ", ")
	}
	if snap.Overall == SeverityOperational {
		return "All key components are operational again."
	}
	return snap.IndicatorDescription
}

// baselineFrom builds the baseline to persist after a successful poll.
func baselineFrom(snap *Snapshot) Baseline {
	if snap == nil {
		return Baseline{}
	}
	return Baseline{Known: true, Severity: snap.Overall, SeverityName: snap.Overall.String()}
}

// ---- Host-state encoding ---------------------------------------------------

// The Host state API stores JSON objects, not typed structs, so the baseline
// round-trips through map[string]any. severityName is the authoritative field
// on read; the numeric ordinal is not persisted, so reordering the Severity
// constants can never silently reinterpret stored state.

func (b Baseline) toState() map[string]any {
	return map[string]any{
		"known":        b.Known,
		"severityName": b.Severity.String(),
	}
}

func baselineFromState(value map[string]any) Baseline {
	if value == nil {
		return Baseline{}
	}
	known, _ := value["known"].(bool)
	if !known {
		return Baseline{}
	}
	name, _ := value["severityName"].(string)
	sev, ok := severityFromName(name)
	if !ok {
		// A stored name this build does not recognize means the baseline is
		// not interpretable; treat it as absent so the next poll re-seeds it
		// rather than notifying against a guess.
		return Baseline{}
	}
	return Baseline{Known: true, Severity: sev, SeverityName: sev.String()}
}

func severityFromName(name string) (Severity, bool) {
	for sev, n := range severityNames {
		if n == name {
			return sev, true
		}
	}
	return SeverityOperational, false
}
