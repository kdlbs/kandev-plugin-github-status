package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// ---- interval math ---------------------------------------------------------

func TestPollInterval_HonorsCacheControlWithoutGoingBelowTheFloor(t *testing.T) {
	base := 60 * time.Second
	cases := []struct {
		name   string
		maxAge time.Duration
		want   time.Duration
	}{
		// githubstatus.com sends max-age=10. We are allowed to poll that
		// fast; we decline to.
		{"provider allows faster than our floor", 10 * time.Second, base},
		{"no cache-control header", 0, base},
		{"provider asks for longer", 5 * time.Minute, 5 * time.Minute},
		{"provider asks for absurdly long", 3 * time.Hour, maxPollInterval},
		{"exactly the floor", base, base},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pollInterval(base, tc.maxAge); got != tc.want {
				t.Errorf("pollInterval(%v, %v) = %v, want %v", base, tc.maxAge, got, tc.want)
			}
		})
	}
}

func TestParseMaxAge(t *testing.T) {
	cases := map[string]time.Duration{
		// The header githubstatus.com actually returns.
		"max-age=10, public, s-maxage=10, stale-while-revalidate=20, stale-if-error=3600": 10 * time.Second,
		"public, max-age=300": 300 * time.Second,
		"MAX-AGE=45":          45 * time.Second,
		"no-cache":            0,
		"":                    0,
		"max-age=notanumber":  0,
		"max-age=-5":          0,
	}
	for header, want := range cases {
		if got := parseMaxAge(header); got != want {
			t.Errorf("parseMaxAge(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestBackoffInterval_DoublesAndCaps(t *testing.T) {
	base := 60 * time.Second
	cases := []struct {
		failures int
		want     time.Duration
	}{
		{0, base},
		{1, base},
		{2, 2 * time.Minute},
		{3, 4 * time.Minute},
		{4, 8 * time.Minute},
		{5, maxPollInterval},
		{50, maxPollInterval},
	}
	for _, tc := range cases {
		if got := backoffInterval(base, tc.failures); got != tc.want {
			t.Errorf("backoffInterval(%d failures) = %v, want %v", tc.failures, got, tc.want)
		}
	}
}

// ---- state machine ---------------------------------------------------------

// memStore is an in-memory baselineStore standing in for Host state.
type memStore struct {
	mu     sync.Mutex
	saved  map[string]Baseline
	writes int
	seed   map[string]Baseline
}

func newMemStore() *memStore {
	return &memStore{saved: map[string]Baseline{}, seed: map[string]Baseline{}}
}

func (m *memStore) load(_ context.Context, sourceID string) (Baseline, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.seed[sourceID], nil
}

func (m *memStore) save(_ context.Context, sourceID string, b Baseline) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saved[sourceID] = b
	m.writes++
	return nil
}

func (m *memStore) writeCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writes
}

// A steady-state outage must notify once, no matter how many times it is
// polled — the poller-level counterpart to the pure transition test.
func TestPoller_ApplySnapshot_NotifiesOncePerChange(t *testing.T) {
	src := testSource(t)
	p := newPoller([]Source{src}, nil, nil)

	var got []*Transition
	apply := func(sev Severity) {
		tr, _ := p.applySnapshot(src, snapshotAt(t, sev), testNow)
		if tr != nil {
			got = append(got, tr)
		}
	}

	apply(SeverityOperational) // first poll: seeds the baseline, silent
	apply(SeverityOperational)
	apply(SeverityMajor) // notify: degraded
	apply(SeverityMajor)
	apply(SeverityMajor)
	apply(SeverityMajor)
	apply(SeverityOperational) // notify: recovered
	apply(SeverityOperational)

	if len(got) != 2 {
		t.Fatalf("got %d notifications, want 2: %+v", len(got), got)
	}
	if got[0].Kind != TransitionDegraded {
		t.Errorf("first Kind = %q, want %q", got[0].Kind, TransitionDegraded)
	}
	if got[1].Kind != TransitionRecovered {
		t.Errorf("second Kind = %q, want %q", got[1].Kind, TransitionRecovered)
	}
}

// The baseline is only rewritten when it actually moves, so a quiet install
// is not writing to Host state every 60s forever.
func TestPoller_ApplySnapshot_ReportsBaselineChangesOnly(t *testing.T) {
	src := testSource(t)
	p := newPoller([]Source{src}, nil, nil)

	if _, changed := p.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow); !changed {
		t.Error("first poll must report a baseline change so it gets persisted")
	}
	if _, changed := p.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow); changed {
		t.Error("an identical poll must not rewrite the baseline")
	}
	if _, changed := p.applySnapshot(src, snapshotAt(t, SeverityMinor), testNow); !changed {
		t.Error("a severity change must rewrite the baseline")
	}
}

