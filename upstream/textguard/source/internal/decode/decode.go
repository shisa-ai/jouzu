// Modified for deterministic Unicode conformance and bounded native scanning.
// Package decode implements bounded recursive text decoding for 7 encoding
// schemes: URL, HTML entities, ROT13, Base64, Unicode escapes (\uXXXX,
// \UXXXXXXXX), hex escapes (\xXX), and Punycode (IDNA).
package decode

import (
	"encoding/base64"
	"fmt"
	"html"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
	"golang.org/x/net/idna"
)

// ---------------------------------------------------------------------------
// Compiled regexps (package-level, compiled once)
// ---------------------------------------------------------------------------

var (
	unicodeEscapeRE = regexp.MustCompile(`\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})`)
	hexEscapeRE     = regexp.MustCompile(`\\x([0-9a-fA-F]{2})`)
	punycodeRE      = regexp.MustCompile(`(?i)\bxn--[a-z0-9-]+\b`)
	numericEntityRE = regexp.MustCompile(`&#(?:[xX][0-9a-fA-F]+|[0-9]+);?`)
)

// ROT13 signal tokens: if the decoded ROT13 text contains any of these (that
// were NOT present in the raw text), ROT13 decoding is applied.
var rot13SignalTokens = []string{
	"api key",
	"curl",
	"developer message",
	"disregard",
	"exfiltrate",
	"http://",
	"https://",
	"ignore",
	"instruction",
	"password",
	"reveal",
	"secret",
	"system prompt",
	"token",
	"wget",
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type decodeOptions struct {
	maxDepth          int
	maxExpansionRatio float64
	maxTotalChars     int
}

func defaultOptions() decodeOptions {
	return decodeOptions{
		maxDepth:          3,
		maxExpansionRatio: 4.0,
		maxTotalChars:     32768,
	}
}

// DecodeOption configures TextLayers behaviour.
type DecodeOption func(*decodeOptions)

// WithMaxDepth sets the maximum recursion depth (default 3).
func WithMaxDepth(n int) DecodeOption {
	return func(o *decodeOptions) { o.maxDepth = n }
}

// WithMaxExpansionRatio sets the max expansion ratio (default 4.0).
func WithMaxExpansionRatio(r float64) DecodeOption {
	return func(o *decodeOptions) { o.maxExpansionRatio = r }
}

// WithMaxTotalChars sets the max total chars for a decode candidate (default 32768).
func WithMaxTotalChars(n int) DecodeOption {
	return func(o *decodeOptions) { o.maxTotalChars = n }
}

// ---------------------------------------------------------------------------
// TextLayers — public entry point
// ---------------------------------------------------------------------------

// TextLayers recursively unwinds supported encodings with bounded recursion
// and size limits. It returns a DecodedText whose Findings field contains one
// Finding per distinct reason code encountered during decoding.
func TextLayers(text string, opts ...DecodeOption) textguard.DecodedText {
	o := defaultOptions()
	for _, fn := range opts {
		fn(&o)
	}

	if o.maxDepth <= 0 {
		dt := textguard.NewDecodedText()
		dt.Text = text
		return dt
	}

	current := text
	reasonCodes := map[string]struct{}{}
	emittedFindings := map[string]struct{}{}
	var findings []textguard.Finding
	depth := 0

	steps := []struct {
		fn     func(string) *string
		reason string
	}{
		{urlDecodeCandidate, "encoding:url_decoded"},
		{htmlDecodeCandidate, "encoding:html_entity_decoded"},
		{rot13DecodeCandidate, "encoding:rot13_decoded"},
		{base64DecodeCandidate, "encoding:base64_decoded"},
		{unicodeEscapeDecodeCandidate, "encoding:unicode_escape_decoded"},
		{hexEscapeDecodeCandidate, "encoding:hex_escape_decoded"},
		{punycodeDecodeCandidate, "encoding:punycode_decoded"},
	}

	for range o.maxDepth {
		changed := false
		for _, step := range steps {
			candidate := step.fn(current)
			var applied bool
			current, applied = applyBoundedDecode(
				current, candidate, step.reason,
				reasonCodes, emittedFindings, &findings,
				o.maxExpansionRatio, o.maxTotalChars,
			)
			if applied {
				changed = true
			}
		}
		if !changed {
			break
		}
		depth++
	}

	// If we hit max depth and there are still encodable layers, record it.
	if depth >= o.maxDepth && hasAdditionalLayer(current, steps) {
		recordReason(
			"encoding:decode_depth_limited", "warn",
			reasonCodes, emittedFindings, &findings,
			"Maximum decode depth reached while encodings remained",
		)
	}

	// Build sorted reason codes.
	codes := make([]string, 0, len(reasonCodes))
	for c := range reasonCodes {
		codes = append(codes, c)
	}
	sort.Strings(codes)

	if findings == nil {
		findings = []textguard.Finding{}
	}

	return textguard.DecodedText{
		Text:        current,
		ReasonCodes: codes,
		DecodeDepth: depth,
		Findings:    findings,
	}
}

// ---------------------------------------------------------------------------
// Bounded-decode helpers
// ---------------------------------------------------------------------------

func applyBoundedDecode(
	current string,
	candidate *string,
	reason string,
	reasonCodes map[string]struct{},
	emittedFindings map[string]struct{},
	findings *[]textguard.Finding,
	maxExpansionRatio float64,
	maxTotalChars int,
) (string, bool) {
	if candidate == nil || *candidate == current {
		return current, false
	}

	cand := *candidate

	candidateChars := utf8.RuneCountInString(cand)
	if candidateChars > maxTotalChars {
		recordReason(
			"encoding:decode_bound_hit", "warn",
			reasonCodes, emittedFindings, findings,
			"Decode candidate exceeded max_total_chars",
		)
		return current, false
	}

	expansionLimit := int(float64(utf8.RuneCountInString(current)) * maxExpansionRatio)
	if expansionLimit < 1 {
		expansionLimit = 1
	}
	if candidateChars > expansionLimit {
		recordReason(
			"encoding:decode_bound_hit", "warn",
			reasonCodes, emittedFindings, findings,
			"Decode candidate exceeded max_expansion_ratio",
		)
		return current, false
	}

	detail := strings.ReplaceAll(
		strings.TrimPrefix(reason, "encoding:"),
		"_", " ",
	)
	recordReason(
		reason, "info",
		reasonCodes, emittedFindings, findings,
		fmt.Sprintf("Applied %s", detail),
	)
	return cand, true
}

func recordReason(
	reason, severity string,
	reasonCodes map[string]struct{},
	emittedFindings map[string]struct{},
	findings *[]textguard.Finding,
	detail string,
) {
	reasonCodes[reason] = struct{}{}
	if _, already := emittedFindings[reason]; already {
		return
	}
	*findings = append(*findings, textguard.Finding{
		Kind:     reason,
		Severity: severity,
		Detail:   detail,
	})
	emittedFindings[reason] = struct{}{}
}

func hasAdditionalLayer(text string, steps []struct {
	fn     func(string) *string
	reason string
}) bool {
	for _, s := range steps {
		if s.fn(text) != nil {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Individual decoders — each returns nil when nothing changed
// ---------------------------------------------------------------------------

func urlDecodeCandidate(text string) *string {
	if !strings.Contains(text, "%") {
		return nil
	}
	// Decode valid escapes even when malformed escapes occur elsewhere.
	var out strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] == '%' && i+2 < len(text) {
			if b, err := strconv.ParseUint(text[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(b))
				i += 2
				continue
			}
		}
		out.WriteByte(text[i])
	}
	candidate := charclass.ReplaceInvalidUTF8(out.String())
	if candidate == text {
		return nil
	}
	return &candidate
}

func htmlDecodeCandidate(text string) *string {
	if !strings.Contains(text, "&") {
		return nil
	}
	// Python's HTML5 decoder drops disallowed numeric references. Decode each
	// reference once so generated ampersands cannot expose another layer early.
	candidate := numericEntityRE.ReplaceAllStringFunc(text, func(entity string) string {
		digits := strings.TrimSuffix(entity[2:], ";")
		base := 10
		if digits[0] == 'x' || digits[0] == 'X' {
			base = 16
			digits = digits[1:]
		}
		cp, err := strconv.ParseUint(digits, base, 32)
		if err != nil || cp > 0x10ffff {
			return "\ufffd"
		}
		if cp >= 1 && cp <= 8 || cp == 11 || cp >= 14 && cp <= 31 || cp == 127 || cp >= 0xfdd0 && cp <= 0xfdef || cp&0xffff >= 0xfffe {
			return ""
		}
		return entity
	})
	candidate = html.UnescapeString(candidate)
	if candidate == text {
		return nil
	}
	return &candidate
}

func rot13DecodeCandidate(text string) *string {
	translated := rot13(text)
	if translated == text {
		return nil
	}

	loweredRaw := charclass.LowerForSignals(text)
	loweredDecoded := charclass.LowerForSignals(translated)

	decodedHits := make(map[string]struct{})
	for _, tok := range rot13SignalTokens {
		if strings.Contains(loweredDecoded, tok) {
			decodedHits[tok] = struct{}{}
		}
	}
	if len(decodedHits) == 0 {
		return nil
	}

	rawHits := make(map[string]struct{})
	for _, tok := range rot13SignalTokens {
		if strings.Contains(loweredRaw, tok) {
			rawHits[tok] = struct{}{}
		}
	}

	// There must be at least one NEW signal in the decoded text.
	hasNew := false
	for tok := range decodedHits {
		if _, inRaw := rawHits[tok]; !inRaw {
			hasNew = true
			break
		}
	}
	if !hasNew {
		return nil
	}
	return &translated
}

func rot13(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			r = 'A' + (r-'A'+13)%26
		case r >= 'a' && r <= 'z':
			r = 'a' + (r-'a'+13)%26
		}
		b.WriteRune(r)
	}
	return b.String()
}

