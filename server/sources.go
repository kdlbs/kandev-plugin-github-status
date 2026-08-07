package main

// sources.go is the config-driven provider list. Every service in this list
// is a Statuspage instance (https://<page>/api/v2/summary.json), so adding
// GitLab, npm, Anthropic, or any other Statuspage-backed provider later is a
// data change here — not a rewrite of the fetch/parse/transition pipeline.
//
// Ship state: GitHub is the only enabled source. The plugin deliberately does
// not enable others; that is a product decision, not a config toggle to flip
// unilaterally.

// Source describes one Statuspage-backed provider.
type Source struct {
	// ID is the stable identifier used in the JSON payload and in Host state
	// keys. Keep it lowercase and URL-safe.
	ID string
	// DisplayName is what the chip, banner, and modal render.
	DisplayName string
	// SummaryURL returns components + unresolved incidents + scheduled
	// maintenances in one call, which is everything this plugin needs.
	SummaryURL string
	// PageURL is the human status page linked from the modal.
	PageURL string
	// KeyComponents are the components that matter to a kandev user, in the
	// order they should be rendered. Everything else the page publishes is
	// still reported, but de-emphasized and never allowed to escalate the
	// overall severity — a Copilot outage should not turn this chip red.
	//
	// Matched case-insensitively against the Statuspage component name.
	KeyComponents []string
	// Enabled gates whether the poller fetches this source at all.
	Enabled bool
}

// sources is the full provider table. Only enabled entries are polled.
var sources = []Source{
	{
		ID:          "github",
		DisplayName: "GitHub",
		SummaryURL:  "https://www.githubstatus.com/api/v2/summary.json",
		PageURL:     "https://www.githubstatus.com",
		KeyComponents: []string{
			"Git Operations",
			"API Requests",
			"Webhooks",
			"Actions",
			"Pull Requests",
			"Issues",
		},
		Enabled: true,
	},
}

// enabledSources returns the sources the poller should fetch.
func enabledSources() []Source {
	out := make([]Source, 0, len(sources))
	for _, s := range sources {
		if s.Enabled {
			out = append(out, s)
		}
	}
	return out
}

// primarySource is the source the single-provider UI surfaces (chip, banner,
// toast) render. It is the first enabled source; when a second provider is
// ever enabled the UI has to grow a per-source list, which is exactly the
// seam this function marks.
func primarySource() (Source, bool) {
	enabled := enabledSources()
	if len(enabled) == 0 {
		return Source{}, false
	}
	return enabled[0], true
}
