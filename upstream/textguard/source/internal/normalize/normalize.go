// Modified for deterministic Unicode conformance and bounded native scanning.
// Package normalize provides text normalization for hostile-content analysis.
//
// NormalizeText applies Unicode normalization, strips invisible characters,
// bidi controls, tag characters, variation selectors, soft hyphens, ANSI
// escape sequences, collapses whitespace, and caps excessive combining marks.
//
// StripNonASCII provides lossy ASCII transliteration via NFKD decomposition.
package normalize

import (
	"fmt"
	"strings"

	"github.com/shisa-ai/textguard-go/internal/charclass"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
	"golang.org/x/text/unicode/norm"
)

// ---------------------------------------------------------------------------
// Functional options
// ---------------------------------------------------------------------------

// normalizeConfig holds all configuration for a NormalizeText call.
type normalizeConfig struct {
	form                    textguard.NormalizationForm
	stripANSI               bool
	stripInvisible          bool
	stripBidi               bool
	stripVariationSelectors bool
	stripTagChars           bool
	stripSoftHyphens        bool
	collapseWhitespace      bool
	maxCombiningMarks       *int // nil = no limit
	inDecodedText           bool
	budget                  *textguard.FindingBudget
}

// defaults returns a normalizeConfig with default values matching Python's
// normalize_text() defaults.
func defaults() normalizeConfig {
	cap := charclass.DefaultCombiningMarkCap
	return normalizeConfig{
		form:                    textguard.NormNFC,
		stripANSI:               true,
		stripInvisible:          true,
		stripBidi:               true,
		stripVariationSelectors: true,
		stripTagChars:           true,
		stripSoftHyphens:        true,
		collapseWhitespace:      true,
		maxCombiningMarks:       &cap,
	}
}

// NormalizeOption configures a NormalizeText call.
type NormalizeOption func(*normalizeConfig)

// WithFindingBudget bounds transformation findings before allocation.
func WithFindingBudget(b *textguard.FindingBudget) NormalizeOption {
	return func(c *normalizeConfig) { c.budget = b }
}

// WithNormForm sets the Unicode normalization form (NFC or NFKC).
func WithNormForm(f textguard.NormalizationForm) NormalizeOption {
	return func(c *normalizeConfig) { c.form = f }
}

// WithStripANSI enables or disables stripping of ANSI escape sequences.
func WithStripANSI(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripANSI = b }
}

// WithStripInvisible enables or disables stripping of invisible characters.
func WithStripInvisible(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripInvisible = b }
}

// WithStripBidi enables or disables stripping of bidi control characters.
func WithStripBidi(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripBidi = b }
}

// WithStripVariationSelectors enables or disables stripping of variation selectors.
func WithStripVariationSelectors(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripVariationSelectors = b }
}

// WithStripTagChars enables or disables stripping of Unicode tag characters.
func WithStripTagChars(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripTagChars = b }
}

// WithStripSoftHyphens enables or disables stripping of soft hyphens.
func WithStripSoftHyphens(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.stripSoftHyphens = b }
}

// WithCollapseWhitespace enables or disables whitespace collapsing.
func WithCollapseWhitespace(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.collapseWhitespace = b }
}

// WithMaxCombiningMarks sets the maximum consecutive combining marks allowed.
// Pass nil to disable the cap entirely.
func WithMaxCombiningMarks(n *int) NormalizeOption {
	return func(c *normalizeConfig) { c.maxCombiningMarks = n }
}

// WithInDecodedText marks findings as originating from decoded text. When true,
// finding offsets are nil and detail strings are suffixed with " in decoded text".
func WithInDecodedText(b bool) NormalizeOption {
	return func(c *normalizeConfig) { c.inDecodedText = b }
}

// FromPreset applies all normalization flags from a Preset.
func FromPreset(p textguard.Preset) NormalizeOption {
	return func(c *normalizeConfig) {
		c.form = p.NormalizationForm
		c.stripANSI = p.StripANSI
		c.stripInvisible = p.StripInvisible
		c.stripBidi = p.StripBidi
		c.stripVariationSelectors = p.StripVariationSelectors
		c.stripTagChars = p.StripTagChars
		c.stripSoftHyphens = p.StripSoftHyphens
		c.collapseWhitespace = p.CollapseWhitespace
		c.maxCombiningMarks = p.MaxCombiningMarks
	}
}

// ---------------------------------------------------------------------------
// NormalizeText
// ---------------------------------------------------------------------------