// base64DecodeCandidate tries full-text base64 first, then inline token replacement.
func base64DecodeCandidate(text string) *string {
	// Try full string decode
	candidate := base64DecodeString(text, true)
	if candidate != nil {
		if *candidate == text || !looksLikeText(*candidate) {
			return nil
		} else {
			return candidate
		}
	}
	return base64DecodeInlineCandidate(text)
}

// Base64DecodeCandidate is exported for use by detect/encoded.
func Base64DecodeCandidate(text string) *string {
	return base64DecodeCandidate(text)
}

func base64DecodeInlineCandidate(text string) *string {
	// Scan for base64 tokens using a manual boundary approach.
	// We can't use Go RE2 lookaround, so we scan for runs of base64 chars
	// and check boundary conditions manually. This avoids consuming boundary
	// characters that separate adjacent tokens.
	type tokenLoc struct{ start, end int }
	var tokens []tokenLoc

	i := 0
	for i < len(text) {
		// Skip non-base64 chars.
		if !isBase64Char(text[i]) {
			i++
			continue
		}
		// Found start of a potential base64 run.
		start := i
		for i < len(text) && isBase64Char(text[i]) {
			i++
		}
		// Consume trailing padding.
		for i < len(text) && text[i] == '=' {
			i++
		}
		end := i
		// Check boundary: must be at string edges or adjacent to non-base64 chars.
		atStart := start == 0 || (text[start-1] != '=' && !isBase64Char(text[start-1]))
		atEnd := end == len(text) || (text[end] != '=' && !isBase64Char(text[end]))
		// Min 24 base64 chars (excluding padding).
		tokenLen := end - start
		for tokenLen > 0 && start+tokenLen-1 < end && text[start+tokenLen-1] == '=' {
			tokenLen--
		}
		if atStart && atEnd && tokenLen >= 24 && end-start-tokenLen <= 2 {
			tokens = append(tokens, tokenLoc{start, end})
		}
	}

	if len(tokens) == 0 {
		return nil
	}

	var b strings.Builder
	cursor := 0
	changed := false

	for _, loc := range tokens {
		b.WriteString(text[cursor:loc.start])
		token := text[loc.start:loc.end]

		decoded := base64DecodeString(token, false)
		if decoded != nil && *decoded != token && looksLikeText(*decoded) {
			b.WriteString(*decoded)
			changed = true
		} else {
			b.WriteString(token)
		}
		cursor = loc.end
	}
	b.WriteString(text[cursor:])

	if !changed {
		return nil
	}
	result := b.String()
	return &result
}

