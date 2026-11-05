package main

import (
	"os"
	"strings"
	"testing"
)

func TestVerifyHostManifest(t *testing.T) {
	source, err := os.ReadFile("../../manifest.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// plugin-pack rewrites the host manifest, removes other executable entries,
	// and includes empty fields from the backend manifest model.
	normalized := strings.ReplaceAll(string(source), `"`, "")
	lines := strings.Split(normalized, "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.Contains(line, ": server/plugin-") && !strings.HasPrefix(line, "    linux-amd64:") {
			continue
		}
		kept = append(kept, line)
	}
	normalized = strings.Join(kept, "\n") + "base_url: \"\"\nendpoints:\n  health: \"\"\n  events: \"\"\n  webhooks: \"\"\n"
	for _, tc := range []struct {
		name, body string
		ok         bool
	}{
		{"normalized host", normalized, true},
		{"unfiltered manifest", string(source), false},
		{"capability changed", strings.Replace(normalized, "state: true", "state: false", 1), false},
		{"minimum changed", strings.Replace(normalized, "0.99.0", "0.98.0", 1), false},
		{"API changed", strings.Replace(normalized, "api_version: 1", "api_version: 2", 1), false},
		{"UI changed", strings.Replace(normalized, "/ui/bundle.js", "/ui/other.js", 1), false},
		{"webhook changed", strings.Replace(normalized, "key: ack", "key: other", 1), false},
		{"extra field", normalized + "unreviewed: true\n", false},
		{"malformed YAML", "not: [yaml", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyHostManifest(source, []byte(tc.body), "linux-amd64")
			if (err == nil) != tc.ok {
				t.Fatalf("error = %v, want success %v", err, tc.ok)
			}
		})
	}
	if err := verifyHostManifest(source, []byte(normalized), "freebsd-amd64"); err == nil {
		t.Fatal("accepted undeclared platform")
	}
}
