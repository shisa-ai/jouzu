// Modified for deterministic Unicode conformance and bounded native scanning.
// Package scan implements the read-only text analysis pipeline for textguard.
//
// ScanText performs aggressive normalization, recursive decoding, dual-pass
// detection (on both normalized and decoded text), deduplication, and optional
// context attachment. The result is a ScanResult suitable for downstream
// inspection or further processing by the clean pipeline.
package scan

import (
	"github.com/shisa-ai/textguard-go/internal/decode"
	"github.com/shisa-ai/textguard-go/internal/detect"
	"github.com/shisa-ai/textguard-go/internal/normalize"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// contextRadius is the number of characters before and after a finding's offset
// used to build the excerpt in AttachContext.
const contextRadius = 24

// ScanText runs the read-only analysis pipeline on text.
//
// Scan-time normalization is intentionally aggressive regardless of the clean
// preset's strip_* settings. Presets control rewrite behavior in clean(); scan()
// always unwraps hostile formatting so detectors and optional backends analyze
// the strongest signal.
func ScanText(text string, config *textguard.TextGuardConfig, includeContext bool) *textguard.ScanResult {
	return ScanTextBounded(text, config, includeContext, nil)
}

// ScanTextBounded shares a producer budget across normalization and detection.
func ScanTextBounded(text string, config *textguard.TextGuardConfig, includeContext bool, budget *textguard.FindingBudget) *textguard.ScanResult {
	result := textguard.NewScanResult()

	// --- Step 1: Normalize (aggressive mode) ---
	normForm := config.PresetSettings().NormalizationForm
	normalizedText, _ := normalize.NormalizeText(text,
		normalize.WithNormForm(normForm),
		normalize.WithFindingBudget(budget),
		normalize.WithStripANSI(true),
		normalize.WithStripInvisible(true),
		normalize.WithStripBidi(true),
		normalize.WithStripVariationSelectors(true),
		normalize.WithStripTagChars(true),
		normalize.WithStripSoftHyphens(true),
		normalize.WithCollapseWhitespace(true),
	)
	// Normalize findings are intentionally discarded during scan.

	// --- Step 2: Decode ---
	decoded := decode.TextLayers(normalizedText)
	decodedText := decoded.Text

	// Decoder emits at most one finding per fixed reason code (nine total).
	for range decoded.Findings {
		budget.Take()
	}
	findings := make([]textguard.Finding, 0, len(decoded.Findings))
	findings = append(findings, decoded.Findings...)

	// --- Step 3: Dual-pass detection ---
	confusables := config.Confusables
	if confusables == "" {
		confusables = textguard.ConfusablesTrimmed
	}
	splitTokens := config.SplitTokens

	// First pass: detectors on original text (matches Python scan_text behavior —
	// detectors see raw input so invisible chars, homoglyphs, and encoded payloads
	// that normalization would strip are still detected with accurate offsets).
	findings = append(findings, detect.DetectInvisibleTextBounded(text, false, budget)...)
	findings = append(findings, detect.DetectHomoglyphsBounded(text, confusables, false, budget)...)
	findings = append(findings, detect.DetectEncodedPayloadsBounded(text, splitTokens, false, budget)...)

	// Second pass: if decoded text differs from normalized, run detectors on decoded text
	if decodedText != normalizedText {
		findings = append(findings, detect.DetectInvisibleTextBounded(decodedText, true, budget)...)
		findings = append(findings, detect.DetectHomoglyphsBounded(decodedText, confusables, true, budget)...)
		findings = append(findings, detect.DetectEncodedPayloadsBounded(decodedText, splitTokens, true, budget)...)
	}

	// --- Step 4: Deduplicate ---
	findings = DedupeFindings(findings)

	// --- Step 5: Context attachment (optional) ---
	if includeContext {
		findings = AttachContext(text, findings)
	}

	// --- Step 6: Build result ---
	result.Findings = findings
	result.NormalizedText = normalizedText
	result.DecodedText = decodedText
	result.DecodeDepth = decoded.DecodeDepth
	result.DecodeReasonCodes = decoded.ReasonCodes
	if result.DecodeReasonCodes == nil {
		result.DecodeReasonCodes = []string{}
	}

	return result
}

// dedupeKey is the 5-tuple used to identify duplicate findings.
// Offset uses a sentinel value (-1) when nil to distinguish nil from 0.
type dedupeKey struct {
	kind      string
	severity  string
	detail    string
	codepoint string
	offset    int
}

const nilOffsetSentinel = -1

// DedupeFindings removes duplicate findings by 5-tuple key:
// (kind, severity, detail, codepoint, offset). Where offset is nil, a sentinel
// value is used. The first occurrence is preserved; order is maintained.
func DedupeFindings(findings []textguard.Finding) []textguard.Finding {
	deduped := make([]textguard.Finding, 0, len(findings))
	seen := make(map[dedupeKey]struct{}, len(findings))

	for _, f := range findings {
		offset := nilOffsetSentinel
		if f.Offset != nil {
			offset = *f.Offset
		}
		key := dedupeKey{
			kind:      f.Kind,
			severity:  f.Severity,
			detail:    f.Detail,
			codepoint: f.Codepoint,
			offset:    offset,
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, f)
	}
	return deduped
}

// AttachContext annotates findings that have a non-nil offset with a
// FindingContext containing an excerpt of the original text. The excerpt
// spans contextRadius characters before and after the offset, clamped to
// text boundaries. Findings with nil offset are passed through unchanged.
//
// Note: the excerpt uses rune (character) indexing, not byte indexing, to
// match the Python implementation's behavior with str slicing.
func AttachContext(originalText string, findings []textguard.Finding) []textguard.Finding {
	// Convert to runes for character-based slicing.
	runes := []rune(originalText)
	runeCount := len(runes)

	contextualized := make([]textguard.Finding, 0, len(findings))
	for _, f := range findings {
		if f.Offset == nil {
			contextualized = append(contextualized, f)
			continue
		}

		offset := *f.Offset

		// Validate the offset is reasonable to avoid silent corruption.
		if offset < 0 || offset > runeCount {
			contextualized = append(contextualized, f)
			continue
		}

		start := offset - contextRadius
		if start < 0 {
			start = 0
		}
		end := offset + contextRadius
		if end > runeCount {
			end = runeCount
		}

		excerpt := string(runes[start:end])
		f.Context = &textguard.FindingContext{Excerpt: excerpt}
		contextualized = append(contextualized, f)
	}
	return contextualized
}
