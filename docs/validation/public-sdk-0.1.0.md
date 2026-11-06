# Public SDK 0.1.0 migration validation

Recorded on 2026-11-05 for migration PR #8, based on default branch `main` at
`837b7707ab5c977a49e0d93caf52b47fc9c9fc6b`. The public
[authoring guide](https://github.com/kdlbs/kandev/blob/main/docs/public/plugins-authoring.md)
and [migration handoff](https://github.com/kdlbs/kandev/blob/main/docs/plans/plugin-sdk-publishing/template-migration.md)
define the dependency and packaging contract.

The [verified SDK release](https://github.com/kdlbs/kandev/releases/tag/pluginsdk/v0.1.0)
resolves to `f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`. The downloaded
`github.com/kdlbs/kandev/pluginsdk@v0.1.0/sdk-release.json` contains SDK `0.1.0`,
host release `0.99.0`, minimum host `0.99.0`, and API versions `[1, 2]`.
The plugin retains API v1, plugin version `0.4.0`, permissions, webhooks,
platform declarations, and its existing UI assets. No npm SDK dependency,
package manifest, npm lockfile, TypeScript project, or generated protocol
imports exist here. npm installation/typecheck steps therefore do not apply.
The UI is a no-build JavaScript bundle using the injected host API.

Validation used Go `1.26.6`, Node `24.19.0`, and Linux amd64. The commands
below use a fresh temporary directory; run them from a checkout of this PR.
The standalone plugin's parent contains only that checkout. The separate
tooling source is not an SDK compilation input.

```bash
task_tmp="$(mktemp -d)"
mkdir "$task_tmp/standalone"
git clone --no-local . "$task_tmp/standalone/plugin"
cd "$task_tmp/standalone/plugin"
GOWORK=off go mod download
GOWORK=off go mod verify
GOWORK=off go mod tidy
git diff --exit-code -- go.mod go.sum
GOWORK=off go list -m all
make check-format
GOWORK=off make vet test build

# Also resolve from an empty module cache using the public proxy/checksum DB:
GOWORK=off GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
  GOMODCACHE="$task_tmp/public-modcache" go mod download
GOWORK=off GOMODCACHE="$task_tmp/public-modcache" go mod verify
```

All commands passed. The selected graph contains public
`github.com/kdlbs/kandev/pluginsdk v0.1.0`, no backend module, and no
replacement. Go tests cover the actual `server/...` and host-manifest verifier
packages; vet covers both. `make test` also passes all 18 UI action tests and
four smoke-script startup/cleanup/path regression tests, plus the package,
release-version, and format-verifier negative checks.
`make build` invokes the installed-dependency compatibility checker:

```bash
go run github.com/kdlbs/kandev/pluginsdk/cmd/kandev-sdk-check@v0.1.0 \
  --manifest manifest.yaml
# SDK 0.1.0: compatible (minimum Kandev 0.99.0)
```

Packaging retains backend-owned tooling at the separate
`.kandev-tooling-ref` commit, `f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`.
The tooling checkout includes `apps/backend` and root `pluginsdk`, which the
backend module itself replaces locally. That replacement is confined to the
packaging tool's module; the plugin consumes the public module.

```bash
git clone --filter=blob:none --no-checkout https://github.com/kdlbs/kandev.git \
  "$task_tmp/tooling"
git -C "$task_tmp/tooling" sparse-checkout set apps/backend pluginsdk
git -C "$task_tmp/tooling" checkout --detach "$(cat .kandev-tooling-ref)"
GOWORK=off make verify-package-host \
  KANDEV_BACKEND="$task_tmp/tooling/apps/backend"
CGO_ENABLED=0 GOWORK=off make verify-package \
  KANDEV_BACKEND="$task_tmp/tooling/apps/backend"
tar -tvzf kandev-plugin-github-status-0.4.0.tar.gz
sha256sum kandev-plugin-github-status-0.4.0.tar.gz
```

Both package verifications passed. Full inventory: manifest, GitHub icon and
NOTICE, UI bundle/CSS, all five declared platform executables, and generated
`checksums.txt`; every checksum passed. The full artifact SHA-256 was
`1cbb98f8f3431094419c76c08597b5cd6e7ddf48c17f7f5efa801d55ea14f979`.
Only the Linux amd64 executable was run; other platforms were cross-compiled
and inspected. The executor exports `CGO_ENABLED=1`; an initial cross-build
failed in the host assembler, so the successful full build explicitly disabled
CGO for this pure-Go plugin. No cross-compilation failure was hidden.

Current `plugin-pack -platform-only` reserializes YAML and restricts the manifest
to the host executable. The old verifier rejected this legitimate output.
Host-only verification now compares YAML semantics while permitting only that
executable-map change and the backend model's empty default fields. Regression
tests reject changed capabilities, minimum host, API version, UI bundle,
webhooks, extra fields, malformed YAML, and an undeclared platform. Full-package
verification still requires exact manifest bytes. Asset bytes, exact inventory,
and all checksums remain checked in both modes.

Minimum-host testing used the public `v0.99.0` Linux x64 binary from
[the host release](https://github.com/kdlbs/kandev/releases/tag/v0.99.0), verified
against its published SHA-256 file. `kandev __backend -version` reported
`v0.99.0`, source commit `f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`.
An empty environment, temporary user home, dedicated Kandev directory, and
loopback port kept this separate from the developer's running instance:

```bash
mkdir -p "$task_tmp/host" "$task_tmp/user-home" "$task_tmp/smoke-home"
gh release download v0.99.0 --repo kdlbs/kandev \
  --pattern kandev-linux-x64.tar.gz --pattern kandev-linux-x64.tar.gz.sha256 \
  --dir "$task_tmp/host"
(cd "$task_tmp/host" && sha256sum -c kandev-linux-x64.tar.gz.sha256 && \
  tar -xzf kandev-linux-x64.tar.gz)
# Run the following server command in another terminal with the same task_tmp
# value. Return to the plugin checkout after /health responds with HTTP 200.
env -i HOME="$task_tmp/user-home" PATH="$PATH" \
  KANDEV_HOME_DIR="$task_tmp/smoke-home" KANDEV_SERVER_HOST=127.0.0.1 \
  KANDEV_FEATURES_AUTH=false KANDEV_FEATURES_PLUGINS=true \
  KANDEV_DOCKER_ENABLED=false \
  "$task_tmp/host/kandev/bin/kandev" __backend -port 38941
curl --fail -F "package=@kandev-plugin-github-status-0.4.0.tar.gz" \
  http://127.0.0.1:38941/api/plugins/install
node scripts/smoke-minimum-host.mjs http://127.0.0.1:38941
```

Host-only and full archives were installed separately, uninstalling the previous
same-version install first. Both started active. The API smoke passed live
GitHub polling, all six demo payloads, ack and settings method/body rejection,
Host settings persistence across subprocess disable/enable, and exact served
bundle/CSS bytes. The live poll used the public provider; incident demo payloads
are fixtures, not claims of a real incident. Authentication was disabled only in
this disposable instance; authenticated-host policy was not changed or certified.

Browser validation used Playwright `1.61.1` installed outside the repository and
its existing Chromium revision `1228`. On this Nix executor, `LD_LIBRARY_PATH`
pointed to the existing Nix library directories needed by Chromium. No browser
or SDK dependencies were added to this plugin's npm graph.

On another runner, provide Chromium's normal platform libraries or set
`LD_LIBRARY_PATH` to that runner's library directories; no executor-specific
library-list file is required. Install browser tooling outside the plugin:

```bash
npm install --prefix "$task_tmp/browser" --ignore-scripts playwright@1.61.1
"$task_tmp/browser/node_modules/.bin/playwright" install chromium
GHS_PLAYWRIGHT_MODULE="$task_tmp/browser/node_modules/playwright" \
  node --test tests/modal-browser.test.mjs
GHS_HOST_URL=http://127.0.0.1:38941 \
  GHS_PLAYWRIGHT_MODULE="$task_tmp/browser/node_modules/playwright" \
  node --test tests/minimum-host-browser.test.mjs
```

The offline browser suite passed 14/14 after controlling the harness rejection
clock: a busy executor could previously miss the 300ms pending-state window.
The test still asserts the disabled busy control, refresh label, error,
unchanged provider age, preserved briefing, and enabled final control.
`tests/modal-browser.test.mjs` changed: it installs a fake clock, pauses before
the click, asserts the pending state directly, then advances the rejection timer
and waits for the error. Production files under `ui/` and fixture/harness files
under `docs/harness/` are unchanged. Earlier optional native-browser
attempts also timed out during a heavily loaded executor run with minimum-host
SQLite probe failures and HTTP 503s. The final API and native-browser runs
passed after restarting the disposable host; the native test passed 1/1.

The installed native Action and incident modal were also opened in the actual
minimum-host browser, displaying all six services and the incident briefing.
The optional integration test exercises native refresh, two disable/enable
cycles with reloads, and the plugin settings surface. The chat-topbar
registration is covered by the fixture-based UI tests; no live task agent or
real outage transition was created in this disposable host.

This migration neither publishes a plugin release nor changes catalog versions.

Review follow-up adds startup-null and cleanup-failure smoke regressions, a
relative-package-path regression, field-specific manifest diagnostics, and a
loaded-panel wait in the native browser test. These are verification changes;
they do not alter the packaged plugin behavior.

The follow-up review also adds a checkout-path-with-spaces smoke regression and
makes expected manifest diagnostics explicit table data rather than test-name
conditions. All four smoke regressions run under `make test`.
