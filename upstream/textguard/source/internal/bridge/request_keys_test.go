// Modified for deterministic Unicode conformance and bounded native scanning.
package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExactRequestKeys(t *testing.T) {
	production, err := NewProductionRunner()
	if err != nil {
		t.Fatal(err)
	}
	generic := &Runner{}
	for _, schema := range []struct {
		name   string
		fields []string
		handle func([]byte) []byte
	}{
		{"production", []string{`"version":1`, `"id":"test"`, `"text":"日本語"`}, production.Handle},
		{"generic", []string{`"version":1`, `"id":"test"`, `"text":"日本語"`, `"op":"scan"`, `"preset":"default"`, `"confusables":"trimmed"`, `"split_tokens":true`, `"include_context":true`, `"yara_bundled":true`}, generic.Handle},
	} {
		t.Run(schema.name, func(t *testing.T) {
			check := func(payload string, valid bool) {
				t.Helper()
				var response map[string]any
				if err := json.Unmarshal(schema.handle([]byte(payload)), &response); err != nil {
					t.Fatal(err)
				}
				accepted := response["result"] != nil || response["status"] == "clear"
				if accepted != valid {
					t.Fatalf("valid=%v payload=%s response=%v", valid, payload, response)
				}
				if !valid && schema.name == "production" && (response["status"] != "unavailable" || response["reason"] != "protocol" || response["input_sha256"] != "") {
					t.Fatalf("invalid request reached scanner: %v", response)
				}
			}
			canonical := strings.Join(schema.fields, ",")
			check("{"+canonical+"}", true)
			check("{"+canonical+`,"unknown":true}`, false)
			check(strings.Replace("{"+canonical+`,"Text":"safe"}`, `日本語`, `\u202e`, 1), false)
			check("{"+canonical+`,"Version":2,"ID":"other"}`, false)
			for i, field := range schema.fields {
				end := strings.Index(field[1:], `"`) + 1
				name := field[1:end]
				for _, alias := range []string{strings.ToUpper(name), strings.ToUpper(name[:1]) + name[1:]} {
					changed := `"` + alias + field[end:]
					fields := append([]string(nil), schema.fields...)
					fields[i] = changed
					check("{"+strings.Join(fields, ",")+"}", false)
					check("{"+canonical+","+changed+"}", false)
					check("{"+changed+","+canonical+"}", false)
				}
			}
			check("{"+canonical+`,"\u0054ext":"safe"}`, false)
			check("{"+canonical+`,"\u0074ext":"safe"}`, false)
			check(strings.Replace("{"+canonical+"}", `"text"`, `"\u0074ext"`, 1), true)
		})
	}
}
