---
status: current
system: github-status
requirements:
  - REQ-GHS-BRIEFING-001
---

# Incident briefing system design

## Purpose and boundaries

Replace the current repeated-card status modal with an impact summary, prioritized service list, readable incident briefing, and a visible freshness toolbar. This is a standalone plugin change. Existing Host API, backend projection, permissions, notification delivery, and manifest remain unchanged.

## Requirement mapping

| Requirement | Design sections |
| --- | --- |
| REQ-GHS-BRIEFING-001 | Projection; composition; refresh; responsive presentation; localization and compatibility |

## Existing data and projection

`server/statuspage.go` projects `Component`, `Incident`, and `Snapshot`. `Snapshot.keyComponents` supplies name, description, raw status, and semantic severity. Incident data includes only `latestUpdate`, `latestUpdateAt`, component names, status, and `url`; it has no history array. `statusPayload.fetchedAt`, `stale`, `error`, and `consecutiveFailures` describe provider fetch state. `handleStatus` serves the poller's cache.

Add a small pure briefing projection inside the no-build `ui/bundle.js`, beside the current status vocabulary. Partition components without mutating the source snapshot. A component is confirmed healthy only when its raw status is `operational`; an unknown raw status must not inherit the backend's operational fallback as confirmed health. Preserve provider order within affected/healthy groups. Known non-operational statuses retain existing colors and labels; unknown uses a neutral outline and explicit unknown label.

Summary copy uses a generic localized disruption/maintenance/healthy/unknown headline plus reported affected service names. If incident severity elevates `payload.overall` while key services are operational, describe an active incident rather than inventing degraded components. Work-impact hints are conservative, localized mappings for recognized Git Operations/Actions/API Requests/Pull Requests/Webhooks/Issues names, with a generic fallback for unrecognized services. Do not recommend retrying or claim that an operation has failed.

## Composition

Keep `StatusPanel`, `ComponentRow`, `IncidentCard`, `Pill`, and `openStatusModal` as the existing rendering/entry boundaries. Extract a freshness toolbar and service-group component only as needed to keep `StatusPanel` readable.

Order: freshness toolbar; compact summary; affected service list; healthy service list; latest incident briefing; maintenance; secondary provider context/footer. Use 1px full status outlines for affected service rows. Healthy rows use neutral dividers with a small dot and explicit text, without an enclosing card for each row. The root modal owns the visual frame. Keep healthy services visible, not hidden behind a healthy-count disclosure.

Descriptions are secondary inline expandable content in both viewports, preserving state during polling rerenders. Use semantic `details`/`summary` or an explicit localized disclosure button; do not make the whole service row clickable when it has no destination. Incident title and latest update wrap. Remove `ghs-inc-body`'s nested max-height scroller and title ellipsis. Link the labeled history action to `incident.url`, using a new tab and `rel=noreferrer`; omit it when no URL exists. Do not fabricate older updates.

## Refresh and failure behavior

The freshness toolbar is outside the colored summary band, so the action has sufficient contrast. Refresh is an icon plus localized text, using `host.ui.Button` when available with a semantic HTML button fallback. A plugin-owned SVG uses currentColor with an approximately 16px icon box; do not rely on a Unicode refresh glyph.

`createStore.load` retains existing in-flight request deduplication. Expose request progress through a shared `refreshing` state while preserving `loading` for the initial state. Mark progress after the in-flight handle is assigned, clear it on every terminal path, and do not clear `payload` during rechecks. Refresh binds to `store.refresh`, is disabled while refreshing, and exposes a localized busy label plus `aria-busy`. Preserve rejection feedback in `error`; render a visible live status message without replacing known provider content. Initial loading and no-data failure remain explicit states.

`fetchedAt` stays the only age source; clicking Refresh never writes a new timestamp locally. A missing or invalid fetch timestamp displays an explicit unavailable-time label, independently of service availability. Provider stale warnings name the cached state. Relay failures use separate recheck error copy even when the provider snapshot was fresh.

## Responsive presentation and accessibility

Nearest shipped exemplar: the current plugin status modal consuming the host modal container. Preserve the common content order; adapt the freshness toolbar to wrap with a visible 44px Refresh action on phones/coarse pointers. This is frequently inspected transient provider context, so retain the existing modal entry point rather than adding navigation or a new drawer. Kandev owns the modal's presentation, focus return, dismissal, safe-area geometry, and body scroll; verify these against the actual host as well as the harness.

Refresh base height is 1.75rem (28px), with no fixed width. Apply a 2.75rem minimum only under `(max-width: 767px)` or `(pointer: coarse)`. Match scoped disclosure target sizing. Use min-width:0, wrapping text, and safe-area padding when needed; do not create a second vertical scroll owner. Preserve focus outlines and reduced-motion behavior. Verify a narrow fine-pointer viewport independently of pointer type.

## Localization and compatibility

Extend the existing `STATUS_ACTION_TRANSLATIONS` registration or rename the catalog to a general plugin-copy name with all references updated. Reuse `useActionTranslator` for live translations and fallback interpolation; avoid module-scope translation calls. Translate status and maintenance labels used in changed markup, time frames, counts using host-supported plural forms, disclosure labels, summary hints, freshness, errors, and Refresh states. Use the existing host plugin-localization contract, not private i18next imports. Provider data and control-flow severity/status values remain untouched.

The existing legacy Button/Action selection and `openStatusModal` fallback remain. No new Host export, SDK dependency, release flag, permission, persistence, or backend schema is needed.

## Verification and delivery

[The plan](../../../plans/incident-briefing/plan.md) owns the targeted Node and browser tests. UI hook tests prove projection/state/fallback behavior. Browser tests load the real bundle and CSS with fixture responses, assert priority, disclosure, busy/error behavior, and rendered geometry at desktop, phone fine/coarse pointer, and coarse-pointer tablet sizes. The independent host smoke check proves integration geometry and focus behavior; an offline harness alone does not establish Host modal correctness.

Existing Host contracts: Kandev ADR 2026-08-12 (plugin localization), ADR 2026-09-25 (additive plugin action chrome), and Kandev mobile-parity/control-sizing guidance. This design consumes those contracts and makes no new architecture decision.
