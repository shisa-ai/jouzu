// Modified for deterministic Unicode conformance and bounded native scanning.
package yaramatch

import (
	"strings"
	"testing"
)

const validRule = "rule test {\nstrings:\n$a = /hello/i\ncondition:\n$a\n}\n"

func TestRejectUnsupportedRuleSyntax(t *testing.T) {
	for name, source := range map[string]string{
		"import":            "import \"pe\"\n" + validRule,
		"global":            "global " + validRule,
		"private":           "private " + validRule,
		"tag":               strings.Replace(validRule, "test {", "test : tag {", 1),
		"variable":          strings.Replace(validRule, "$a =", "$b =", 1),
		"modifier":          strings.Replace(validRule, "/hello/i", "/hello/i wide", 1),
		"flag":              strings.Replace(validRule, "/hello/i", "/hello/z", 1),
		"literal modifier":  strings.Replace(validRule, "/hello/i", `"hello" nocase`, 1),
		"missing brace":     strings.TrimSuffix(validRule, "}\n"),
		"body":              strings.Replace(validRule, "strings:", "unknown\nstrings:", 1),
		"duplicate section": strings.Replace(validRule, "strings:", "strings:\nstrings:", 1),
		"ignored trailer":   validRule + "include \"other.yara\"",
		"inline flags":      strings.Replace(validRule, "/hello/i", "/(?i)hello/", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseYaraSource("test.yara", source); err == nil {
				t.Fatal("unsupported source accepted")
			}
		})
	}
}

func TestByteRegexSemantics(t *testing.T) {
	for _, tc := range []struct {
		pattern, text string
		want          bool
	}{
		{`/system/i`, "ſyſtem", false}, {`/hello\sworld/`, "hello\vworld", true},
		{`/hello\sworld/`, "hello\u00a0world", false}, {`/./`, "日", true},
		{`/^.$/`, "日", false}, {`/\xe6\x97\xa5/`, "日", true},
		{`/日/`, "日", true}, {`/hello/i // comment / slash`, "HELLO", true},
		{`/\\s/`, `\s`, true}, {`/[\s]/`, "\v", true},
	} {
		source := strings.Replace(validRule, "/hello/i", tc.pattern, 1)
		rules, err := parseYaraSource("test.yara", source)
		if err != nil {
			t.Fatalf("%s: %v", tc.pattern, err)
		}
		m := &Matcher{rules: rules}
		if got := len(m.Match(tc.text, tc.text)) > 0; got != tc.want {
			t.Errorf("%s on %q: %v, want %v", tc.pattern, tc.text, got, tc.want)
		}
	}
}
