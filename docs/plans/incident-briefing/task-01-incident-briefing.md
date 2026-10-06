---
id: 01-incident-briefing
title: Implement incident briefing
status: done
wave: 1
depends_on: []
plan: plan.md
requirements:
  - REQ-GHS-BRIEFING-001
acceptance_criteria:
  - AC-GHS-BRIEFING-001.1
  - AC-GHS-BRIEFING-001.2
  - AC-GHS-BRIEFING-001.3
  - AC-GHS-BRIEFING-001.4
  - AC-GHS-BRIEFING-001.5
  - AC-GHS-BRIEFING-001.6
  - AC-GHS-BRIEFING-001.7
system_design:
  - ../../specs/github-status/system-design/incident-briefing.md
---

# Task 01: Implement incident briefing

## Summary

Implement the agreed modal hierarchy and Refresh treatment using the plugin's existing payloads, store, translations, and host entry points. Prove logic with targeted Node tests and real browser interactions, then package and smoke-test against a disposable Host before reporting installed integration verified.

## In scope

- Pure briefing projection, affected-first service presentation, visible quiet healthy entries, semantic details disclosures, and wrapped latest incident updates with provider history links.
- Shared refreshing/error state, labeled SVG Refresh button, accurate provider-fetch age, phone/coarse-pointer targets, focus states, and seven-language catalog coverage for all changed modal copy.
- Targeted unit/browser tests, reusable harness scenarios, README description and incident/maintenance screenshots, package-host validation and disposable Host smoke evidence.

## Out of scope

Backend polling/DTO changes, new webhooks, fetched incident history, task-specific diagnoses or operation retries, Host UI API changes, version release/publication, and changing the primary installed instance.

## Acceptance

1. UI-01/UI-02/UI-03 match the paired design and AC-GHS-BRIEFING-001.1 through .7 with healthy, affected, maintenance, unknown, missing, stale, and request-error states.
2. New state/projection tests fail before implementation and pass afterward; existing entry-point tests continue to pass. Browser tests prove interactions and measured desktop/touch dimensions.
3. README/screenshots match the new modal. Source and package validation pass; a disposable Host proves modal scroll/focus and plugin load integration, or its exact external blocker is explicitly reported without claiming integration verified.

## ASCII UI preview

[Full UI-01/UI-02/UI-03 previews](plan.md#ascii-ui-preview).

```text
UI-01 desktop: Checked time [icon Refresh] -> impact summary
               -> affected outlined rows -> quiet healthy rows
               -> full latest incident [View incident history]
UI-02 phone:   Same order; wrapped text; [Details] touch disclosure;
               Refresh/disclosures >=44px; one body scroll owner.
UI-03 busy:    Preserve briefing; disable [icon Refreshing...].
```

## Verification

Run from the standalone plugin repository, with the host helper paths adjusted only when the checkout location differs:

```sh
node --test tests/ui-action.test.mjs
GHS_PLAYWRIGHT_MODULE=/opt/full-worker/playwright-core node --test tests/modal-browser.test.mjs
python3 /workspace/scripts/list-docs.py --root . validate
python3 /workspace/scripts/lint-spec-files.py --all
git diff --check
```

After resolving the exact `.kandev-sdk-ref` to the expected sibling checkout, run:

```sh
make test
make vet
make check-format
make verify-package-host
```

Install the resulting host archive into an isolated disposable Kandev instance, open healthy/incident/stale/maintenance modals on desktop and phone, and verify the shared control, descriptions, history navigation, refresh feedback, scrolling, focus return, and disable/re-enable. Never upload to the primary instance. Record the actual platform and archive name. Publishing and a manifest version bump belong to a separately authorized release.

## Files likely touched

- `ui/bundle.js`, `ui/plugin.css`
- `tests/ui-action.test.mjs`, new `tests/modal-browser.test.mjs`
- `docs/harness/demo.js`, `docs/harness/index.html` only as necessary for test scenarios
- `README.md`, `docs/modal-incident.png`, `docs/modal-maintenance.png`
- This plan/package's statuses and results

## Dependencies

None. Preserve the prior border cleanup already in the working tree.

## Risks

Use the plan's four data/Host constraints and pinned-SDK packaging limitation. Older host fallback and live locale updates need direct tests. Do not bundle another React runtime or change the notification baseline.

## Parallelism

sequential

## Inputs

- [Requirements](../../specs/github-status/requirements/incident-briefing.md)
- [System design](../../specs/github-status/system-design/incident-briefing.md)
- `ui/bundle.js` existing `createStore`, `useActionTranslator`, `StatusPanel`, `ComponentRow`, `IncidentCard`, and `openStatusModal`.
- `tests/ui-action.test.mjs` host/React hook harness and `docs/harness/demo.json` backend fixtures.

## Design preparation

Catalog: 0 decisions and 3 specification documents validated. Specification lint passes using the plugin-local spec-lint.json defaults. The host specification linter regression suite passes all 36 tests. Temporary standalone desktop (998px) and phone (393px) preview screenshots inspected; Refresh measures 28px and 44px respectively, disclosures and simulated busy feedback work, and document horizontal overflow is absent. This is prototype evidence only; production behavior and Host integration remain untested. Exact source-edit scope checked: this design turn changes only docs/specs and docs/plans; earlier README/CSS styling edits remain untouched.

## Results

Implemented the impact-first briefing, affected-only full borders, quiet healthy rows, native description disclosures, untruncated incident updates/history links, shared Refresh progress/error state, provider-fetch age, and seven-language copy. Existing Action/legacy modal entry points remain covered.

Validation:

- UI tests: 18 pass. New projection/request tests failed before implementation. The missing-fetch-time test separately failed before the corrected copy. The deferred refresh test asserts an actual two-minute fetch age through busy and error states.
- Browser tests: 14 pass against the production bundle/CSS. Initial Refresh measurements failed before the style change. Passing coverage includes 998px desktop, 393px fine/coarse pointers, 767/768px breakpoints, 820px coarse-pointer tablet, keyboard disclosure, footer scroll reachability, healthy/stale/maintenance/critical data, and Portuguese copy. The deferred error case preserves a measured provider age.
- Go tests, negative package/release/format-verifier tests, vet, and Go format checks pass. The exact SDK commit was extracted to `/tmp/github-status-validation/kandev`; a temporary Go workspace provided the pinned replacement without changing this repository's module files.
- Linux-amd64 host package rebuilt and verified: `kandev-plugin-github-status-0.3.0.tar.gz`. Manifest, binary, bundle, CSS, assets, and every checksum pass.
- Specification catalog/lint and diff checks pass. README and incident/maintenance screenshots now describe and render the implemented briefing.

Disposable Host smoke is blocked: `/usr/local/bin/kandev` v0.93.0 exits with `agentctl binary not found in bundle at /app/apps/backend/bin/agentctl`. The attempted launch used `/tmp/github-status-validation/runtime`, its own database path, mock profile, and port 38971. No primary-instance data or installation was changed. Host plugin loading, modal focus return, and disable/re-enable are not claimed verified.

The actual plugin bundle/CSS was captured with controlled provider fixtures at `/workspace/github-status-implemented.png` and `/workspace/github-status-implemented-mobile.png` and shown through Kandev's native file preview. Capture-only fixture timestamps were shifted to preserve relative incident age and supplied an explicit sample fetch timestamp; production never substitutes generated time for fetch time. A local sans-serif font was embedded only in the browser capture to avoid the VM's incorrect system font fallback.
