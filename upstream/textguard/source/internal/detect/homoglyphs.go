// Modified for deterministic Unicode conformance and bounded native scanning.
// Package detect implements text analysis detectors for homoglyphs,
// invisible characters, and encoded payloads.
package detect

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	"github.com/shisa-ai/textguard-go/internal/data"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// Script classification sets — matching Python's constants.
var (
	ignoredScripts = map[string]bool{
		"Common":    true,
		"Inherited": true,
		"Unknown":   true,
	}
	mixedScriptBaseline = map[string]bool{
		"Latin":    true,
		"Greek":    true,
		"Cyrillic": true,
	}
	eastAsianAllowed = map[string]bool{
		"Han":      true,
		"Hiragana": true,
		"Katakana": true,
	}
)

// wordSpans uses the pinned Python character classes rather than the Go
// toolchain's Unicode version.
func wordSpans(text string) [][2]int {
	var spans [][2]int
	start := -1
	for i, r := range text {
		if charclass.Letter(r) || charclass.Number(r) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			spans = append(spans, [2]int{start, i})
			start = -1
		}
	}
	if start >= 0 {
		spans = append(spans, [2]int{start, len(text)})
	}
	return spans
}

// Pre-computed script range starts for binary search, guarded by sync.Once.
var (
	scriptStartsOnce sync.Once
	scriptStarts     []int
)

// getScriptStarts returns the sorted slice of range start codepoints for binary search.
func getScriptStarts() []int {
	scriptStartsOnce.Do(func() {
		ranges := data.ScriptRanges()
		scriptStarts = make([]int, len(ranges))
		for i, r := range ranges {
			scriptStarts[i] = r.Start
		}
	})
	return scriptStarts
}

// lookupScript returns the Unicode script name for a codepoint using binary search
// on the pre-parsed script ranges from scripts.json.
func lookupScript(cp rune) string {
	ranges := data.ScriptRanges()
	starts := getScriptStarts()
	codepoint := int(cp)

	// Binary search: find the rightmost range whose start <= codepoint.
	idx := sort.SearchInts(starts, codepoint+1) - 1
	if idx >= 0 {
		r := ranges[idx]
		if r.Start <= codepoint && codepoint <= r.End {
			return r.Script
		}
	}
	return "Unknown"
}

// tokenScripts returns the sorted list of unique non-ignored scripts found in a token.
func tokenScripts(token string) []string {
	seen := make(map[string]bool)
	for _, ch := range token {
		if !charclass.Letter(ch) {
			continue
		}
		script := lookupScript(ch)
		if !ignoredScripts[script] {
			seen[script] = true
		}
	}
	scripts := make([]string, 0, len(seen))
	for s := range seen {
		scripts = append(scripts, s)
	}
	sort.Strings(scripts)
	return scripts
}

// isSuspiciousScriptMix determines whether a set of scripts constitutes a
// suspicious mix. East Asian scripts together are benign. In trimmed mode,
// only Latin+Greek or Latin+Cyrillic mixes are suspicious. In full mode,
// any multi-script token is suspicious.
func isSuspiciousScriptMix(scripts []string, mode textguard.ConfusablesMode) bool {
	scriptSet := make(map[string]bool, len(scripts))
	for _, s := range scripts {
		scriptSet[s] = true
	}

	// Pure East Asian is never suspicious.
	allEastAsian := true
	for s := range scriptSet {
		if !eastAsianAllowed[s] {
			allEastAsian = false
			break
		}
	}
	if allEastAsian {
		return false
	}

	// Count how many of the baseline scripts (Latin, Greek, Cyrillic) are present.
	baselineCount := 0
	for s := range scriptSet {
		if mixedScriptBaseline[s] {
			baselineCount++
		}
	}
	if baselineCount > 1 {
		return true
	}

	// In full mode, any remaining multi-script token is suspicious.
	return mode == textguard.ConfusablesFull && len(scriptSet) > 1
}

// loadConfusableMap returns the appropriate confusable mappings for the mode.
func loadConfusableMap(mode textguard.ConfusablesMode) map[string]data.ConfusableMapping {
	if mode == textguard.ConfusablesFull {
		return data.ConfusablesFull()
	}
	return data.Confusables()
}

// ConfusableSkeleton maps each character in text to its confusable equivalent
// using the specified confusables dataset. If the skeleton differs from the
// original, the text contains potential homoglyphs.
func ConfusableSkeleton(text string, mode textguard.ConfusablesMode) string {
	mappings := loadConfusableMap(mode)
	var b strings.Builder
	b.Grow(len(text))
	for _, ch := range text {
		key := fmt.Sprintf("%04X", ch)
		if entry, ok := mappings[key]; ok {
			b.WriteString(entry.Target)
		} else {
			b.WriteRune(ch)
		}
	}
	return b.String()
}

