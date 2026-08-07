# Status fixtures

Statuspage `summary.json` bodies, embedded into the plugin binary
(`server/demo.go`) and used two ways:

- as the inputs to `server/statuspage_test.go`, so the parser is exercised
  against realistic payloads rather than hand-shrunk ones, and
- as `?demo=<name>` responses on the `status` webhook, which is the only way
  to see or screenshot the degraded / outage / maintenance UI — GitHub is up
  essentially all of the time.

| File | Demo name(s) | State |
| --- | --- | --- |
| `healthy.json` | `healthy` | All components operational, no incidents |
| `degraded.json` | `degraded`, `stale` | Actions `degraded_performance`, one unresolved `minor` incident |
| `incident.json` | `incident` | Git Operations `partial_outage` + Actions `major_outage`, unresolved `major` incident with three updates |
| `critical.json` | `critical` | Every key component `major_outage`, unresolved `critical` incident |
| `maintenance.json` | `maintenance` | All key components operational; one upcoming and one in-progress scheduled maintenance |

`healthy.json` is a verbatim capture of
`https://www.githubstatus.com/api/v2/summary.json` taken 2026-08-07. The other
four are derived from it by editing component statuses and adding
incident/maintenance objects, so they keep the real payload's field set,
component ids, and HTML-bearing update bodies (`<br />` and `&amp;` both appear
on purpose — the parser has to strip them).

`stale` reuses `degraded.json` and is rendered as a cached-but-stale response
(failed fetches, old `fetchedAt`) rather than being a distinct payload.
