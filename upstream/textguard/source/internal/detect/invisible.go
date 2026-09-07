// Modified for deterministic Unicode conformance and bounded native scanning.
package detect

import (
	"fmt"
	"unicode/utf8"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// DetectInvisibleText detects all categories of invisible/hidden characters in
// text: invisible codepoints, bidi controls, tag characters, variation
// selectors, soft hyphens, combining mark abuse, and ANSI escape sequences.
//
// When inDecodedText is true, offsets are set to nil and detail strings are
// suffixed with " in decoded text".
func DetectInvisibleText(text string, inDecodedText bool) []textguard.Finding {
	return DetectInvisibleTextBounded(text, inDecodedText, nil)
}

// DetectInvisibleTextBounded reserves findings before allocating their data.
func DetectInvisibleTextBounded(text string, inDecodedText bool, budget *textguard.FindingBudget) []textguard.Finding {
	findings := []textguard.Finding{}
	detailSuffix := ""
	if inDecodedText {
		detailSuffix = " in decoded text"
	}

	// Count offsets incrementally so a flood of escapes remains linear.
	previousByte, previousRune := 0, 0
	for _, loc := range charclass.ANSIEscapeRE.FindAllStringIndex(text, -1) {
		budget.Take()
		var offset *int
		if !inDecodedText {
			previousRune += utf8.RuneCountInString(text[previousByte:loc[0]])
			previousByte = loc[0]
			o := previousRune
			offset = &o
		}
		findings = append(findings, textguard.Finding{
			Kind:     "ansi_escape",
			Severity: "warn",
			Detail:   fmt.Sprintf("ANSI escape sequence detected%s", detailSuffix),
			Offset:   offset,
		})
	}

	// Scan each rune for invisible character categories.
	runeIdx := 0
	for _, r := range text {
		if !charclass.IsInvisible(r) && !charclass.IsBidi(r) && !charclass.IsTagCharacter(r) && !charclass.IsVariationSelector(r) && !charclass.IsSoftHyphen(r) {
			runeIdx++
			continue
		}
		budget.Take()
		var findingOffset *int
		if !inDecodedText {
			o := runeIdx
			findingOffset = &o
		}

		switch {
		case charclass.IsInvisible(r):
			findings = append(findings, charFinding("invisible_char", "warn", r, findingOffset, detailSuffix))
		case charclass.IsBidi(r):
			findings = append(findings, charFinding("bidi_control", "error", r, findingOffset, detailSuffix))
		case charclass.IsTagCharacter(r):
			findings = append(findings, charFinding("tag_character", "error", r, findingOffset, detailSuffix))
		case charclass.IsVariationSelector(r):
			findings = append(findings, charFinding("variation_selector", "warn", r, findingOffset, detailSuffix))
		case charclass.IsSoftHyphen(r):
			findings = append(findings, charFinding("soft_hyphen", "warn", r, findingOffset, detailSuffix))
		}
		runeIdx++
	}

	// Detect combining mark abuse.
	findings = append(findings, detectCombiningAbuseBounded(text, charclass.DefaultCombiningMarkCap, inDecodedText, budget)...)

	return findings
}

// detectCombiningAbuse scans for runs of consecutive combining marks that
// exceed maxCombiningMarks. Each combining mark beyond the cap produces a
// finding.
func detectCombiningAbuse(text string, maxCombiningMarks int, inDecodedText bool) []textguard.Finding {
	return detectCombiningAbuseBounded(text, maxCombiningMarks, inDecodedText, nil)
}

func detectCombiningAbuseBounded(text string, maxCombiningMarks int, inDecodedText bool, budget *textguard.FindingBudget) []textguard.Finding {
	findings := []textguard.Finding{}

	detail := fmt.Sprintf("Combining mark cap exceeded (%d)", maxCombiningMarks)
	if inDecodedText {
		detail += " in decoded text"
	}

	runLength := 0
	runeIdx := 0
	for _, r := range text {
		if charclass.CombiningClass(r) != 0 {
			runLength++
			if runLength > maxCombiningMarks {
				budget.Take()
				var offset *int
				if !inDecodedText {
					o := runeIdx
					offset = &o
				}
				findings = append(findings, textguard.Finding{
					Kind:      "combining_abuse",
					Severity:  "warn",
					Detail:    detail,
					Codepoint: charclass.FormatCodepoint(r),
					Offset:    offset,
				})
			}
		} else {
			runLength = 0
		}
		runeIdx++
	}
	return findings
}

// charFinding creates a Finding for a single character detection.
func charFinding(kind, severity string, r rune, offset *int, detailSuffix string) textguard.Finding {
	cp := charclass.FormatCodepoint(r)
	// Title-case the kind: "invisible_char" → "Invisible Char"
	title := charclass.KindToTitle(kind)
	return textguard.Finding{
		Kind:      kind,
		Severity:  severity,
		Detail:    fmt.Sprintf("%s %s%s", title, cp, detailSuffix),
		Codepoint: cp,
		Offset:    offset,
	}
}
