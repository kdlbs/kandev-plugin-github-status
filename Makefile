.PHONY: build test test-backend test-ui test-package-verifier test-release-version test-format-verifier \
	check-format fmt vet package package-host package-file verify-package \
	verify-package-host clean

BIN := bin/kandev-plugin-github-status
VERSION := 0.1.3
STAGE := .build/stage
PKG_OUT := kandev-plugin-github-status-$(VERSION).tar.gz
KANDEV_BACKEND := ../kandev/apps/backend

build:
	mkdir -p bin
	go build -o $(BIN) ./server/...

test: test-backend test-ui test-package-verifier test-release-version test-format-verifier

test-backend:
	go test ./server/...

test-ui:
	node --test tests/ui-action.test.mjs

test-package-verifier:
	sh scripts/test-verify-package.sh

test-release-version:
	sh scripts/test-verify-release-version.sh

test-format-verifier:
	sh scripts/test-check-format.sh

check-format:
	@files="$$(gofmt -l .)" || exit $$?; \
	test -z "$$files" || { echo "gofmt needed:"; printf '%s\n' "$$files"; exit 1; }

fmt:
	gofmt -l .

vet:
	go vet ./server/...

## Cross-compile every platform declared in manifest.yaml and package the exact
## runtime binaries, plugin assets, and manifest.
package:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r assets $(STAGE)/assets
	cp -r ui $(STAGE)/ui
	GOOS=linux GOARCH=amd64 go build -o $(STAGE)/server/plugin-linux-amd64 ./server
	GOOS=linux GOARCH=arm64 go build -o $(STAGE)/server/plugin-linux-arm64 ./server
	GOOS=darwin GOARCH=amd64 go build -o $(STAGE)/server/plugin-darwin-amd64 ./server
	GOOS=darwin GOARCH=arm64 go build -o $(STAGE)/server/plugin-darwin-arm64 ./server
	GOOS=windows GOARCH=amd64 go build -o $(STAGE)/server/plugin-windows-amd64.exe ./server
	go -C $(KANDEV_BACKEND) run ./cmd/plugin-pack -dir $(abspath $(STAGE)) -out $(abspath $(PKG_OUT))
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Package only the current host platform for a faster local smoke test.
package-host:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r assets $(STAGE)/assets
	cp -r ui $(STAGE)/ui
	go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server
	go -C $(KANDEV_BACKEND) run ./cmd/plugin-pack -dir $(abspath $(STAGE)) -out $(abspath $(PKG_OUT)) -platform-only
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

package-file:
	@printf '%s\n' "$(PKG_OUT)"

verify-package: package
	@set -eu; \
	VERIFY_DIR="$$(mktemp -d)"; \
	trap 'rm -rf "$$VERIFY_DIR"' EXIT; \
	test -f "$(PKG_OUT)" || { echo "package not found: $(PKG_OUT)" >&2; exit 1; }; \
	tar -xzf "$(PKG_OUT)" -C "$$VERIFY_DIR"; \
	sh scripts/verify-package.sh "$$VERIFY_DIR" full

verify-package-host: package-host
	@set -eu; \
	VERIFY_DIR="$$(mktemp -d)"; \
	trap 'rm -rf "$$VERIFY_DIR"' EXIT; \
	test -f "$(PKG_OUT)" || { echo "package not found: $(PKG_OUT)" >&2; exit 1; }; \
	tar -xzf "$(PKG_OUT)" -C "$$VERIFY_DIR"; \
	sh scripts/verify-package.sh "$$VERIFY_DIR" host "$$(go env GOOS)-$$(go env GOARCH)"

clean:
	rm -rf bin $(STAGE) kandev-plugin-github-status-*.tar.gz
