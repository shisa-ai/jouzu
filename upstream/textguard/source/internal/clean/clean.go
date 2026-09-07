// Modified for deterministic Unicode conformance and bounded native scanning.
// Package clean provides text cleaning using preset-controlled normalization,
// stripping, decoding, and ASCII transliteration.
package clean

import (
	"fmt"

	"github.com/shisa-ai/textguard-go/internal/decode"
	"github.com/shisa-ai/textguard-go/internal/normalize"
	"github.com/shisa-ai/textguard-go/internal/scan"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
	"golang.org/x/text/unicode/norm"
)

// CleanText applies the preset-controlled cleaning pipeline to text and returns
// a CleanResult with the cleaned text, original text, list of changes, and
// findings from the scan.
//
// If scanResult is nil, ScanText is called to produce findings. If non-nil,
// the provided result is used directly.
func CleanText(text string, config *textguard.TextGuardConfig, includeContext bool, scanResult *textguard.ScanResult) *textguard.CleanResult {
	// Step 0: Run scan if not provided.
	if scanResult == nil {
		scanResult = scan.ScanText(text, config, includeContext)
	}

	preset := config.PresetSettings()
	cleaned := text
	result := textguard.NewCleanResult()

	// Two-stage normalization (intentionally NOT collapsed into one call):
	// Stage 1 applies bare Unicode normalization. Stage 2 calls NormalizeText
	// for stripping. NormalizeText re-applies the same normalization internally,
	// which is a no-op since stage 1 already normalized. This matches Python's
	// clean_text() design where unicodedata.normalize() and normalize_text()
	// are called separately.

	// Step 1: Light Unicode normalization (NFC or NFKC only).
	var normalizedOnly string
	switch preset.NormalizationForm {
	case textguard.NormNFKC:
		normalizedOnly = normalize.UnicodeNormalize(cleaned, norm.NFKC)
	default: // NFC
		normalizedOnly = normalize.UnicodeNormalize(cleaned, norm.NFC)
	}
	if normalizedOnly != cleaned {
		cleaned = normalizedOnly
		result.Changes = append(result.Changes, textguard.Change{
			Kind:   "normalized",
			Detail: fmt.Sprintf("Applied %s normalization", preset.NormalizationForm),
		})
	}

	// Step 2: Full stripping via normalize.NormalizeText with preset flags.
	// Normalize findings are intentionally discarded — scan's detectors already
	// captured per-character findings with original-text offsets.
	cleanedAfterStripping, _ := normalize.NormalizeText(cleaned,
		normalize.WithNormForm(preset.NormalizationForm),
		normalize.WithStripANSI(preset.StripANSI),
		normalize.WithStripInvisible(preset.StripInvisible),
		normalize.WithStripBidi(preset.StripBidi),
		normalize.WithStripVariationSelectors(preset.StripVariationSelectors),
		normalize.WithStripTagChars(preset.StripTagChars),
		normalize.WithStripSoftHyphens(preset.StripSoftHyphens),
		normalize.WithCollapseWhitespace(preset.CollapseWhitespace),
		normalize.WithMaxCombiningMarks(preset.MaxCombiningMarks),
	)
	if cleanedAfterStripping != cleaned {
		cleaned = cleanedAfterStripping
		result.Changes = append(result.Changes, textguard.Change{
			Kind:   "stripped",
			Detail: fmt.Sprintf("Applied %s cleanup rules", preset.Name),
		})
	}

	// Step 3: Conditional decode.
	if preset.DecodeOnClean {
		decoded := decode.TextLayers(cleaned)
		if decoded.Text != cleaned {
			cleaned = decoded.Text
			result.Changes = append(result.Changes, textguard.Change{
				Kind:   "decoded",
				Detail: fmt.Sprintf("Decoded %d encoding layer markers", len(decoded.ReasonCodes)),
			})
		}
	}

	// Step 4: Conditional ASCII transliteration.
	if preset.ASCIITransliterate {
		asciiText := normalize.StripNonASCII(cleaned)
		if asciiText != cleaned {
			cleaned = asciiText
			result.Changes = append(result.Changes, textguard.Change{
				Kind:   "normalized",
				Detail: "Applied ASCII transliteration",
			})
		}
	}

	result.Text = cleaned
	result.OriginalText = text
	result.Findings = scanResult.Findings
	if result.Findings == nil {
		result.Findings = []textguard.Finding{}
	}

	return result
}