func isBase64Char(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/'
}

func base64DecodeString(text string, allowWhitespace bool) *string {
	compact := text
	if allowWhitespace {
		// Reject non-Base64 prose before allocating a whitespace-stripped copy.
		// This is the same full-string alphabet and minimum compact length as
		// Python's regex, without scanning ordinary prose through RE2 twice.
		hasWhitespace := false
		for _, r := range text {
			if charclass.PythonSpace(r) {
				hasWhitespace = true
				continue
			}
			if r > 127 || !isBase64Char(byte(r)) && r != '=' {
				return nil
			}
		}
		if hasWhitespace {
			compact = strings.Map(func(r rune) rune {
				if charclass.PythonSpace(r) {
					return -1
				}
				return r
			}, text)
		}
	}
	if len(compact) < 24 {
		return nil
	}

	if !allowWhitespace {
		// Token mode: validate base64 chars with = only as trailing padding (0-2).
		// Matches Python's _BASE64_TOKEN_RE.fullmatch() behavior.
		seenPadding := false
		for _, r := range compact {
			if r == '=' {
				seenPadding = true
			} else if seenPadding {
				// Non-padding char after padding: invalid.
				return nil
			} else if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '+' || r == '/') {
				return nil
			}
		}
	}

	// Add padding if needed
	padding := (4 - (len(compact) % 4)) % 4
	padded := compact + strings.Repeat("=", padding)

	decoded, err := base64.StdEncoding.DecodeString(padded)
	if err != nil {
		return nil
	}

	if !utf8.Valid(decoded) {
		return nil
	}
	s := string(decoded)
	return &s
}

