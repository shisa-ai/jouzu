// Modified for deterministic Unicode conformance and bounded native scanning.
package normalize

import (
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	"golang.org/x/text/unicode/norm"
)

// UnicodeNormalize preserves Python's normalization semantics for long runs of
// non-starters. x/text inserts stream-safe CGJs after 30 non-starters; Python
// does not. Use its fast path unless it inserted a CGJ, then canonically order
// and compose unbounded segments without adding characters.
func UnicodeNormalize(text string, form norm.Form) string {
	// Characters unassigned in the pinned reference are inert boundaries even
	// when the Go toolchain knows a later decomposition or combining class.
	var out strings.Builder
	start := 0
	for i, r := range text {
		if r < 0x300 || charclass.Assigned(r) {
			continue
		}
		out.WriteString(normalizeAssigned(text[start:i], form))
		out.WriteRune(r)
		start = i + utf8.RuneLen(r)
	}
	if start == 0 {
		return normalizeAssigned(text, form)
	}
	out.WriteString(normalizeAssigned(text[start:], form))
	return out.String()
}

func normalizeAssigned(text string, form norm.Form) string {
	result := form.String(text)
	const cgj = "\u034f"
	if strings.Count(result, cgj) <= strings.Count(text, cgj) {
		return result
	}
	decompForm := norm.NFD
	if form == norm.NFKC || form == norm.NFKD {
		decompForm = norm.NFKD
	}
	type item struct {
		r   rune
		ccc uint8
	}
	items := make([]item, 0, utf8.RuneCountInString(text))
	for _, r := range text {
		for _, d := range decompForm.String(string(r)) {
			items = append(items, item{d, charclass.CombiningClass(d)})
		}
	}
	for start := 0; start < len(items); {
		if items[start].ccc == 0 {
			start++
			continue
		}
		end := start + 1
		for end < len(items) && items[end].ccc != 0 {
			end++
		}
		run := items[start:end]
		sort.SliceStable(run, func(i, j int) bool { return run[i].ccc < run[j].ccc })
		start = end
	}
	out := make([]rune, 0, len(items))
	starter, lastCCC := -1, uint8(0)
	for _, ch := range items {
		if form != norm.NFD && form != norm.NFKD && starter >= 0 && (lastCCC == 0 || lastCCC < ch.ccc) {
			pair := norm.NFC.String(string([]rune{out[starter], ch.r}))
			if utf8.RuneCountInString(pair) == 1 {
				out[starter], _ = utf8.DecodeRuneInString(pair)
				continue
			}
		}
		if ch.ccc == 0 {
			starter = len(out)
		}
		out = append(out, ch.r)
		lastCCC = ch.ccc
	}
	return string(out)
}
