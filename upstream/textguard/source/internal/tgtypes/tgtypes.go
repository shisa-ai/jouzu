// Modified for deterministic Unicode conformance and bounded native scanning.
// Package tgtypes defines the shared types used across all textguard packages.
//
// This package exists to break the import cycle between the root textguard
// package and internal packages (scan, clean, normalize, decode, detect,
// yaramatch). The root package re-exports all types via type aliases.
package tgtypes

import (
	"sort"

	"github.com/shisa-ai/textguard-go/internal/charclass"
)

// Version is the library version, matching the Python textguard release.
const Version = "1.0.0"

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

// FindingContext holds a short excerpt of the original text surrounding a finding.
type FindingContext struct {
	Excerpt string `json:"excerpt"`
}

// Finding represents a single issue detected during scanning.
// Offset is a pointer so it serializes to JSON null (not 0) when absent.
type Finding struct {
	Kind      string          `json:"kind"`
	Severity  string          `json:"severity"`
	Detail    string          `json:"detail"`
	Codepoint string          `json:"codepoint"`
	Offset    *int            `json:"offset"`
	Context   *FindingContext `json:"context"`
}

// Change records a single transformation applied during cleaning.
type Change struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// SemanticResult holds the output of a semantic (ML) classifier.
type SemanticResult struct {
	Score        float64 `json:"score"`
	Tier         string  `json:"tier"`
	ClassifierID string  `json:"classifier_id"`
}

// DecodedText holds the result of recursive text decoding.
type DecodedText struct {
	Text        string    `json:"text"`
	ReasonCodes []string  `json:"reason_codes"`
	DecodeDepth int       `json:"decode_depth"`
	Findings    []Finding `json:"findings"`
}

// NewDecodedText creates a DecodedText with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
func NewDecodedText() DecodedText {
	return DecodedText{
		ReasonCodes: []string{},
		Findings:    []Finding{},
	}
}

// ScanResult is the read-only analysis output from Scan().
//
// NormalizedText and DecodedText are analysis artifacts: Scan() normalizes and
// decodes aggressively so downstream detectors and backends inspect the
// strongest available signal.
type ScanResult struct {
	Findings          []Finding       `json:"findings"`
	NormalizedText    string          `json:"normalized_text"`
	DecodedText       string          `json:"decoded_text"`
	DecodeDepth       int             `json:"decode_depth"`
	DecodeReasonCodes []string        `json:"decode_reason_codes"`
	Semantic          *SemanticResult `json:"semantic"`
}

// NewScanResult creates a ScanResult with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
func NewScanResult() *ScanResult {
	return &ScanResult{
		Findings:          []Finding{},
		DecodeReasonCodes: []string{},
	}
}

// CleanResult holds cleaned output plus the findings that informed it.
//
// Findings reflect what Scan() observed in the original and decoded analysis
// pipeline, not just the subset of issues the active preset rewrote out of
// the final text.
type CleanResult struct {
	Text         string    `json:"text"`
	OriginalText string    `json:"original_text"`
	Changes      []Change  `json:"changes"`
	Findings     []Finding `json:"findings"`
}

// NewCleanResult creates a CleanResult with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
func NewCleanResult() *CleanResult {
	return &CleanResult{
		Changes:  []Change{},
		Findings: []Finding{},
	}
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

// PresetName identifies a built-in configuration preset.
type PresetName string

const (
	PresetDefault PresetName = "default"
	PresetStrict  PresetName = "strict"
	PresetASCII   PresetName = "ascii"
)

// ConfusablesMode controls which confusable mapping dataset is used.
type ConfusablesMode string

const (
	ConfusablesTrimmed ConfusablesMode = "trimmed"
	ConfusablesFull    ConfusablesMode = "full"
)

// NormalizationForm specifies the Unicode normalization form.
type NormalizationForm string

const (
	NormNFC  NormalizationForm = "NFC"
	NormNFKC NormalizationForm = "NFKC"
)

// Preset holds the full set of flags for a named configuration preset.
type Preset struct {
	Name                    PresetName
	NormalizationForm       NormalizationForm
	DecodeOnClean           bool
	ASCIITransliterate      bool
	StripANSI               bool
	StripInvisible          bool
	StripBidi               bool
	StripVariationSelectors bool
	StripTagChars           bool
	StripSoftHyphens        bool
	CollapseWhitespace      bool
	MaxCombiningMarks       *int // nil means no limit
}

// intPtr is a helper to create an *int from a literal.
func intPtr(v int) *int { return &v }

// presets maps preset names to their full configuration.
var presets = map[PresetName]Preset{
	PresetDefault: {
		Name:                    PresetDefault,
		NormalizationForm:       NormNFC,
		DecodeOnClean:           false,
		ASCIITransliterate:      false,
		StripANSI:               false,
		StripInvisible:          false,
		StripBidi:               false,
		StripVariationSelectors: false,
		StripTagChars:           true,
		StripSoftHyphens:        true,
		CollapseWhitespace:      true,
		MaxCombiningMarks:       intPtr(charclass.DefaultCombiningMarkCap),
	},
	PresetStrict: {
		Name:                    PresetStrict,
		NormalizationForm:       NormNFKC,
		DecodeOnClean:           true,
		ASCIITransliterate:      false,
		StripANSI:               true,
		StripInvisible:          true,
		StripBidi:               true,
		StripVariationSelectors: true,
		StripTagChars:           true,
		StripSoftHyphens:        true,
		CollapseWhitespace:      true,
		MaxCombiningMarks:       intPtr(charclass.DefaultCombiningMarkCap),
	},
	PresetASCII: {
		Name:                    PresetASCII,
		NormalizationForm:       NormNFKC,
		DecodeOnClean:           true,
		ASCIITransliterate:      true,
		StripANSI:               true,
		StripInvisible:          true,
		StripBidi:               true,
		StripVariationSelectors: true,
		StripTagChars:           true,
		StripSoftHyphens:        true,
		CollapseWhitespace:      true,
		MaxCombiningMarks:       intPtr(charclass.DefaultCombiningMarkCap),
	},
}

// GetPreset returns the Preset for the given name and a boolean indicating
// whether it was found.
func GetPreset(name PresetName) (Preset, bool) {
	p, ok := presets[name]
	if p.MaxCombiningMarks != nil {
		cap := *p.MaxCombiningMarks
		p.MaxCombiningMarks = &cap
	}
	return p, ok
}

// PresetNames returns the sorted list of available preset names.
func PresetNames() []string {
	names := make([]string, 0, len(presets))
	for k := range presets {
		names = append(names, string(k))
	}
	sort.Strings(names)
	return names
}

// TextGuardConfig is the resolved runtime configuration.
type TextGuardConfig struct {
	Preset               PresetName
	Confusables          ConfusablesMode
	SplitTokens          bool
	YaraRulesDir         string
	YaraBundled          bool
	PromptGuardModelPath string
}

// PresetSettings returns the Preset corresponding to this config's preset name.
func (c *TextGuardConfig) PresetSettings() Preset {
	p, ok := GetPreset(c.Preset)
	if !ok {
		// Should never happen if the config was created via ResolveConfig.
		p, _ = GetPreset(PresetDefault)
		return p
	}
	return p
}
