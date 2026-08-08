package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// poller.go is the network-citizen half of the plugin: one background
// goroutine per enabled source, 60s floor, conditional GETs, exponential
// backoff on failure, and a cached last-good snapshot that is reported as
// stale rather than flapping the UI to "unknown" on a single failed fetch.

const (
	// userAgent identifies this plugin to the status page. Statuspage
	// operators ask for an identifying UA; an anonymous poller is the one
	// that gets rate-limited first.
	userAgent = "kandev-plugin-github-status/0.1.0 (+https://github.com/kdlbs/kandev-plugin-github-status)"

	// basePollInterval is the floor. githubstatus.com advertises
	// max-age=10, which we deliberately do not take it up on — 60s is
	// plenty for a status chip and an order of magnitude kinder.
	basePollInterval = 60 * time.Second
	// maxPollInterval caps the backoff. Fifteen minutes of silence is long
	// enough to stop hammering a struggling endpoint and short enough that
	// recovery is noticed within one coffee.
	maxPollInterval = 15 * time.Minute
	// requestTimeout bounds a single fetch.
	requestTimeout = 15 * time.Second
	// staleAfter is how long a cached snapshot stays presentable before the
	// UI labels it stale. Three missed polls.
	staleAfter = 3 * basePollInterval
)

// SourceState is the poller's cached view of one source, served to the UI.
type SourceState struct {
	Source Source
	// Snapshot is the last successfully parsed snapshot, or nil before the
	// first success.
	Snapshot *Snapshot
	// FetchedAt is when Snapshot was last refreshed (including a 304, which
	// confirms the cached copy is still current).
	FetchedAt time.Time
	// LastError is the most recent fetch/parse failure, cleared on success.
	LastError string
	// LastErrorAt is when LastError happened.
	LastErrorAt time.Time
	// ConsecutiveFailures drives the backoff and the "how bad is this"
	// reporting.
	ConsecutiveFailures int
	// Pending is the transition awaiting UI acknowledgement, if any.
	Pending *Transition
	// Baseline is the last severity a notification decision was made against.
	Baseline Baseline
}

// stale reports whether the cached snapshot is old enough that the UI should
// say so.
func (s *SourceState) stale(now time.Time) bool {
	if s.Snapshot == nil {
		return false
	}
	return now.Sub(s.FetchedAt) > staleAfter
}

// notifier is the side-effect sink for a detected transition. The poller
// calls it outside its own lock. Injected so tests never need a Host.
type notifier func(ctx context.Context, src Source, t *Transition)

// baselineStore persists the notification baseline across plugin restarts.
// Injected for the same reason.
type baselineStore interface {
	load(ctx context.Context, sourceID string) (Baseline, error)
	save(ctx context.Context, sourceID string, b Baseline) error
}

// Poller owns the fetch loop and the cache for every enabled source.
type Poller struct {
	client  *http.Client
	now     func() time.Time
	store   baselineStore
	notify  notifier
	sources []Source

	mu    sync.RWMutex
	state map[string]*SourceState
	// etags/lastModified back the conditional GETs, keyed by source id.
	etags        map[string]string
	lastModified map[string]string
	// nextInterval is the per-source wait computed by the last poll, exposed
	// for tests and for the status payload's "next poll" hint.
	nextInterval map[string]time.Duration
}

// newPoller wires a Poller. store and notify may be nil (no persistence, no
// notifications) which is what the pure unit tests use.
func newPoller(srcs []Source, store baselineStore, notify notifier) *Poller {
	p := &Poller{
		client:       &http.Client{Timeout: requestTimeout},
		now:          time.Now,
		store:        store,
		notify:       notify,
		sources:      srcs,
		state:        make(map[string]*SourceState, len(srcs)),
		etags:        make(map[string]string, len(srcs)),
		lastModified: make(map[string]string, len(srcs)),
		nextInterval: make(map[string]time.Duration, len(srcs)),
	}
	for _, s := range srcs {
		p.state[s.ID] = &SourceState{Source: s}
	}
	return p
}

// Run polls every source until ctx is cancelled. One goroutine per source.
func (p *Poller) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, src := range p.sources {
		wg.Add(1)
		go func(src Source) {
			defer wg.Done()
			p.runSource(ctx, src)
		}(src)
	}
	wg.Wait()
}

