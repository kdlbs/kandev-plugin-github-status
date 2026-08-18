package main

import (
	"crypto/sha256"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const approvedMarketplaceIconSHA256 = "500cc7f291e1e2dd734539a44f70259f809f18dbcab6e4d208012725967c6878"

func TestManifestIncludesPackagedMarketplaceIcon(t *testing.T) {
	contents, err := os.ReadFile("../manifest.yaml")
	if err != nil {
		t.Fatal(err)
	}

	iconPath := manifestIconPath(string(contents))
	if iconPath != "assets/icon.svg" {
		t.Fatalf("manifest icon = %q, want %q", iconPath, "assets/icon.svg")
	}

	icon, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(iconPath)))
	if err != nil {
		t.Fatal(err)
	}
	assertMarketplaceSVG(t, icon)
}

func manifestIconPath(manifest string) string {
	for _, line := range strings.Split(manifest, "\n") {
		if strings.HasPrefix(line, "icon:") {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "icon:")), `"`)
		}
	}
	return ""
}

func assertMarketplaceSVG(t *testing.T, icon []byte) {
	t.Helper()
	if got := fmt.Sprintf("%x", sha256.Sum256(icon)); got != approvedMarketplaceIconSHA256 {
		t.Fatalf("marketplace SVG sha256 = %q, want approved GitHub asset %q", got, approvedMarketplaceIconSHA256)
	}

	var root struct {
		XMLName xml.Name
		Width   string `xml:"width,attr"`
		Height  string `xml:"height,attr"`
		ViewBox string `xml:"viewBox,attr"`
	}
	if err := xml.Unmarshal(icon, &root); err != nil {
		t.Fatal(err)
	}
	if root.XMLName.Local != "svg" || root.Width != "128" || root.Height != "128" || root.ViewBox != "0 0 128 128" {
		t.Fatalf("unexpected SVG root: name=%q width=%q height=%q viewBox=%q", root.XMLName.Local, root.Width, root.Height, root.ViewBox)
	}

	lower := strings.ToLower(string(icon))
	for _, forbidden := range []string{"<script", "<foreignobject", "href=", "url(", "currentcolor"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("marketplace SVG contains forbidden content %q", forbidden)
		}
	}
}
