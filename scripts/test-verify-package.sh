#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
verify_script=$repo_dir/scripts/verify-package.sh
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

create_fixture() {
	fixture=$1
	mkdir -p "$fixture/server" "$fixture/ui" "$fixture/assets"
	cp "$repo_dir/manifest.yaml" "$fixture/manifest.yaml"
	cp "$repo_dir/assets/icon.svg" "$repo_dir/assets/NOTICE.md" "$fixture/assets/"
	cp "$repo_dir/ui/bundle.js" "$repo_dir/ui/plugin.css" "$fixture/ui/"
	for executable in \
		plugin-linux-amd64 plugin-linux-arm64 \
		plugin-darwin-amd64 plugin-darwin-arm64 \
		plugin-windows-amd64.exe; do
		printf 'fixture binary: %s\n' "$executable" > "$fixture/server/$executable"
	done
	write_checksums "$fixture"
}

write_checksums() {
	fixture=$1
	(
		cd "$fixture"
		find . -type f ! -name checksums.txt -print | sed 's#^\./##' | LC_ALL=C sort |
			while IFS= read -r path; do
				if command -v sha256sum >/dev/null 2>&1; then
					sha256sum "$path"
				else
					shasum -a 256 "$path"
				fi
			done
	) > "$fixture/checksums.txt"
}

copy_fixture() {
	name=$1
	fixture=$test_dir/$name
	mkdir -p "$fixture"
	cp -R "$test_dir/valid/." "$fixture/"
}

expect_failure() {
	name=$1
	fixture=$2
	mode=${3-full}
	platform=${4-}
	if [ "$mode" = host ]; then
		if sh "$verify_script" "$fixture" host "$platform" > "$test_dir/output" 2>&1; then
			printf 'expected package verification to reject %s\n' "$name" >&2
			exit 1
		fi
	elif sh "$verify_script" "$fixture" full > "$test_dir/output" 2>&1; then
		printf 'expected package verification to reject %s\n' "$name" >&2
		exit 1
	fi
}

mkdir -p "$test_dir/valid"
create_fixture "$test_dir/valid"
sh "$verify_script" "$test_dir/valid" full >/dev/null

host_platform=$(go env GOOS)-$(go env GOARCH)
copy_fixture host-valid
host_fixture=$test_dir/host-valid
host_executable=$(awk -v platform="$host_platform" \
	'$0 ~ "    " platform ":" { gsub(/"/, "", $2); print $2 }' \
	"$host_fixture/manifest.yaml")
[ -n "$host_executable" ] || {
	printf 'fixture does not declare host platform %s\n' "$host_platform" >&2
	exit 1
}
for executable in "$host_fixture"/server/*; do
	[ "$executable" = "$host_fixture/$host_executable" ] || rm "$executable"
done
write_checksums "$host_fixture"
sh "$verify_script" "$host_fixture" host "$host_platform" >/dev/null

for required in \
	manifest.yaml assets/icon.svg assets/NOTICE.md \
	ui/bundle.js ui/plugin.css \
	server/plugin-linux-amd64 server/plugin-linux-arm64 \
	server/plugin-darwin-amd64 server/plugin-darwin-arm64 \
	server/plugin-windows-amd64.exe; do
	copy_fixture "missing-${required##*/}"
	fixture=$test_dir/missing-${required##*/}
	rm "$fixture/$required"
	write_checksums "$fixture"
	expect_failure "missing $required" "$fixture"
done

copy_fixture missing-checksums
rm "$test_dir/missing-checksums/checksums.txt"
expect_failure 'missing checksums.txt' "$test_dir/missing-checksums"

copy_fixture corrupt-ui
printf '// changed after checksum generation\n' >> "$test_dir/corrupt-ui/ui/bundle.js"
expect_failure 'corrupt UI contents' "$test_dir/corrupt-ui"

copy_fixture incomplete-checksums
sed '/  ui\/bundle.js$/d' "$test_dir/incomplete-checksums/checksums.txt" \
	> "$test_dir/incomplete-checksums/checksums.next"
mv "$test_dir/incomplete-checksums/checksums.next" \
	"$test_dir/incomplete-checksums/checksums.txt"
expect_failure 'an omitted checksum entry' "$test_dir/incomplete-checksums"

copy_fixture duplicate-checksum
cat "$test_dir/duplicate-checksum/checksums.txt" \
	"$test_dir/duplicate-checksum/checksums.txt" > "$test_dir/duplicate-checksum/checksums.next"
mv "$test_dir/duplicate-checksum/checksums.next" \
	"$test_dir/duplicate-checksum/checksums.txt"
expect_failure 'a duplicate checksum entry' "$test_dir/duplicate-checksum"

copy_fixture unexpected-file
printf 'unexpected\n' > "$test_dir/unexpected-file/extra.txt"
write_checksums "$test_dir/unexpected-file"
expect_failure 'a checksummed unexpected file' "$test_dir/unexpected-file"

copy_fixture unexpected-symlink
ln -s ui/bundle.js "$test_dir/unexpected-symlink/extra.js"
write_checksums "$test_dir/unexpected-symlink"
expect_failure 'an unexpected symlink' "$test_dir/unexpected-symlink"

copy_fixture unexpected-fifo
mkfifo "$test_dir/unexpected-fifo/extra.pipe"
expect_failure 'an unexpected FIFO' "$test_dir/unexpected-fifo"

copy_fixture wrong-icon
sed 's#icon: "assets/icon.svg"#icon: "assets/other.svg"#' \
	"$test_dir/wrong-icon/manifest.yaml" > "$test_dir/wrong-icon/manifest.next"
mv "$test_dir/wrong-icon/manifest.next" "$test_dir/wrong-icon/manifest.yaml"
write_checksums "$test_dir/wrong-icon"
expect_failure 'a manifest icon outside the package contract' "$test_dir/wrong-icon"

copy_fixture wrong-host-platform
expect_failure 'an undeclared host platform' "$test_dir/wrong-host-platform" host freebsd-amd64

printf 'package verifier negative tests passed\n'
