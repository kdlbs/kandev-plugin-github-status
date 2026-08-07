package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// TestDumpDemoJSON writes every demo fixture's *status webhook payload* to the
// directory in GHS_DUMP_DEMO, so the screenshot harness renders exactly the
// bytes the frontend receives in production rather than a hand-written mock.
// No-op under a normal `make test` run. The path is relative to the package
// directory (server/), which is where `go test` runs:
//
//	GHS_DUMP_DEMO=../docs/harness go test ./server/ -run TestDumpDemoJSON
func TestDumpDemoJSON(t *testing.T) {
	dir := os.Getenv("GHS_DUMP_DEMO")
	if dir == "" {
		t.Skip("set GHS_DUMP_DEMO=<dir> to dump demo payloads")
	}

	p := newTestPlugin(t)
	payloads := map[string]json.RawMessage{}
	for _, name := range fixtureNames() {
		resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
			WebhookKey: "status",
			Method:     "GET",
			Query:      "demo=" + name,
		})
		if err != nil {
			t.Fatalf("status?demo=%s: %v", name, err)
		}
		if resp.Status != 200 {
			t.Fatalf("status?demo=%s returned %d: %s", name, resp.Status, resp.Body)
		}
		payloads[name] = resp.Body
	}

	out, err := json.MarshalIndent(payloads, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := dir + "/demo.json"
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d bytes to %s", len(out), path)
}
