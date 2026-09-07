// Modified for deterministic Unicode conformance and bounded native scanning.
package detect

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	"github.com/shisa-ai/textguard-go/internal/decode"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// base64TokenRE matches base64-encoded tokens of at least 24 characters,
// with boundary assertions handled manually since Go RE2 lacks lookaround.
var base64TokenRE = regexp.MustCompile(`[A-Za-z0-9+/]{24,}={0,2}`)

// splitTokenWords is the list of protected keywords for split-token detection.
var splitTokenWords = []string{
	"ignore",
	"developer",
	"instruction",
	"instructions",
	"prompt",
	"system",
}

// splitTokenEntry holds a pre-compiled regex for a split-token keyword.
type splitTokenEntry struct {
	word    string
	pattern *regexp.Regexp
}

// sortedSplitTokenEntries is sorted by word length (longest first) for greedy matching,
// with pre-compiled regex patterns.
var sortedSplitTokenEntries = func() []splitTokenEntry {
	// Manual sort by length descending — small fixed list.
	words := make([]string, len(splitTokenWords))
	copy(words, splitTokenWords)
	for i := 1; i < len(words); i++ {
		for j := i; j > 0 && len(words[j]) > len(words[j-1]); j-- {
			words[j], words[j-1] = words[j-1], words[j]
		}
	}
	entries := make([]splitTokenEntry, len(words))
	for i, w := range words {
		entries[i] = splitTokenEntry{word: w, pattern: compileSplitTokenPattern(w)}
	}
	return entries
}()

const splitTokenSeparatorMax = 5

// signalTokens are suspicious strings to look for in decoded base64 payloads.
var signalTokens = []string{
	"curl",
	"developer",
	"ignore",
	"instruction",
	"instructions",
	"password",
	"prompt",
	"secret",
	"system",
	"token",
	"wget",
	"http://",
	"https://",
}

// DetectEncodedPayloads detects base64-encoded payloads and optionally
// split-token smuggling patterns in text.
//
// When splitTokens is true, the function also scans for split-token patterns.
// When inDecodedText is true, offsets are nil and details are suffixed with
// " in decoded text".
func DetectEncodedPayloads(text string, splitTokens bool, inDecodedText bool) []textguard.Finding {
	return DetectEncodedPayloadsBounded(text, splitTokens, inDecodedText, nil)
}

// DetectEncodedPayloadsBounded reserves findings before constructing evidence.
func DetectEncodedPayloadsBounded(text string, splitTokens bool, inDecodedText bool, budget *textguard.FindingBudget) []textguard.Finding {
	// Pre-compute byte-to-rune offset table for O(1) lookups.
	var runeTable charclass.ByteToRuneTable
	if !inDecodedText {
		runeTable = charclass.NewByteToRuneTable(text)
	}

	findings := []textguard.Finding{}
	findings = append(findings, detectBase64PayloadsBounded(text, inDecodedText, runeTable, budget)...)
	if splitTokens {
		findings = append(findings, detectSplitTokensBounded(text, inDecodedText, runeTable, budget)...)
	}
	return findings
}

// isBase64BoundaryChar returns true if the byte is a valid base64 character or '='.
func isBase64BoundaryChar(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
		(c >= '0' && c <= '9') || c == '+' || c == '/' || c == '='
}

// detectBase64Payloads finds base64-encoded tokens and checks if they decode
// to readable text. Findings are upgraded to "error" severity when the decoded
// text contains signal tokens.
func detectBase64Payloads(text string, inDecodedText bool, runeTable charclass.ByteToRuneTable) []textguard.Finding {
	return detectBase64PayloadsBounded(text, inDecodedText, runeTable, nil)
}

func detectBase64PayloadsBounded(text string, inDecodedText bool, runeTable charclass.ByteToRuneTable, budget *textguard.FindingBudget) []textguard.Finding {
	findings := []textguard.Finding{}

	for _, loc := range base64TokenRE.FindAllStringIndex(text, -1) {
		start, end := loc[0], loc[1]

		// Manual boundary check: char before start and after end must not be
		// base64 chars (simulating negative lookaround).
		if start > 0 && isBase64BoundaryChar(text[start-1]) {
			continue
		}
		if end < len(text) && isBase64BoundaryChar(text[end]) {
			continue
		}

		token := text[start:end]
		decoded := decode.Base64DecodeCandidate(token)
		if decoded == nil {
			continue
		}

		budget.Take()
		severity := "warn"
		detail := "Base64-like payload decodes to readable text"
		lowered := charclass.LowerForSignals(*decoded)
		for _, signal := range signalTokens {
			if strings.Contains(lowered, signal) {
				severity = "error"
				detail = "Base64-like payload decodes to instruction-like text"
				break
			}
		}
		if inDecodedText {
			detail = fmt.Sprintf("%s in decoded text", detail)
		}

		var offset *int
		if !inDecodedText {
			o := runeTable.RuneOffset(start)
			offset = &o
		}

		findings = append(findings, textguard.Finding{
			Kind:     "encoded_payload",
			Severity: severity,
			Detail:   detail,
			Offset:   offset,
		})
	}
	return findings
}

// detectSplitTokens scans for split-token smuggling patterns: protected
// keywords with characters separated by up to splitTokenSeparatorMax
// separator characters.
func detectSplitTokens(text string, inDecodedText bool, runeTable charclass.ByteToRuneTable) []textguard.Finding {
	return detectSplitTokensBounded(text, inDecodedText, runeTable, nil)
}

func detectSplitTokensBounded(text string, inDecodedText bool, runeTable charclass.ByteToRuneTable, budget *textguard.FindingBudget) []textguard.Finding {
	findings := []textguard.Finding{}
	// Each accepted span marks its bytes. This avoids quadratic comparisons
	// against every preceding match in a finding flood.
	var occupied []bool

	for _, entry := range sortedSplitTokenEntries {
		word := entry.word
		for _, loc := range entry.pattern.FindAllStringIndex(text, -1) {
			if occupied == nil {
				occupied = make([]bool, len(text))
			}
			overlaps := false
			for _, used := range occupied[loc[0]:loc[1]] {
				if used {
					overlaps = true
					break
				}
			}
			if overlaps {
				continue
			}
			for i := loc[0]; i < loc[1]; i++ {
				occupied[i] = true
			}

			budget.Take()
			detail := fmt.Sprintf("Split-token pattern matched protected keyword '%s'", word)
			if inDecodedText {
				detail = fmt.Sprintf("%s in decoded text", detail)
			}

			var offset *int
			if !inDecodedText {
				o := runeTable.RuneOffset(loc[0])
				offset = &o
			}

			findings = append(findings, textguard.Finding{
				Kind:     "split_token",
				Severity: "warn",
				Detail:   detail,
				Offset:   offset,
			})
		}
	}
	return findings
}

// compileSplitTokenPattern builds a regex that matches a word with up to
// splitTokenSeparatorMax separator characters between each letter.
func compileSplitTokenPattern(word string) *regexp.Regexp {
	separator := fmt.Sprintf(`[%s._:/\\|,\-]{0,%d}`, charclass.PythonWhitespaceClass, splitTokenSeparatorMax)
	var parts []string
	for _, r := range word {
		if r == 'i' {
			parts = append(parts, "[iİı]")
		} else {
			parts = append(parts, regexp.QuoteMeta(string(r)))
		}
	}
	pattern := strings.Join(parts, separator)
	return regexp.MustCompile("(?i)" + pattern)
}