func (p *Poller) runSource(ctx context.Context, src Source) {
	// Seed the baseline from Host state before the first fetch, so a restart
	// during an ongoing outage does not re-toast it.
	if p.store != nil {
		if b, err := p.store.load(ctx, src.ID); err != nil {
			log.Printf("github-status: baseline load for %s: %v", src.ID, err)
		} else {
			p.mu.Lock()
			p.state[src.ID].Baseline = b
			p.mu.Unlock()
		}
	}

	for {
		wait := p.pollOnce(ctx, src)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// pollOnce performs one fetch cycle and returns how long to wait before the
// next one.
func (p *Poller) pollOnce(ctx context.Context, src Source) time.Duration {
	body, meta, err := p.fetch(ctx, src)
	now := p.now()

	if err != nil {
		return p.recordFailure(src, err, now)
	}
	if meta.notModified {
		// The cached snapshot is confirmed current: refresh its age so it
		// does not drift into "stale" while nothing is actually wrong.
		p.mu.Lock()
		st := p.state[src.ID]
		st.FetchedAt = now
		st.LastError = ""
		st.ConsecutiveFailures = 0
		p.mu.Unlock()
		return pollInterval(basePollInterval, meta.maxAge)
	}

	snap, err := parseSummary(src, body)
	if err != nil {
		return p.recordFailure(src, err, now)
	}

	transition, baselineChanged := p.applySnapshot(src, snap, now)
	// Persist whenever the baseline moved — including the first-ever poll,
	// which produces no transition but must still be recorded so the next
	// restart has something to compare against.
	if baselineChanged && p.store != nil {
		if err := p.store.save(ctx, src.ID, baselineFrom(snap)); err != nil {
			log.Printf("github-status: baseline save for %s: %v", src.ID, err)
		}
	}
	if transition != nil && p.notify != nil {
		p.notify(ctx, src, transition)
	}

	return pollInterval(basePollInterval, meta.maxAge)
}

// applySnapshot commits a freshly parsed snapshot and reports the transition
// it produced (if any) plus whether the persisted baseline needs rewriting.
// Split out from pollOnce so tests can drive the state machine without a
// network.
func (p *Poller) applySnapshot(src Source, snap *Snapshot, now time.Time) (*Transition, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	st := p.state[src.ID]
	transition := detectTransition(src, st.Baseline, snap, now)
	next := baselineFrom(snap)
	baselineChanged := st.Baseline != next

	st.Snapshot = snap
	st.FetchedAt = now
	st.LastError = ""
	st.ConsecutiveFailures = 0
	st.Baseline = next
	if transition != nil {
		st.Pending = transition
	}
	return transition, baselineChanged
}

func (p *Poller) recordFailure(src Source, err error, now time.Time) time.Duration {
	p.mu.Lock()
	st := p.state[src.ID]
	st.LastError = err.Error()
	st.LastErrorAt = now
	st.ConsecutiveFailures++
	failures := st.ConsecutiveFailures
	p.mu.Unlock()

	log.Printf("github-status: %s poll failed (attempt %d): %v", src.ID, failures, err)
	return backoffInterval(basePollInterval, failures)
}

// snapshotOf returns a copy of the cached state for a source.
func (p *Poller) snapshotOf(sourceID string) (SourceState, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	st, ok := p.state[sourceID]
	if !ok {
		return SourceState{}, false
	}
	return *st, true
}

// acknowledge clears a pending transition once the UI has shown its toast.
// Acking an ID that is not the pending one is a no-op, so a stale ack from an
// old browser tab cannot swallow a newer notification.
func (p *Poller) acknowledge(sourceID, transitionID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.state[sourceID]
	if !ok || st.Pending == nil || st.Pending.ID != transitionID {
		return false
	}
	st.Pending = nil
	return true
}

// setSnapshotForTest installs a snapshot without touching the network. Used
// by the demo/fixture mode and by tests.
func (p *Poller) setSnapshot(sourceID string, snap *Snapshot, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if st, ok := p.state[sourceID]; ok {
		st.Snapshot = snap
		st.FetchedAt = now
	}
}

// ---- fetching --------------------------------------------------------------

type fetchMeta struct {
	notModified bool
	maxAge      time.Duration
}

func (p *Poller) fetch(ctx context.Context, src Source) ([]byte, fetchMeta, error) {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, src.SummaryURL, nil)
	if err != nil {
		return nil, fetchMeta{}, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	p.mu.RLock()
	etag, lastMod := p.etags[src.ID], p.lastModified[src.ID]
	p.mu.RUnlock()
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastMod != "" {
		req.Header.Set("If-Modified-Since", lastMod)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fetchMeta{}, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}()

	meta := fetchMeta{maxAge: parseMaxAge(resp.Header.Get("Cache-Control"))}

	switch {
	case resp.StatusCode == http.StatusNotModified:
		meta.notModified = true
		return nil, meta, nil
	case resp.StatusCode != http.StatusOK:
		return nil, meta, fmt.Errorf("%s returned HTTP %d", src.SummaryURL, resp.StatusCode)
	}

	// 1 MiB is ~200x the real payload; anything larger is a wrong endpoint.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, meta, err
	}
	if len(body) == 0 {
		return nil, meta, errors.New("empty response body")
	}

	p.mu.Lock()
	p.etags[src.ID] = resp.Header.Get("ETag")
	p.lastModified[src.ID] = resp.Header.Get("Last-Modified")
	p.mu.Unlock()

	return body, meta, nil
}

// ---- interval math ---------------------------------------------------------

// pollInterval honors the server's Cache-Control while never polling faster
// than base. A provider asking us to wait longer than our own floor wins; a
// provider allowing a faster poll than our floor does not.
func pollInterval(base, maxAge time.Duration) time.Duration {
	if maxAge > base {
		if maxAge > maxPollInterval {
			return maxPollInterval
		}
		return maxAge
	}
	return base
}

// backoffInterval doubles the base interval per consecutive failure, capped.
// Deliberately un-jittered: a single desktop instance polling one endpoint
// gains nothing from jitter, and a deterministic schedule is testable.
func backoffInterval(base time.Duration, failures int) time.Duration {
	if failures <= 1 {
		return base
	}
	interval := base
	for i := 1; i < failures; i++ {
		interval *= 2
		if interval >= maxPollInterval {
			return maxPollInterval
		}
	}
	return interval
}

// parseMaxAge pulls max-age out of a Cache-Control header. Unparseable or
// absent means "no guidance", i.e. zero.
func parseMaxAge(header string) time.Duration {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(strings.ToLower(part), "max-age=") {
			continue
		}
		secs, err := strconv.Atoi(strings.TrimSpace(part[len("max-age="):]))
		if err != nil || secs < 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	return 0
}