// shouldFlagConfusable decides whether the matched confusable entries in a
// multi-script token should produce a finding.
func shouldFlagConfusable(scripts []string, entries []data.ConfusableMapping, mode textguard.ConfusablesMode) bool {
	if len(scripts) <= 1 {
		return false
	}

	if mode == textguard.ConfusablesTrimmed {
		// Trimmed mode: only flag if Latin is present and at least one entry maps
		// from Greek/Cyrillic with Latin as a target script.
		hasLatin := false
		for _, s := range scripts {
			if s == "Latin" {
				hasLatin = true
				break
			}
		}
		if !hasLatin {
			return false
		}
		for _, entry := range entries {
			if (entry.SourceScript == "Greek" || entry.SourceScript == "Cyrillic") &&
				containsString(entry.TargetScripts, "Latin") {
				return true
			}
		}
		return false
	}

	// Full mode: flag if any entry has a non-ignored source script and has target scripts.
	for _, entry := range entries {
		if !ignoredScripts[entry.SourceScript] && len(entry.TargetScripts) > 0 {
			return true
		}
	}
	return false
}

// DetectHomoglyphs scans text for confusable homoglyph attacks and mixed-script
// tokens. It returns findings with kind "mixed_script" and "confusable_homoglyph".
//
// The mode parameter controls which confusable mapping dataset is used:
// "trimmed" (default) only covers Latin/Greek/Cyrillic confusables,
// "full" covers all Unicode confusables.
//
// When inDecodedText is true, offsets are set to nil and detail strings are
// suffixed with " in decoded text".
func DetectHomoglyphs(text string, mode textguard.ConfusablesMode, inDecodedText bool) []textguard.Finding {
	return DetectHomoglyphsBounded(text, mode, inDecodedText, nil)
}

// DetectHomoglyphsBounded reserves findings before constructing their evidence.
func DetectHomoglyphsBounded(text string, mode textguard.ConfusablesMode, inDecodedText bool, budget *textguard.FindingBudget) []textguard.Finding {
	findings := []textguard.Finding{}
	hasNonASCII := false
	for i := 0; i < len(text); i++ {
		if text[i] >= 128 {
			hasNonASCII = true
			break
		}
	}
	if !hasNonASCII {
		return findings
	}
	mappings := loadConfusableMap(mode)

	// Pre-compute byte-to-rune offset table for O(1) lookups.
	var runeTable charclass.ByteToRuneTable
	if !inDecodedText {
		runeTable = charclass.NewByteToRuneTable(text)
	}

	matches := wordSpans(text)
	for _, loc := range matches {
		token := text[loc[0]:loc[1]]
		scripts := tokenScripts(token)
		if len(scripts) < 2 {
			continue
		}

		// Check for suspicious script mixing.
		if len(scripts) > 1 && isSuspiciousScriptMix(scripts, mode) {
			budget.Take()
			detail := fmt.Sprintf("Mixed scripts detected (%s)", strings.Join(scripts, ", "))
			if inDecodedText {
				detail += " in decoded text"
			}

			severity := "info"
			for _, s := range scripts {
				if s == "Latin" {
					severity = "warn"
					break
				}
			}

			var offset *int
			if !inDecodedText {
				o := runeTable.RuneOffset(loc[0])
				offset = &o
			}

			findings = append(findings, textguard.Finding{
				Kind:     "mixed_script",
				Severity: severity,
				Detail:   detail,
				Offset:   offset,
			})
		}

		// Check for confusable skeleton difference.
		skeleton := ConfusableSkeleton(token, mode)
		if skeleton == token {
			continue
		}

		// Collect matched confusable entries for this token.
		var matchedEntries []data.ConfusableMapping
		for _, ch := range token {
			key := fmt.Sprintf("%04X", ch)
			if entry, ok := mappings[key]; ok {
				matchedEntries = append(matchedEntries, entry)
			}
		}

		if len(matchedEntries) == 0 || !shouldFlagConfusable(scripts, matchedEntries, mode) {
			continue
		}

		budget.Take()
		// Collect source and target scripts from matched entries.
		sourceScriptSet := make(map[string]bool)
		targetScriptSet := make(map[string]bool)
		for _, entry := range matchedEntries {
			sourceScriptSet[entry.SourceScript] = true
			for _, ts := range entry.TargetScripts {
				targetScriptSet[ts] = true
			}
		}

		sourceScripts := sortedKeys(sourceScriptSet)
		targetScripts := sortedKeys(targetScriptSet)

		detail := fmt.Sprintf("Confusable skeleton differs under %s table (%s\u2192%s)",
			string(mode),
			strings.Join(sourceScripts, ", "),
			strings.Join(targetScripts, ", "))
		if inDecodedText {
			detail += " in decoded text"
		}

		severity := "warn"
		if targetScriptSet["Latin"] {
			severity = "error"
		}

		var offset *int
		if !inDecodedText {
			o := runeTable.RuneOffset(loc[0])
			offset = &o
		}

		findings = append(findings, textguard.Finding{
			Kind:     "confusable_homoglyph",
			Severity: severity,
			Detail:   detail,
			Offset:   offset,
		})
	}

	return findings
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// containsString reports whether slice contains s.
func containsString(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// sortedKeys returns the keys of a map[string]bool sorted alphabetically.
func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
