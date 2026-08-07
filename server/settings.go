package main

import (
	"context"
	"errors"
	"sync"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// settings.go persists the two things this plugin remembers between runs, both
// in Host state (capabilities.state) under the "instance" scope:
//
//	key "settings" -> operator preferences (the plugin-settings toggle)
//	key "baseline" -> the last severity a notification decision was made
//	                  against, per source
//
// Host state has no transaction primitive, so both writers are last-write-wins
// over a whole small object — which is correct here: there is one poller
// goroutine per source and one settings form.

const (
	stateScope       = "instance"
	stateSettingsKey = "settings"
	stateBaselineKey = "baseline"
)

// Settings are the operator-facing preferences rendered in the
// plugin-settings slot.
type Settings struct {
	// NotifyOnTransition gates the transition toast. It does not gate the
	// chip, the banner, or the modal — those are always live. Default on.
	NotifyOnTransition bool `json:"notifyOnTransition"`
}

func defaultSettings() Settings { return Settings{NotifyOnTransition: true} }

func (s Settings) toState() map[string]any {
	return map[string]any{"notifyOnTransition": s.NotifyOnTransition}
}

func settingsFromState(value map[string]any) Settings {
	s := defaultSettings()
	if value == nil {
		return s
	}
	if v, ok := value["notifyOnTransition"].(bool); ok {
		s.NotifyOnTransition = v
	}
	return s
}

// hostState implements baselineStore on top of the Host state RPCs, with an
// in-memory mirror so a Host that is unavailable (early startup, a denied
// capability, a test with no broker) degrades to "works, just does not
// survive a restart" instead of failing outright.
type hostState struct {
	host func() pluginsdk.Host

	mu        sync.RWMutex
	baselines map[string]Baseline
	settings  *Settings
}

func newHostState(host func() pluginsdk.Host) *hostState {
	return &hostState{host: host, baselines: map[string]Baseline{}}
}

var errNoHost = errors.New("plugin host unavailable")

func (h *hostState) resolve() (pluginsdk.Host, error) {
	if h.host == nil {
		return nil, errNoHost
	}
	host := h.host()
	if host == nil {
		return nil, errNoHost
	}
	return host, nil
}

// load returns the persisted baseline for a source, preferring Host state and
// falling back to the in-memory mirror.
func (h *hostState) load(ctx context.Context, sourceID string) (Baseline, error) {
	host, err := h.resolve()
	if err != nil {
		return h.cachedBaseline(sourceID), nil
	}
	value, found, err := host.GetState(ctx, stateScope, "", stateBaselineKey)
	if err != nil {
		return h.cachedBaseline(sourceID), err
	}
	if !found {
		return h.cachedBaseline(sourceID), nil
	}
	entry, _ := value[sourceID].(map[string]any)
	b := baselineFromState(entry)

	h.mu.Lock()
	h.baselines[sourceID] = b
	h.mu.Unlock()
	return b, nil
}

// save writes the baseline for one source, preserving the other sources'
// entries in the same state object.
func (h *hostState) save(ctx context.Context, sourceID string, b Baseline) error {
	h.mu.Lock()
	h.baselines[sourceID] = b
	all := make(map[string]any, len(h.baselines))
	for id, entry := range h.baselines {
		all[id] = entry.toState()
	}
	h.mu.Unlock()

	host, err := h.resolve()
	if err != nil {
		return nil // in-memory only; not an error worth surfacing to the UI
	}
	return host.SetState(ctx, stateScope, "", stateBaselineKey, all)
}

func (h *hostState) cachedBaseline(sourceID string) Baseline {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.baselines[sourceID]
}

// loadSettings reads the operator preferences, falling back to the defaults.
func (h *hostState) loadSettings(ctx context.Context) Settings {
	host, err := h.resolve()
	if err != nil {
		return h.cachedSettings()
	}
	value, found, err := host.GetState(ctx, stateScope, "", stateSettingsKey)
	if err != nil || !found {
		return h.cachedSettings()
	}
	s := settingsFromState(value)

	h.mu.Lock()
	h.settings = &s
	h.mu.Unlock()
	return s
}

func (h *hostState) saveSettings(ctx context.Context, s Settings) error {
	h.mu.Lock()
	h.settings = &s
	h.mu.Unlock()

	host, err := h.resolve()
	if err != nil {
		return nil
	}
	return host.SetState(ctx, stateScope, "", stateSettingsKey, s.toState())
}

func (h *hostState) cachedSettings() Settings {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.settings == nil {
		return defaultSettings()
	}
	return *h.settings
}
