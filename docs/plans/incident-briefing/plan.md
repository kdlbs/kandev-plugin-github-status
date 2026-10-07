---
created: 2026-10-06
status: done
requirements:
  - REQ-GHS-BRIEFING-001
system_design:
  - ../../specs/github-status/system-design/incident-briefing.md
legacy_specs: []
---

# Incident briefing implementation plan

## Overview

Deliver one end-to-end plugin UI change: an impact-first briefing, quieter healthy rows, readable provider updates, and a clearly labeled Refresh action. Prior styling changes remain continuation context; this package replaces the all-rows-colored outline composition with affected-only outlines.

## Scope

Include the modal's available-data, healthy, maintenance, unknown, initial loading, stale, refreshing, and failed-recheck states. Exclude backend/schema changes, in-plugin incident history, task-specific advice, releases, and publication.

## Technical approach

Use the paired design's projection in `ui/bundle.js`, existing store/entry points, and scoped `ui/plugin.css`. Extend plugin translation catalogs. Use a local SVG for Refresh, a host Button with HTML fallback, and existing provider incident URLs. Update `docs/harness` only to support controlled busy/failure and responsive smoke scenarios. Preserve the Action/legacy entry behavior tested by `tests/ui-action.test.mjs`.

## ASCII UI preview

### UI-01: Desktop briefing, incident, opened from GitHub status action

```text
GitHub Status                                      [Close]
Checked 1 minute ago                        [icon Refresh]

4 GitHub services affected                   Partial outage
Git operations and workflow runs may be affected.

AFFECTED SERVICES
[Git Operations          Partial outage   [Details]]
[API Requests            Degraded         [Details]]
[Actions                 Partial outage   [Details]]
[Pull Requests           Degraded         [Details]]

HEALTHY SERVICES
Webhooks                  (dot) Operational [Details]
Issues                    (dot) Operational [Details]

LATEST INCIDENT
Identified                                      Updated 1h ago
Incident with Git Operations and Actions
Provider's latest update wraps here, without a nested scroller.
[View incident history]

Other provider context                     [githubstatus.com]
```

### UI-02: Phone briefing, same incident and entry point

```text
GitHub Status                       [Close]
Checked 1 minute ago        [icon Refresh]

4 GitHub services affected
Partial outage
Git operations and workflow runs
may be affected.

AFFECTED SERVICES
[Git Operations          Partial outage]
[Details]       <- touch disclosure
[API Requests                 Degraded]
[Details]
... other affected services ...

HEALTHY SERVICES
Webhooks            (dot) Operational
[Details]
Issues              (dot) Operational
[Details]

LATEST INCIDENT
Identified                 Updated 1h ago
Incident title wraps in full.
Latest provider update wraps in full.
[View incident history]
```

Requirements: same information order, affected-only full outlines, visible healthy rows, labeled Refresh, full incident text, one host-owned body scroll region, and phone touch dimensions. Spacing and example summaries are illustrative. The host owns fixed header/close and focus return. UI-01/UI-02 map to AC-GHS-BRIEFING-001.1 through .7.

### UI-03: Request and data states

```text
Initial: Checking GitHub status... [Refresh disabled]
Healthy: All monitored services operational + quiet service list
Stale:   Last known status. Checked 2h ago. [icon Refresh]
Busy:    Existing briefing preserved       [icon Refreshing...]
Failed:  Could not recheck status. Last known briefing preserved.
Unknown: Service status unavailable. Never claim confirmed healthy.
```

## Tests

Extend `tests/ui-action.test.mjs` with observable modal tests using its existing host/React harness: healthy/affected partition, incident-only elevation, maintenance, unknown/missing snapshot, provider fetch age, refresh deduplication and terminal failure, localization, and legacy entry/fallback.

## E2E tests

Add `tests/modal-browser.test.mjs` using a caller-provided Playwright module (this cloud image provides `/opt/full-worker/playwright-core`). The script starts an isolated local static server and tests the real plugin bundle/CSS/harness, not a screenshot mock. Cover UI-01/UI-02/UI-03, native disclosure, refresh icon+label/busy/failure, 28px desktop height, >=44px phone/coarse-pointer targets, zero page overflow, wrapped titles, and one body scroller. Include desktop 998px, phone 393px, 767/768px boundaries, and a coarse-pointer tablet. Do not hardcode the cloud module path inside the test. The SDK-pinned package and disposable Host smoke check are required before claiming installed integration verification.

## Work orders

- [x] [Task 01: Implement incident briefing](task-01-incident-briefing.md)

## Verification results

Implementation complete. All 18 UI tests and 14 real-bundle browser tests pass; Go tests, vet, format, and linux-amd64 package/checksum validation pass. README and actual implementation screenshots are updated. [Task 01 results](task-01-incident-briefing.md#results) record the evidence and isolated Host launch blocker: the installed Kandev bundle lacks `agentctl`, so installed Host integration is not verified. The primary installed plugin remains unchanged.

## Risks

- The existing backend maps unknown component statuses to operational severity. The UI must inspect raw status before presenting confirmed health, without changing backend policy.
- Only latest incident updates are available; history remains an outbound provider link.
- Refresh reads cached provider state; freshness must not falsely advance.
- Host modal correctness needs a disposable-instance smoke test, not just the harness.
- The SDK replace path expects `../kandev/apps/backend`, which is absent in this cloud checkout. Package smoke needs the pinned SDK ref resolved in a sibling checkout before building; do not silently build against an arbitrary host ref.
