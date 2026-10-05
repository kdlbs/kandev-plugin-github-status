#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
cat > "$test_dir/bin/gofmt" <<'EOF'
#!/bin/sh
exit 42
EOF
chmod +x "$test_dir/bin/gofmt"

if PATH="$test_dir/bin:$PATH" make --no-print-directory -C "$test_dir" \
	-f "$repo_dir/Makefile" check-format > "$test_dir/output" 2>&1; then
	printf 'check-format accepted a failing gofmt command with empty output\n' >&2
	exit 1
fi

printf 'check-format failure propagation test passed\n'
