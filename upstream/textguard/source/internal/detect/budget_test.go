// Modified for deterministic Unicode conformance and bounded native scanning.
package detect

import (
	"reflect"
	"strings"
	"testing"

	"github.com/shisa-ai/textguard-go/internal/tgtypes"
)

func TestInvisibleFindingBudget(t *testing.T) {
	for _, text := range []string{"日本語 ordinary text", "a\u200bb\u202ec", "\x1b[31mred\x1b[0m", "a" + strings.Repeat("\u0301", 12)} {
		want := DetectInvisibleText(text, false)
		got := DetectInvisibleTextBounded(text, false, tgtypes.NewFindingBudget(len(want)+1))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("bounded detection changed complete findings for %q", text)
		}
	}
	for name, text := range map[string]string{
		"invisible": strings.Repeat("\u200b", 100000),
		"ansi":      strings.Repeat("\x1b[31m", 10000),
		"combining": "a" + strings.Repeat("\u0301", 100000),
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if _, ok := recover().(tgtypes.FindingLimitError); !ok {
					t.Fatal("expected explicit finding limit exhaustion")
				}
			}()
			DetectInvisibleTextBounded(text, false, tgtypes.NewFindingBudget(16))
		})
	}
}
