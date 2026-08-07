package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// plugin.go is the request-relay half. The UI never talks to githubstatus.com
// itself — it calls this plugin's own webhooks:
//
//	GET  /api/plugins/kandev-plugin-github-status/webhooks/status
//	POST .../webhooks/ack       {"sourceId","transitionId"}
//	POST .../webhooks/settings  {"notifyOnTransition":bool}  (empty body = read)
//
// Routing them through the backend rather than fetching from the browser is
// what makes the 60s/backoff/ETag budget a single shared budget: one poller
// per install, not one per open tab.

type githubStatusPlugin struct {
	pluginsdk.UnimplementedPlugin

	poller *Poller
	state  *hostState
}

var _ pluginsdk.Plugin = (*githubStatusPlugin)(nil)

// statusPayload is the wire shape ui/bundle.js renders. Field names here are
// a contract with that file.
type statusPayload struct {
	GeneratedAt string `json:"generatedAt"`

	SourceID    string `json:"sourceId"`
	DisplayName string `json:"displayName"`
	PageURL     string `json:"pageUrl"`

	// Overall/Loud are the two fields every surface branches on.
	Overall Severity `json:"overall"`
	Loud    bool     `json:"loud"`

	Snapshot *Snapshot `json:"snapshot"`

	// Stale is true when the cached snapshot is older than a few poll
	// intervals. The UI keeps rendering the last good data and labels it,
	// rather than flapping to "unknown" on one failed fetch.
	Stale               bool   `json:"stale"`
	FetchedAt           string `json:"fetchedAt,omitempty"`
	Error               string `json:"error,omitempty"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`

	// Transition is the unacknowledged status change, if any. The UI shows
	// its toast then POSTs to webhooks/ack so a page reload never replays it.
	Transition *Transition `json:"transition,omitempty"`

	Settings Settings `json:"settings"`

	// Demo names the fixture in play, empty in normal operation.
	Demo string `json:"demo,omitempty"`
}

func (p *githubStatusPlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	switch req.WebhookKey {
	case "status":
		return p.handleStatus(ctx, req)
	case "ack":
		return p.handleAck(ctx, req)
	case "settings":
		return p.handleSettings(ctx, req)
	default:
		return jsonError(404, fmt.Sprintf("unknown webhook key %q", req.WebhookKey))
	}
}

func (p *githubStatusPlugin) handleStatus(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	src, ok := primarySource()
	if !ok {
		return jsonError(503, "no status source is enabled")
	}

	settings := p.state.loadSettings(ctx)
	now := time.Now()

	// Fixture mode: render any of the interesting states on demand. GitHub
	// being up is the normal case, so this is the only way to see (or
	// screenshot) the degraded/incident/maintenance UI.
	if name := demoFixture(req.Query); name != "" {
		snap, err := loadFixtureSnapshot(src, name)
		if err != nil {
			return jsonError(400, err.Error())
		}
		payload := buildPayload(src, snap, now, settings)
		payload.Demo = name
		payload.Transition = demoTransition(src, snap, now)
		if fixtureIsStale(name) {
			payload.Stale = true
			payload.Error = "githubstatus.com unreachable (fixture)"
			payload.ConsecutiveFailures = 3
			payload.FetchedAt = now.Add(-7 * time.Minute).UTC().Format(time.RFC3339)
		}
		return jsonOK(payload)
	}

	st, found := p.poller.snapshotOf(src.ID)
	if !found {
		return jsonError(503, "status source not initialized")
	}

	payload := buildPayload(src, st.Snapshot, now, settings)
	payload.Stale = st.stale(now)
	payload.Error = st.LastError
	payload.ConsecutiveFailures = st.ConsecutiveFailures
	if !st.FetchedAt.IsZero() {
		payload.FetchedAt = st.FetchedAt.UTC().Format(time.RFC3339)
	}
	if settings.NotifyOnTransition {
		payload.Transition = st.Pending
	}
	return jsonOK(payload)
}

