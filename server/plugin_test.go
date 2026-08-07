package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func newTestPlugin(t *testing.T) *githubStatusPlugin {
	t.Helper()
	p := &githubStatusPlugin{}
	// No Host: newHostState degrades to an in-memory mirror, which is the
	// same path the real plugin takes before kandev injects the broker.
	p.state = newHostState(p.Host)
	p.poller = newPoller(enabledSources(), p.state, nil)
	return p
}

func callWebhook(t *testing.T, p *githubStatusPlugin, key, method, query, body string) (int, map[string]any) {
	t.Helper()
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: key,
		Method:     method,
		Query:      query,
		Body:       []byte(body),
	})
	if err != nil {
		t.Fatalf("HandleWebhook(%s): %v", key, err)
	}
	var decoded map[string]any
	if len(resp.Body) > 0 {
		if err := json.Unmarshal(resp.Body, &decoded); err != nil {
			t.Fatalf("decode %s response %q: %v", key, resp.Body, err)
		}
	}
	if ct := resp.Headers["Content-Type"]; ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	return int(resp.Status), decoded
}

func TestHandleWebhook_UnknownKeyIs404(t *testing.T) {
	status, body := callWebhook(t, newTestPlugin(t), "nope", "GET", "", "")
	if status != 404 {
		t.Errorf("status = %d, want 404", status)
	}
	if body["error"] == nil {
		t.Error("expected an error body")
	}
}

// Before the first successful poll there is nothing to report. The payload is
// still well-formed with a null snapshot, so the UI renders a "checking"
// chip rather than having to special-case an error status.
func TestHandleStatus_BeforeFirstPoll(t *testing.T) {
	status, body := callWebhook(t, newTestPlugin(t), "status", "GET", "", "")
	if status != 200 {
		t.Fatalf("status = %d (%v), want 200", status, body)
	}
	if body["snapshot"] != nil {
		t.Errorf("snapshot = %v, want null before the first poll", body["snapshot"])
	}
	if body["overall"] != "operational" {
		t.Errorf("overall = %v, want operational", body["overall"])
	}
	if body["loud"] != false {
		t.Errorf("loud = %v, want false", body["loud"])
	}
}

func TestHandleStatus_ServesCachedSnapshot(t *testing.T) {
	p := newTestPlugin(t)
	src := testSource(t)
	p.poller.applySnapshot(src, parseFixture(t, "incident.json"), testNow)

	status, body := callWebhook(t, p, "status", "GET", "", "")
	if status != 200 {
		t.Fatalf("status = %d (%v)", status, body)
	}
	if body["overall"] != "major" {
		t.Errorf("overall = %v, want major", body["overall"])
	}
	if body["loud"] != true {
		t.Errorf("loud = %v, want true", body["loud"])
	}
	if body["displayName"] != "GitHub" {
		t.Errorf("displayName = %v", body["displayName"])
	}
	snap, ok := body["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot = %v", body["snapshot"])
	}
	if key, ok := snap["keyComponents"].([]any); !ok || len(key) != 6 {
		t.Errorf("keyComponents = %v", snap["keyComponents"])
	}
}

// Every fixture must be reachable through the demo query and must render a
// coherent payload — this is how the interesting UI states get screenshotted.
func TestHandleStatus_DemoFixtures(t *testing.T) {
	cases := map[string]struct {
		overall string
		loud    bool
		stale   bool
	}{
		"healthy":     {"operational", false, false},
		"degraded":    {"minor", true, false},
		"incident":    {"major", true, false},
		"critical":    {"critical", true, false},
		"maintenance": {"operational", false, false},
		"stale":       {"minor", true, true},
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			status, body := callWebhook(t, newTestPlugin(t), "status", "GET", "demo="+name, "")
			if status != 200 {
				t.Fatalf("status = %d (%v)", status, body)
			}
			if body["demo"] != name {
				t.Errorf("demo = %v, want %q", body["demo"], name)
			}
			if body["overall"] != want.overall {
				t.Errorf("overall = %v, want %q", body["overall"], want.overall)
			}
			if body["loud"] != want.loud {
				t.Errorf("loud = %v, want %v", body["loud"], want.loud)
			}
			if body["stale"] != want.stale {
				t.Errorf("stale = %v, want %v", body["stale"], want.stale)
			}
			if body["snapshot"] == nil {
				t.Error("snapshot is null")
			}
		})
	}
}