func looksLikeText(candidate string) bool {
	if len(candidate) == 0 || strings.ContainsRune(candidate, '\x00') {
		return false
	}
	total := 0
	printable := 0
	for _, r := range candidate {
		total++
		if charclass.Printable(r) || charclass.PythonSpace(r) {
			printable++
		}
	}
	if total == 0 {
		return false
	}
	ratio := float64(printable) / float64(total)
	if ratio < 0.85 {
		return false
	}
	for _, r := range candidate {
		if charclass.Letter(r) {
			return true
		}
	}
	return false
}

func unicodeEscapeDecodeCandidate(text string) *string {
	if !unicodeEscapeRE.MatchString(text) {
		return nil
	}
	candidate := unicodeEscapeRE.ReplaceAllStringFunc(text, func(match string) string {
		subs := unicodeEscapeRE.FindStringSubmatch(match)
		hexText := subs[1]
		if hexText == "" {
			hexText = subs[2]
		}
		cp, err := strconv.ParseUint(hexText, 16, 32)
		if err != nil || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff {
			return match
		}
		return string(rune(cp))
	})
	if candidate == text {
		return nil
	}
	return &candidate
}

func hexEscapeDecodeCandidate(text string) *string {
	if !hexEscapeRE.MatchString(text) {
		return nil
	}
	candidate := hexEscapeRE.ReplaceAllStringFunc(text, func(match string) string {
		subs := hexEscapeRE.FindStringSubmatch(match)
		cp, _ := strconv.ParseUint(subs[1], 16, 8)
		return string(rune(cp))
	})
	if candidate == text {
		return nil
	}
	return &candidate
}

func punycodeDecodeCandidate(text string) *string {
	if !strings.Contains(strings.ToLower(text), "xn--") {
		return nil
	}
	changed := false
	var out strings.Builder
	last := 0
	for _, loc := range punycodeRE.FindAllStringIndex(text, -1) {
		match := text[loc[0]:loc[1]]
		out.WriteString(text[last:loc[0]])
		last = loc[1]
		before, _ := utf8.DecodeLastRuneInString(text[:loc[0]])
		after, _ := utf8.DecodeRuneInString(text[loc[1]:])
		word := func(r rune) bool { return charclass.Letter(r) || charclass.Number(r) || r == '_' }
		if !strings.HasPrefix(match, "xn--") || loc[0] > 0 && word(before) || loc[1] < len(text) && word(after) {
			out.WriteString(match)
			continue
		}
		decoded, err := idna.ToUnicode(match)
		roundtrip, roundtripErr := idna.New(idna.MapForLookup(), idna.Transitional(true)).ToASCII(decoded)
		if err != nil || roundtripErr != nil || roundtrip != match {
			out.WriteString(match)
			continue
		}
		if decoded != match {
			changed = true
		}
		out.WriteString(decoded)
	}
	out.WriteString(text[last:])
	candidate := out.String()
	if !changed {
		return nil
	}
	return &candidate
}