// buildPayload projects a snapshot (possibly nil, before the first successful
// poll) onto the wire shape.
func buildPayload(src Source, snap *Snapshot, now time.Time, settings Settings) statusPayload {
	payload := statusPayload{
		GeneratedAt: now.UTC().Format(time.RFC3339),
		SourceID:    src.ID,
		DisplayName: src.DisplayName,
		PageURL:     src.PageURL,
		Snapshot:    snap,
		Settings:    settings,
	}
	if snap != nil {
		payload.Overall = snap.Overall
		payload.Loud = snap.Overall.Loud()
	}
	return payload
}

type ackRequest struct {
	SourceID     string `json:"sourceId"`
	TransitionID string `json:"transitionId"`
}

func (p *githubStatusPlugin) handleAck(_ context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	// webhooks[].method is informational in kandev; enforce it here.
	if !strings.EqualFold(req.Method, "POST") {
		return jsonError(405, "ack requires POST")
	}
	var body ackRequest
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return jsonError(400, "invalid JSON body")
	}
	if body.SourceID == "" || body.TransitionID == "" {
		return jsonError(400, "sourceId and transitionId are required")
	}
	return jsonOK(map[string]any{"acknowledged": p.poller.acknowledge(body.SourceID, body.TransitionID)})
}

type settingsRequest struct {
	NotifyOnTransition *bool `json:"notifyOnTransition"`
}

func (p *githubStatusPlugin) handleSettings(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if !strings.EqualFold(req.Method, "POST") {
		return jsonError(405, "settings requires POST")
	}
	current := p.state.loadSettings(ctx)
	// An empty body is a read, so the settings panel needs one route, not two.
	if len(strings.TrimSpace(string(req.Body))) == 0 {
		return jsonOK(current)
	}
	var body settingsRequest
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return jsonError(400, "invalid JSON body")
	}
	if body.NotifyOnTransition != nil {
		current.NotifyOnTransition = *body.NotifyOnTransition
	}
	if err := p.state.saveSettings(ctx, current); err != nil {
		return jsonError(500, err.Error())
	}
	return jsonOK(current)
}

// emitTransition publishes the change on kandev's event bus as
// plugin.kandev-glugin-github-status.status.changed so other plugins can react
// to it.
//
// Note for readers expecting this to drive the toast: on the current kandev
// branch Host.EmitEvent publishes to the *backend* bus only — there is no
// generic bridge forwarding plugin.<id>.<name> subjects to the browser
// WebSocket, so registerWsHandler cannot observe it. The UI therefore learns
// about a transition from the status payload and acknowledges it by ID. See
// README.md "Transitions and notifications".
func (p *githubStatusPlugin) emitTransition(ctx context.Context, src Source, t *Transition) {
	if t == nil {
		return
	}
	log.Printf("github-status: %s %s -> %s (%s)", src.ID, t.From, t.To, t.Kind)

	host := p.Host()
	if host == nil {
		return
	}
	payload := map[string]any{
		"sourceId": t.SourceID,
		"kind":     string(t.Kind),
		"from":     t.From.String(),
		"to":       t.To.String(),
		"title":    t.Title,
		"detail":   t.Detail,
		"at":       t.At,
	}
	if err := host.EmitEvent(ctx, "status.changed", payload); err != nil {
		log.Printf("github-status: emit status.changed: %v", err)
	}
}

// ---- response helpers ------------------------------------------------------

func jsonOK(v any) (*pluginsdk.WebhookResponse, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return jsonError(500, err.Error())
	}
	return &pluginsdk.WebhookResponse{
		Status:  200,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}, nil
}

func jsonError(status int, msg string) (*pluginsdk.WebhookResponse, error) {
	body, _ := json.Marshal(map[string]string{"error": msg})
	return &pluginsdk.WebhookResponse{
		Status:  int32(status),
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    body,
	}, nil
}

// demoFixture reads the ?demo=<name> query used to render fixture states.
func demoFixture(query string) string {
	q, err := url.ParseQuery(query)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(q.Get("demo")))
}