func TestHandleStatus_UnknownDemoFixtureIs400(t *testing.T) {
	status, body := callWebhook(t, newTestPlugin(t), "status", "GET", "demo=banana", "")
	if status != 400 {
		t.Errorf("status = %d, want 400", status)
	}
	if body["error"] == nil {
		t.Error("expected an error body")
	}
}

// Demo mode must also produce a toast, otherwise the notification UI is
// unreviewable.
func TestHandleStatus_DemoIncludesATransition(t *testing.T) {
	_, body := callWebhook(t, newTestPlugin(t), "status", "GET", "demo=incident", "")
	tr, ok := body["transition"].(map[string]any)
	if !ok {
		t.Fatalf("transition = %v", body["transition"])
	}
	if tr["kind"] != string(TransitionDegraded) {
		t.Errorf("kind = %v, want %q", tr["kind"], TransitionDegraded)
	}
	if tr["title"] == "" || tr["id"] == "" {
		t.Errorf("transition = %v", tr)
	}
}

func TestHandleAck(t *testing.T) {
	p := newTestPlugin(t)
	src := testSource(t)
	p.poller.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow)
	tr, _ := p.poller.applySnapshot(src, snapshotAt(t, SeverityMajor), testNow)
	if tr == nil {
		t.Fatal("expected a pending transition")
	}

	// It is delivered in the status payload...
	_, body := callWebhook(t, p, "status", "GET", "", "")
	if body["transition"] == nil {
		t.Fatal("pending transition not delivered in the status payload")
	}

	// ...acked...
	status, ack := callWebhook(t, p, "ack", "POST", "", `{"sourceId":"github","transitionId":"`+tr.ID+`"}`)
	if status != 200 || ack["acknowledged"] != true {
		t.Fatalf("ack = %d %v", status, ack)
	}

	// ...and never replayed, which is what stops a page reload re-toasting.
	_, body = callWebhook(t, p, "status", "GET", "", "")
	if body["transition"] != nil {
		t.Errorf("transition replayed after ack: %v", body["transition"])
	}
}

func TestHandleAck_Validation(t *testing.T) {
	p := newTestPlugin(t)

	if status, _ := callWebhook(t, p, "ack", "GET", "", `{}`); status != 405 {
		t.Errorf("GET ack status = %d, want 405", status)
	}
	if status, _ := callWebhook(t, p, "ack", "POST", "", `not json`); status != 400 {
		t.Errorf("malformed ack status = %d, want 400", status)
	}
	if status, _ := callWebhook(t, p, "ack", "POST", "", `{"sourceId":"github"}`); status != 400 {
		t.Errorf("incomplete ack status = %d, want 400", status)
	}
}

func TestHandleSettings_ReadWriteRoundTrip(t *testing.T) {
	p := newTestPlugin(t)

	// Empty body reads. Notifications default on.
	status, body := callWebhook(t, p, "settings", "POST", "", "")
	if status != 200 || body["notifyOnTransition"] != true {
		t.Fatalf("read = %d %v", status, body)
	}

	status, body = callWebhook(t, p, "settings", "POST", "", `{"notifyOnTransition":false}`)
	if status != 200 || body["notifyOnTransition"] != false {
		t.Fatalf("write = %d %v", status, body)
	}

	_, body = callWebhook(t, p, "settings", "POST", "", "")
	if body["notifyOnTransition"] != false {
		t.Errorf("setting did not persist: %v", body)
	}

	status, body = callWebhook(t, p, "settings", "POST", "", `{"notifyOnTransition":true}`)
	if status != 200 || body["notifyOnTransition"] != true {
		t.Fatalf("re-enable = %d %v", status, body)
	}
}

