// Modified for deterministic Unicode conformance and bounded native scanning.
package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductionProtocol(t *testing.T) {
	t.Setenv("TEXTGUARD_PRESET", "invalid")
	runner, err := NewProductionRunner()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, text, status, reason string }{
		{"empty", "", "clear", ""},
		{"multilingual", "日本語の説明を保持します。", "clear", ""},
		{"bidi", "hello\u202eworld", "findings", ""},
		{"flood", strings.Repeat("\u200b", 20000), "unavailable", "finding-limit"},
		{"oversized", strings.Repeat("x", MaxInputBytes+1), "unavailable", "input-limit"},
		{"decode-bound", strings.Repeat("ordinary text ", 3000) + "%69gnore", "unavailable", "decode-limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]any{"version": 1, "id": "test-1", "text": tc.text})
			encoded := runner.Handle(payload)
			if len(encoded) > ProductionResponseLimit {
				t.Fatal("response exceeds ceiling")
			}
			var got ProductionResponse
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if got.Status != tc.status || got.Reason != tc.reason || got.ID != "test-1" {
				t.Fatalf("unexpected response: %+v", got)
			}
			if len(got.Findings) > ProductionReportLimit {
				t.Fatal("unbounded findings")
			}
			if strings.Contains(string(encoded), "normalized_text") || strings.Contains(string(encoded), "decoded_text") {
				t.Fatal("full source artifacts leaked")
			}
		})
	}
	for _, payload := range []string{
		`{}`, `{"version":1,"id":"a","text":null}`, `{"version":2,"id":"a","text":"x"}`,
		`{"version":1,"id":"a","text":"x","text":"y"}`,
		`{"version":1,"id":"a","text":"\ud800"}`,
		`{"version":1,"id":"a","text":"x","yara_bundled":false}`,
		`{"version":1,"id":"a","text":"x"} {}`,
		`{"version":1,"id":"\u001b","text":"x"}`,
	} {
		var got ProductionResponse
		if err := json.Unmarshal(runner.Handle([]byte(payload)), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status != "unavailable" || got.Reason != "protocol" {
			t.Fatalf("accepted invalid payload %s: %+v", payload, got)
		}
	}
}
