---
status: active
system: github-status
created: 2026-10-06
owners:
  - kandev-plugin-github-status maintainers
---

# Incident briefing requirements

## Overview

Developers open GitHub Status to understand whether provider problems may explain failures in their work. The briefing prioritizes affected services and the latest provider explanation, while preserving a quick scan of all monitored services. The plugin owns this presentation because it owns the provider-health snapshot.

## Terminology

- **Affected service:** A monitored service whose reported severity is not operational; maintenance is presented explicitly as maintenance.
- **Freshness:** The age of the last successful provider fetch, distinct from the time the user last rechecked the plugin cache.

## Requirements

### REQ-GHS-BRIEFING-001: Focused status briefing

**Intent:** Explain current provider impact before secondary service details.

#### Acceptance criteria

- **AC-GHS-BRIEFING-001.1:** When status is available, the briefing shall lead with the current monitored-service status and a concise summary of reported affected services. It shall qualify work impacts as possible, never diagnose a particular failed task, and distinguish maintenance from disruption. When all monitored services are operational but a relevant incident remains active, the summary shall identify the incident without claiming reported operational services are degraded. Unknown statuses shall display an explicit unknown label and shall not be described as confirmed healthy.
- **AC-GHS-BRIEFING-001.2:** The service list shall show all available monitored services, affected entries before healthy entries, preserving source order within each group. Affected entries shall have a thin status-colored outline on all four sides and a readable status label; healthy entries shall use quiet divider rows, a small status indicator, and a readable operational label. No entry shall use an accent stripe on its left edge. Missing service data shall be reported as unavailable rather than as healthy.
- **AC-GHS-BRIEFING-001.3:** Active incidents shall expose their full title, provider status, latest update, and update time, without ellipsizing essential content or nesting an update scroller. A history link shall open the provider incident page when its URL exists; no empty or fabricated history control shall appear otherwise. Scheduled maintenance and other affected services shall remain discoverable.
- **AC-GHS-BRIEFING-001.4:** Freshness shall remain visible next to a labeled Refresh control. Stale provider data and a failed cache recheck shall be distinguishable. Activating Refresh shall show busy feedback, prevent duplicate requests, preserve the last available snapshot, and expose failure feedback. A cache recheck shall not advance the displayed successful provider-fetch time unless the returned snapshot actually advances it.
- **AC-GHS-BRIEFING-001.5:** On fine-pointer desktop, Refresh shall measure 28px high within 1px and contain a legible icon plus its text label. On phone widths below 768px or coarse pointers, Refresh and standalone interactive disclosure controls shall have at least 44px active height; standalone icon targets shall also have at least 44px width. Keyboard focus shall be visible, and Enter/Space shall activate buttons.
- **AC-GHS-BRIEFING-001.6:** Desktop and phone shall share the same briefing order and data. Phone descriptions shall be expandable by an explicit keyboard/touch disclosure. Long service names, incident titles, translated labels, and provider messages shall wrap without document horizontal overflow. The host modal body shall remain the single vertical scroll owner, with safe-area clearance and no inaccessible final rows. Expanding a description shall not change provider state.
- **AC-GHS-BRIEFING-001.7:** All new and changed plugin-authored copy in the briefing shall use the plugin-scoped translation contract, with English, Portuguese (Portugal), Simplified Chinese, Hong Kong Traditional Chinese, Taiwan Traditional Chinese, Japanese, and Korean catalogs. Provider titles, names, and update bodies shall remain provider data. Older supported hosts shall retain an English fallback and the existing modal entry points.

## Out of scope

- Changing backend polling cadence, forcing a fresh provider fetch, changing severity/loudness policy, or adding a webhook.
- Fetching incident history into the plugin, making task-specific diagnoses, retrying developer operations, or adding settings.
- Host modal/lifecycle changes, committing, publishing, or replacing the user's installed plugin in this design turn.

## Implementation plans

- [Incident briefing plan](../../../plans/incident-briefing/plan.md).