func TestHandleSettings_Validation(t *testing.T) {
	p := newTestPlugin(t)
	if status, _ := callWebhook(t, p, "settings", "GET", "", ""); status != 405 {
		t.Errorf("GET settings status = %d, want 405", status)
	}
	if status, _ := callWebhook(t, p, "settings", "POST", "", `{`); status != 400 {
		t.Errorf("malformed settings status = %d, want 400", status)
	}
}

// Turning notifications off must suppress the toast without touching the
// chip, banner, or modal data.
func TestHandleStatus_NotificationsOffSuppressesTheTransitionOnly(t *testing.T) {
	p := newTestPlugin(t)
	src := testSource(t)
	p.poller.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow)
	p.poller.applySnapshot(src, snapshotAt(t, SeverityMajor), testNow)

	callWebhook(t, p, "settings", "POST", "", `{"notifyOnTransition":false}`)

	_, body := callWebhook(t, p, "status", "GET", "", "")
	if body["transition"] != nil {
		t.Errorf("transition delivered with notifications off: %v", body["transition"])
	}
	if body["loud"] != true {
		t.Error("the chip/banner data must still report the degradation")
	}
	if settings, ok := body["settings"].(map[string]any); !ok || settings["notifyOnTransition"] != false {
		t.Errorf("settings = %v", body["settings"])
	}

	// ...and turning it back on delivers the still-pending transition.
	callWebhook(t, p, "settings", "POST", "", `{"notifyOnTransition":true}`)
	_, body = callWebhook(t, p, "status", "GET", "", "")
	if body["transition"] == nil {
		t.Error("transition not delivered after re-enabling notifications")
	}
}

func TestSettingsStateRoundTrip(t *testing.T) {
	for _, want := range []bool{true, false} {
		in := Settings{NotifyOnTransition: want}
		if got := settingsFromState(in.toState()); got != in {
			t.Errorf("round trip of %v = %+v", want, got)
		}
	}
	// Missing or malformed state falls back to the default (on).
	for _, value := range []map[string]any{nil, {}, {"notifyOnTransition": "yes"}} {
		if got := settingsFromState(value); got != defaultSettings() {
			t.Errorf("settingsFromState(%v) = %+v, want the default", value, got)
		}
	}
}

func TestEnabledSourcesShipsGitHubOnly(t *testing.T) {
	enabled := enabledSources()
	if len(enabled) != 1 {
		t.Fatalf("enabled sources = %d, want exactly 1 (GitHub): %+v", len(enabled), enabled)
	}
	if enabled[0].ID != "github" {
		t.Errorf("enabled source = %q, want github", enabled[0].ID)
	}
	src := enabled[0]
	if src.SummaryURL == "" || src.PageURL == "" || len(src.KeyComponents) != 6 {
		t.Errorf("github source is incompletely configured: %+v", src)
	}
}

func TestDemoFixtureQueryParsing(t *testing.T) {
	cases := map[string]string{
		"demo=incident":          "incident",
		"demo=INCIDENT":          "incident",
		"demo=":                  "",
		"":                       "",
		"other=1":                "",
		"demo=incident&x=2":      "incident",
		"%zz":                    "",
		"demo=%20maintenance%20": "maintenance",
	}
	for query, want := range cases {
		if got := demoFixture(query); got != want {
			t.Errorf("demoFixture(%q) = %q, want %q", query, got, want)
		}
	}
}

// Every fixture the demo map advertises must actually parse.
func TestAllFixturesLoad(t *testing.T) {
	src := testSource(t)
	for _, name := range fixtureNames() {
		snap, err := loadFixtureSnapshot(src, name)
		if err != nil {
			t.Errorf("loadFixtureSnapshot(%q): %v", name, err)
			continue
		}
		if snap.DisplayName != "GitHub" || len(snap.KeyComponents) != 6 {
			t.Errorf("fixture %q produced %+v", name, snap)
		}
	}
	if _, err := loadFixtureSnapshot(src, "does-not-exist"); err == nil {
		t.Error("expected an error for an unknown fixture")
	}
}
