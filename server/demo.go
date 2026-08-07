package main

import (
	"embed"
	"fmt"
	"sort"
	"strings"
	"time"
)

// demo.go serves the fixture states. GitHub is up almost all of the time, so
// the degraded/outage/maintenance UI is otherwise unreachable — these
// fixtures are how those states get built, reviewed, and screenshotted, and
// the same files are the inputs to statuspage_test.go.
//
// Reach them with ?demo=<name> on the status webhook, e.g.
//   /api/plugins/kandev-plugin-github-status/webhooks/status?demo=incident

//go:embed fixtures/*.json
var fixtureFS embed.FS

// fixtureFiles maps a demo name to its summary.json fixture. Several names
// can share a file when they differ only in transport state (stale).
var fixtureFiles = map[string]string{
	"healthy":     "healthy.json",
	"degraded":    "degraded.json",
	"incident":    "incident.json",
	"critical":    "critical.json",
	"maintenance": "maintenance.json",
	"stale":       "degraded.json",
}

// fixtureIsStale reports whether a demo name should additionally be rendered
// as a cached-but-stale response.
func fixtureIsStale(name string) bool { return name == "stale" }

// fixtureNames lists the available demo names, sorted, for error messages.
func fixtureNames() []string {
	names := make([]string, 0, len(fixtureFiles))
	for name := range fixtureFiles {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// loadFixtureSnapshot parses a fixture through the exact same code path the
// live poller uses, so a fixture can never drift into shapes the real parser
// would reject.
func loadFixtureSnapshot(src Source, name string) (*Snapshot, error) {
	file, ok := fixtureFiles[name]
	if !ok {
		return nil, fmt.Errorf("unknown demo fixture %q (have: %s)", name, strings.Join(fixtureNames(), ", "))
	}
	body, err := fixtureFS.ReadFile("fixtures/" + file)
	if err != nil {
		return nil, fmt.Errorf("read fixture %s: %w", file, err)
	}
	return parseSummary(src, body)
}

// demoTransition fabricates the transition a fixture would have produced, so
// the toast is visible in demo mode too. It is derived from the fixture's own
// severity rather than hardcoded, which keeps the demo honest: a healthy
// fixture shows a recovery toast, a degraded one shows a degradation toast.
func demoTransition(src Source, snap *Snapshot, now time.Time) *Transition {
	if snap == nil {
		return nil
	}
	from := SeverityOperational
	if !snap.Overall.Loud() {
		// Recovering from something; pick the loudest plausible predecessor.
		from = SeverityMajor
	}
	return detectTransition(src, Baseline{Known: true, Severity: from}, snap, now)
}