// A restart mid-outage must not replay the toast the user already saw.
func TestPoller_SeededBaselineSuppressesRestartNotification(t *testing.T) {
	src := testSource(t)
	store := newMemStore()
	store.seed[src.ID] = Baseline{Known: true, Severity: SeverityMajor}

	var mu sync.Mutex
	var notified []*Transition
	p := newPoller([]Source{src}, store, func(_ context.Context, _ Source, tr *Transition) {
		mu.Lock()
		notified = append(notified, tr)
		mu.Unlock()
	})

	// Simulate runSource's seed step, then the first poll of the same state.
	b, _ := store.load(context.Background(), src.ID)
	p.mu.Lock()
	p.state[src.ID].Baseline = b
	p.mu.Unlock()

	if tr, _ := p.applySnapshot(src, snapshotAt(t, SeverityMajor), testNow); tr != nil {
		t.Fatalf("restart during an ongoing outage re-notified: %+v", tr)
	}
	// ...and the eventual recovery still fires.
	if tr, _ := p.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow); tr == nil {
		t.Fatal("recovery after a seeded baseline did not notify")
	}
}

// Acking clears the pending toast; a stale ack from an old tab must not
// swallow a newer one.
func TestPoller_Acknowledge(t *testing.T) {
	src := testSource(t)
	p := newPoller([]Source{src}, nil, nil)

	p.applySnapshot(src, snapshotAt(t, SeverityOperational), testNow)
	tr, _ := p.applySnapshot(src, snapshotAt(t, SeverityMajor), testNow)
	if tr == nil {
		t.Fatal("expected a transition")
	}

	if st, _ := p.snapshotOf(src.ID); st.Pending == nil {
		t.Fatal("transition was not recorded as pending")
	}
	if p.acknowledge(src.ID, "not-the-right-id") {
		t.Error("a mismatched ack was accepted")
	}
	if st, _ := p.snapshotOf(src.ID); st.Pending == nil {
		t.Error("a mismatched ack cleared the pending transition")
	}
	if !p.acknowledge(src.ID, tr.ID) {
		t.Error("the matching ack was rejected")
	}
	if st, _ := p.snapshotOf(src.ID); st.Pending != nil {
		t.Error("pending transition survived its ack")
	}
	if p.acknowledge(src.ID, tr.ID) {
		t.Error("a repeated ack reported success")
	}
	if p.acknowledge("nope", tr.ID) {
		t.Error("an ack for an unknown source reported success")
	}
}

func TestSourceState_StaleAfterMissedPolls(t *testing.T) {
	st := &SourceState{Snapshot: &Snapshot{}, FetchedAt: testNow}
	if st.stale(testNow.Add(basePollInterval)) {
		t.Error("one interval old must not be stale")
	}
	if st.stale(testNow.Add(staleAfter)) {
		t.Error("exactly staleAfter must not yet be stale")
	}
	if !st.stale(testNow.Add(staleAfter + time.Second)) {
		t.Error("past staleAfter must be stale")
	}

	// Before the first successful fetch there is nothing to call stale.
	empty := &SourceState{}
	if empty.stale(testNow.Add(24 * time.Hour)) {
		t.Error("a source with no snapshot must not report stale")
	}
}

