# Changelog

## [0.1.0] - 2026-08-08

Initial release.

### Added

- Polls `githubstatus.com`'s Statuspage `summary.json` on a 60s floor, with
  conditional GETs (`ETag` / `Last-Modified`), an identifying User-Agent,
  exponential backoff to 15 minutes, and a last-good cache reported as *stale*
  rather than flapping to "unknown" on a single failed fetch.
- Severity driven by the six components kandev depends on (Git Operations, API
  Requests, Webhooks, Actions, Pull Requests, Issues) plus unresolved incidents
  naming one of them. GitHub's page-level indicator is displayed for context
  but never drives the colour, so an outage confined to Copilot or Codespaces
  leaves the UI quiet.
- `app-status-bar-right` chip: recessed while healthy, severity-coloured when
  not, hollow dot when stale.
- `main-top-bar` indicator: a 32×32 severity-tinted GitHub mark with a pulsing
  pip, rendered only during a degradation.
- Click-through modal with the key components, active incidents (impact,
  status, latest update with HTML stripped, timestamp), upcoming scheduled
  maintenance, and a link out.
- Transition toasts that fire only on a change, acknowledged by a stable id so
  a reload never replays one; the last-notified severity is persisted in Host
  state so a restart mid-outage stays silent.
- `plugin-settings` toggle for the notification behaviour.
- Config-driven source table (`server/sources.go`) so another Statuspage-backed
  provider is a data change; GitHub ships as the only enabled source.
- Five fixtures plus an offline render harness, since the degraded states are
  otherwise unreachable.
