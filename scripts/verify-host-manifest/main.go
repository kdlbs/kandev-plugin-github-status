// Verify the only semantic change permitted in a host-only package manifest:
// runtime.executables contains just the requested host platform.
package main

import (
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

func verifyHostManifest(source, packaged []byte, platform string) error {
	var expected, actual map[string]any
	if err := yaml.Unmarshal(source, &expected); err != nil {
		return fmt.Errorf("source manifest: %w", err)
	}
	if err := yaml.Unmarshal(packaged, &actual); err != nil {
		return fmt.Errorf("packaged manifest: %w", err)
	}
	runtime, ok := expected["runtime"].(map[string]any)
	if !ok {
		return fmt.Errorf("source manifest has no runtime")
	}
	executables, ok := runtime["executables"].(map[string]any)
	if !ok {
		return fmt.Errorf("source manifest has no executables")
	}
	executable, ok := executables[platform]
	if !ok {
		return fmt.Errorf("undeclared host platform %q", platform)
	}
	runtime["executables"] = map[string]any{platform: executable}
	// plugin-pack's YAML marshal emits these empty backend-model defaults.
	for key, value := range map[string]any{
		"base_url":  "",
		"endpoints": map[string]any{"health": "", "events": "", "webhooks": ""},
	} {
		if _, exists := expected[key]; !exists {
			if got, exists := actual[key]; exists && reflect.DeepEqual(got, value) {
				delete(actual, key)
			}
		}
	}
	if !reflect.DeepEqual(expected, actual) {
		keys := make(map[string]bool)
		for key := range expected {
			keys[key] = true
		}
		for key := range actual {
			keys[key] = true
		}
		var changed []string
		for key := range keys {
			expectedValue, expectedOK := expected[key]
			actualValue, actualOK := actual[key]
			if expectedOK != actualOK || !reflect.DeepEqual(expectedValue, actualValue) {
				changed = append(changed, key)
			}
		}
		sort.Strings(changed)
		return fmt.Errorf("host manifest differs from source: %s", strings.Join(changed, ", "))
	}
	return nil
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: verify-host-manifest SOURCE PACKAGED PLATFORM")
		os.Exit(1)
	}
	source, err := os.ReadFile(os.Args[1])
	if err == nil {
		var packaged []byte
		packaged, err = os.ReadFile(os.Args[2])
		if err == nil {
			err = verifyHostManifest(source, packaged, os.Args[3])
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