// ---- fetching --------------------------------------------------------------

func TestPoller_Fetch_SendsIdentifyingUserAgentAndConditionalHeaders(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("fixtures", "healthy.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var mu sync.Mutex
	var requests []*http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, r.Clone(context.Background()))
		n := len(requests)
		mu.Unlock()

		w.Header().Set("Cache-Control", "max-age=10, public")
		w.Header().Set("ETag", `W/"abc123"`)
		if n > 1 && r.Header.Get("If-None-Match") == `W/"abc123"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	p := newPoller([]Source{src}, nil, nil)

	got, meta, err := p.fetch(context.Background(), src)
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if meta.notModified {
		t.Error("first fetch reported 304")
	}
	if meta.maxAge != 10*time.Second {
		t.Errorf("maxAge = %v, want 10s", meta.maxAge)
	}
	if len(got) != len(body) {
		t.Errorf("body length = %d, want %d", len(got), len(body))
	}

	// Second fetch must be conditional and must come back 304.
	_, meta, err = p.fetch(context.Background(), src)
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if !meta.notModified {
		t.Error("second fetch did not use the ETag (expected 304)")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("server saw %d requests, want 2", len(requests))
	}
	if ua := requests[0].Header.Get("User-Agent"); ua != userAgent {
		t.Errorf("User-Agent = %q, want %q", ua, userAgent)
	}
	if requests[0].Header.Get("If-None-Match") != "" {
		t.Error("first request must not send If-None-Match")
	}
	if requests[1].Header.Get("If-None-Match") != `W/"abc123"` {
		t.Errorf("second request If-None-Match = %q", requests[1].Header.Get("If-None-Match"))
	}
}

func TestPoller_Fetch_NonOKStatusIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	p := newPoller([]Source{src}, nil, nil)

	if _, _, err := p.fetch(context.Background(), src); err == nil {
		t.Error("expected an error for HTTP 502")
	}
}

// A failed fetch must keep the cached snapshot and report it as stale rather
// than flapping the UI to "unknown".
func TestPoller_PollOnce_FailureKeepsCachedSnapshotAndBacksOff(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("fixtures", "degraded.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var mu sync.Mutex
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		shouldFail := fail
		mu.Unlock()
		if shouldFail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	p := newPoller([]Source{src}, nil, nil)

	if wait := p.pollOnce(context.Background(), src); wait != basePollInterval {
		t.Errorf("successful poll wait = %v, want %v", wait, basePollInterval)
	}
	st, _ := p.snapshotOf(src.ID)
	if st.Snapshot == nil || st.Snapshot.Overall != SeverityMinor {
		t.Fatalf("cached snapshot = %+v", st.Snapshot)
	}

	mu.Lock()
	fail = true
	mu.Unlock()

	wait := p.pollOnce(context.Background(), src)
	if wait != basePollInterval {
		t.Errorf("first failure wait = %v, want %v", wait, basePollInterval)
	}
	wait = p.pollOnce(context.Background(), src)
	if wait != 2*basePollInterval {
		t.Errorf("second failure wait = %v, want %v", wait, 2*basePollInterval)
	}

	st, _ = p.snapshotOf(src.ID)
	if st.Snapshot == nil {
		t.Fatal("a failed fetch dropped the cached snapshot")
	}
	if st.Snapshot.Overall != SeverityMinor {
		t.Errorf("cached snapshot changed on failure: %v", st.Snapshot.Overall)
	}
	if st.LastError == "" {
		t.Error("LastError not recorded")
	}
	if st.ConsecutiveFailures != 2 {
		t.Errorf("ConsecutiveFailures = %d, want 2", st.ConsecutiveFailures)
	}

	// Recovery clears the error and resets the backoff.
	mu.Lock()
	fail = false
	mu.Unlock()
	if wait := p.pollOnce(context.Background(), src); wait != basePollInterval {
		t.Errorf("recovered poll wait = %v, want %v", wait, basePollInterval)
	}
	st, _ = p.snapshotOf(src.ID)
	if st.LastError != "" || st.ConsecutiveFailures != 0 {
		t.Errorf("failure state survived a success: %q / %d", st.LastError, st.ConsecutiveFailures)
	}
}

// A 304 confirms the cached copy is current, so it must refresh the snapshot's
// age — otherwise a stable status page would drift into "stale" while nothing
// is wrong.
func TestPoller_PollOnce_NotModifiedRefreshesAge(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("fixtures", "healthy.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	p := newPoller([]Source{src}, nil, nil)

	base := testNow
	p.now = func() time.Time { return base }
	p.pollOnce(context.Background(), src)

	later := base.Add(2 * time.Hour)
	p.now = func() time.Time { return later }
	p.pollOnce(context.Background(), src)

	st, _ := p.snapshotOf(src.ID)
	if !st.FetchedAt.Equal(later) {
		t.Errorf("FetchedAt = %v, want %v (a 304 must refresh the age)", st.FetchedAt, later)
	}
	if st.stale(later) {
		t.Error("a 304-confirmed snapshot must not read as stale")
	}
}

// A poll cycle over a live-shaped payload must persist exactly one baseline
// per change through the store.
func TestPoller_PollOnce_PersistsBaselineThroughStore(t *testing.T) {
	healthy, _ := os.ReadFile(filepath.Join("fixtures", "healthy.json"))
	degraded, _ := os.ReadFile(filepath.Join("fixtures", "degraded.json"))

	var mu sync.Mutex
	payload := healthy
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		body := payload
		mu.Unlock()
		_, _ = w.Write(body)
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	store := newMemStore()

	var notified []*Transition
	p := newPoller([]Source{src}, store, func(_ context.Context, _ Source, tr *Transition) {
		notified = append(notified, tr)
	})

	p.pollOnce(context.Background(), src) // seeds
	p.pollOnce(context.Background(), src) // identical
	if store.writeCount() != 1 {
		t.Errorf("baseline writes = %d after two identical polls, want 1", store.writeCount())
	}
	if len(notified) != 0 {
		t.Errorf("notified on the seeding polls: %+v", notified)
	}

	mu.Lock()
	payload = degraded
	mu.Unlock()
	p.pollOnce(context.Background(), src)
	p.pollOnce(context.Background(), src)

	if store.writeCount() != 2 {
		t.Errorf("baseline writes = %d, want 2", store.writeCount())
	}
	if len(notified) != 1 {
		t.Fatalf("notifications = %d, want 1: %+v", len(notified), notified)
	}
	if notified[0].Kind != TransitionDegraded {
		t.Errorf("Kind = %q", notified[0].Kind)
	}
	if got := store.saved[src.ID]; !got.Known || got.Severity != SeverityMinor {
		t.Errorf("saved baseline = %+v", got)
	}
}

// Run must return when its context is cancelled, so the subprocess does not
// leak a goroutine per source across a config-change restart.
func TestPoller_RunStopsOnContextCancel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"components":[],"incidents":[],"scheduled_maintenances":[],"status":{"indicator":"none"}}`))
	}))
	defer server.Close()

	src := testSource(t)
	src.SummaryURL = server.URL
	p := newPoller([]Source{src}, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()

	// Let the first poll land, then cancel.
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}
}

// The snapshot the poller caches must survive a JSON round trip unchanged —
// it is the exact object the UI receives.
func TestSnapshotJSONShape(t *testing.T) {
	snap := parseFixture(t, "incident.json")
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"overall", "indicator", "keyComponents", "otherComponents", "incidents", "maintenances"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("payload is missing %q", key)
		}
	}
	if decoded["overall"] != "major" {
		t.Errorf("overall = %v, want the string \"major\"", decoded["overall"])
	}
}
