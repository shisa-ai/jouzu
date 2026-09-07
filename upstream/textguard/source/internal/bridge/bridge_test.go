// Modified for deterministic Unicode conformance and bounded native scanning.
package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func response(t *testing.T, r *Runner, payload string) Response {
	t.Helper()
	var result Response
	out := r.Handle([]byte(payload))
	if len(out) > MaxResponseBytes {
		t.Fatal("oversized response")
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRequestValidation(t *testing.T) {
	var r Runner
	for _, payload := range []string{
		`{}`, `[]`, `null`, `{"version":1,"op":"scan"}`, `{"version":1,"op":"scan","text":null}`,
		`{"version":1,"op":"scan","text":"x","text":"y"}`,
		`{"version":1,"op":"scan","text":"x"} {}`,
		`{"version":1,"op":"scan","text":"x","yara_rules_dir":"/tmp"}`,
		`{"version":1,"op":"scan","text":"\ud800"}`, `{"version":1,"op":"scan","text":"\udc00"}`,
		`{"version":1,"op":"scan","text":"x","split_tokens":null}`,
		`{"version":2,"op":"scan","text":"x"}`, `{"version":1,"op":"other","text":"x"}`,
		`{"version":1,"op":"scan","text":"x","preset":"invalid"}`,
		`{"version":1,"op":"scan","text":"` + strings.Repeat("a", MaxInputBytes+1) + `"}`,
		strings.Repeat("x", MaxRequestBytes+1),
	} {
		if got := response(t, &r, payload); got.Error == "" {
			t.Fatalf("accepted invalid request %.200q", payload)
		}
	}
	for _, text := range []string{`"日本語"`, `"\ud83d\ude00"`, `"\\uD800"`} {
		got := response(t, &r, `{"version":1,"op":"scan","text":`+text+`}`)
		if got.Error != "" {
			t.Fatalf("rejected %s: %s", text, got.Error)
		}
	}
}

func TestGuardCacheBoundAndIsolation(t *testing.T) {
	t.Setenv("TEXTGUARD_PRESET", "invalid")
	t.Setenv("XDG_CONFIG_HOME", "/unavailable")
	var r Runner
	got := response(t, &r, `{"version":1,"op":"scan","text":"hello","id":"a"}`)
	if got.Error != "" || got.ID != "a" {
		t.Fatalf("%+v", got)
	}
	if len(r.guards) != 1 {
		t.Fatal("guard not cached")
	}
	_ = response(t, &r, `{"version":1,"op":"scan","text":"hello","preset":"invalid"}`)
	if len(r.guards) != 1 {
		t.Fatal("invalid guard cached")
	}
}

func TestResponseFloodBound(t *testing.T) {
	var r Runner
	payload, _ := json.Marshal(map[string]any{"version": 1, "op": "scan", "text": strings.Repeat("\u200b", MaxInputBytes/3), "include_context": true})
	got := response(t, &r, string(payload))
	if got.Error == "" || got.Result != nil {
		t.Fatal("finding flood not bounded")
	}
}