// NormalizeText normalizes text for hostile-content analysis. It returns the
// normalized text and a slice of findings for each transformation applied.
//
// With no options, all strip operations are enabled (matching Python defaults).
// Use functional options to override individual flags or apply a Preset.
func NormalizeText(text string, opts ...NormalizeOption) (string, []textguard.Finding) {
	cfg := defaults()
	for _, o := range opts {
		o(&cfg)
	}

	// Validate normalization form.
	if cfg.form != textguard.NormNFC && cfg.form != textguard.NormNFKC {
		panic(fmt.Sprintf("normalize: form must be NFC or NFKC, got %q", cfg.form))
	}

	findings := []textguard.Finding{}

	// Step 1: Strip ANSI escape sequences.
	stripped := text
	if cfg.stripANSI {
		stripped = stripANSISequences(stripped, &findings, cfg.inDecodedText, cfg.budget)
	}

	// Step 2: Character-level filtering (invisible, bidi, variation selectors,
	// tag chars, soft hyphens) and whitespace collapsing.
	var filtered strings.Builder
	filtered.Grow(len(stripped))
	previousWasSpace := false

	runeIdx := 0
	for _, ch := range stripped {
		cp := ch

		if cfg.stripInvisible && charclass.IsInvisible(cp) {
			appendCharFinding(&findings, "invisible_char", "warn", cp, runeIdx, "", cfg.inDecodedText, cfg.budget)
			runeIdx++
			continue
		}
		if cfg.stripBidi && charclass.IsBidi(cp) {
			appendCharFinding(&findings, "bidi_control", "error", cp, runeIdx, "", cfg.inDecodedText, cfg.budget)
			runeIdx++
			continue
		}
		if cfg.stripVariationSelectors && charclass.IsVariationSelector(cp) {
			appendCharFinding(&findings, "variation_selector", "warn", cp, runeIdx, "", cfg.inDecodedText, cfg.budget)
			runeIdx++
			continue
		}
		if cfg.stripTagChars && charclass.IsTagCharacter(cp) {
			appendCharFinding(&findings, "tag_character", "error", cp, runeIdx, "", cfg.inDecodedText, cfg.budget)
			runeIdx++
			continue
		}
		if cfg.stripSoftHyphens && charclass.IsSoftHyphen(cp) {
			appendCharFinding(&findings, "soft_hyphen", "warn", cp, runeIdx, "", cfg.inDecodedText, cfg.budget)
			runeIdx++
			continue
		}

		if cfg.collapseWhitespace && charclass.PythonSpace(ch) {
			if !previousWasSpace {
				filtered.WriteByte(' ')
			}
			previousWasSpace = true
			runeIdx++
			continue
		}

		filtered.WriteRune(ch)
		previousWasSpace = false
		runeIdx++
	}

	// Step 3: Unicode normalization (NFC or NFKC).
	form := norm.NFC
	if cfg.form == textguard.NormNFKC {
		form = norm.NFKC
	}
	normalized := UnicodeNormalize(filtered.String(), form)

	// Step 4: Trim if collapsing whitespace.
	if cfg.collapseWhitespace {
		normalized = strings.TrimFunc(normalized, charclass.PythonSpace)
	}

	// Step 5: Cap combining marks.
	normalized = capCombiningMarks(normalized, cfg.maxCombiningMarks, &findings, cfg.inDecodedText, cfg.budget)

	return normalized, findings
}

// ---------------------------------------------------------------------------
// StripNonASCII
// ---------------------------------------------------------------------------

// StripNonASCII performs lossy ASCII transliteration: NFKD decomposition
// followed by stripping all non-ASCII bytes.
func StripNonASCII(text string) string {
	// NFKD decomposes characters into compatibility decomposition form.
	decomposed := UnicodeNormalize(text, norm.NFKD)
	var buf strings.Builder
	buf.Grow(len(decomposed))
	for _, r := range decomposed {
		if r < 128 {
			buf.WriteRune(r)
		}
	}
	return buf.String()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// stripANSISequences removes ANSI escape sequences and appends findings.
func stripANSISequences(text string, findings *[]textguard.Finding, inDecodedText bool, budgets ...*textguard.FindingBudget) string {
	budget := firstBudget(budgets)
	matches := charclass.ANSIEscapeRE.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}

	detail := "ANSI escape sequence stripped"
	if inDecodedText {
		detail += " in decoded text"
	}

	var runeTable charclass.ByteToRuneTable
	if !inDecodedText {
		runeTable = charclass.NewByteToRuneTable(text)
	}

	var buf strings.Builder
	buf.Grow(len(text))
	lastEnd := 0
	for _, m := range matches {
		budget.Take()
		buf.WriteString(text[lastEnd:m[0]])
		f := textguard.Finding{
			Kind:     "ansi_escape",
			Severity: "warn",
			Detail:   detail,
		}
		if !inDecodedText {
			offset := runeTable.RuneOffset(m[0])
			f.Offset = &offset
		}
		*findings = append(*findings, f)
		lastEnd = m[1]
	}
	buf.WriteString(text[lastEnd:])
	return buf.String()
}

// capCombiningMarks strips consecutive combining marks that exceed the cap.
func capCombiningMarks(text string, maxCombining *int, findings *[]textguard.Finding, inDecodedText bool, budgets ...*textguard.FindingBudget) string {
	budget := firstBudget(budgets)
	if maxCombining == nil {
		return text
	}
	cap := *maxCombining
	if cap < 0 {
		panic("normalize: max_combining_marks must be >= 0 or nil")
	}

	var buf strings.Builder
	buf.Grow(len(text))
	runLength := 0

	runeIdx := 0
	for _, ch := range text {
		if charclass.CombiningClass(ch) != 0 {
			runLength++
			if runLength > cap {
				appendCharFinding(findings, "combining_abuse", "warn", ch, runeIdx,
					fmt.Sprintf("Combining mark cap exceeded (%d)", cap), inDecodedText, budget)
				runeIdx++
				continue
			}
		} else {
			runLength = 0
		}
		buf.WriteRune(ch)
		runeIdx++
	}
	return buf.String()
}

// appendCharFinding adds a character-level finding to the findings slice.
func firstBudget(budgets []*textguard.FindingBudget) *textguard.FindingBudget {
	if len(budgets) == 0 {
		return nil
	}
	return budgets[0]
}

func appendCharFinding(findings *[]textguard.Finding, kind, severity string, cp rune, offset int, detail string, inDecodedText bool, budgets ...*textguard.FindingBudget) {
	firstBudget(budgets).Take()
	cpText := charclass.FormatCodepoint(cp)
	if detail == "" {
		detail = charclass.KindToTitle(kind) + " " + cpText
	}
	if inDecodedText {
		detail += " in decoded text"
	}
	f := textguard.Finding{
		Kind:      kind,
		Severity:  severity,
		Detail:    detail,
		Codepoint: cpText,
	}
	if !inDecodedText {
		f.Offset = &offset
	}
	*findings = append(*findings, f)
}
