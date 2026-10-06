---
status: active
system: github-status
specification_version: 1
migration: complete
owners:
  - kandev-plugin-github-status maintainers
---

# GitHub Status

## Purpose and ownership

This plugin owns the provider-health snapshot, polling lifecycle, notification preferences, and the native status briefing that explains GitHub availability to developers. The standalone plugin repository owns these contracts; the Kandev monorepo owns the Host API, theme, modal container, and plugin lifecycle.

## Exclusions

The plugin does not diagnose individual tasks, check repository permissions, or determine whether a particular push or workflow succeeded. It does not own GitHub's incident reporting.

## Find specifications

From this repository, use the host checkout's catalog helper:

```sh
python3 /workspace/scripts/list-docs.py --root . specs --system github-status --format paths
```

## Related contracts

- [Plugin overview](../../../README.md): existing polling, SDK, and packaging behavior.
- Host localization and control sizing remain Kandev-owned; this plugin consumes those contracts without changing them.
