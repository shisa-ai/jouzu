// Modified for deterministic Unicode conformance and bounded native scanning.
// Package textguard provides hostile-text normalization, inspection, and
// cleaning for LLM systems.
//
// The primary entry point is the Guard struct, which is safe for concurrent
// use and lazily initializes backends (YARA matcher, semantic backend).
//
//	g, err := textguard.NewGuard(textguard.WithPreset(textguard.PresetStrict))
//	result, err := g.Scan(text)
//
// Package-level Scan() and Clean() convenience functions create an ephemeral
// Guard with default settings.
package textguard

import (
	"fmt"
	"sync"
	"unicode/utf8"

	"github.com/shisa-ai/textguard-go/internal/clean"
	"github.com/shisa-ai/textguard-go/internal/decode"
	"github.com/shisa-ai/textguard-go/internal/normalize"
	"github.com/shisa-ai/textguard-go/internal/scan"
	"github.com/shisa-ai/textguard-go/internal/tgtypes"
	"github.com/shisa-ai/textguard-go/internal/yaramatch"
)

// ---------------------------------------------------------------------------
// SemanticBackend interface
// ---------------------------------------------------------------------------

// SemanticBackend is the interface for ML-based semantic scoring backends.
// It is implemented by promptguard.Backend but defined here so the root
// package never imports promptguard and its CGo dependencies.
type SemanticBackend interface {
	// ScoreText returns raw malicious-probability scores for each text segment.
	ScoreText(text string) ([]float64, error)
	// ModelSource returns a human-readable identifier for the loaded model.
	ModelSource() string
}

// WithSemanticBackend sets the semantic (ML) backend for the Guard.
// The backend is used by Scan() (when include_semantic is true) and
// ScoreSemantic(). It is NOT part of TextGuardConfig because it is not
// serializable.
func WithSemanticBackend(b SemanticBackend) Option {
	return func(o *configOverrides) {
		o.semanticBackend = b
	}
}

// ---------------------------------------------------------------------------
// ScanOption
// ---------------------------------------------------------------------------

// ScanOption is an alias for Option, allowing scan-specific options
// (like IncludeContext) to be passed to Scan() and Clean().
type ScanOption = Option

// IncludeContext returns an Option that causes Scan() and Clean() to attach
// context excerpts to findings that have an offset.
func IncludeContext() ScanOption {
	return func(o *configOverrides) {
		o.includeContext = true
	}
}

// ---------------------------------------------------------------------------
// Guard struct
// ---------------------------------------------------------------------------

// Guard is the configured entry point for the textguard scan and clean
// pipelines. It is safe for concurrent use; lazy-loaded backends are
// initialized via sync.Once.
type Guard struct {
	config          *TextGuardConfig
	semanticBackend SemanticBackend
	includeContext  bool

	yaraOnce    sync.Once
	yaraMatcher *yaramatch.Matcher
	yaraErr     error
}

// NewGuard creates a Guard with the given configuration options.
// Options are the same as those used for ResolveConfig (WithPreset, etc.)
// plus WithSemanticBackend.
func NewGuard(opts ...Option) (*Guard, error) {
	// Separate semantic backend from config options.
	var overrides configOverrides
	for _, o := range opts {
		o(&overrides)
	}

	// Extract the semantic backend before passing to ResolveConfig.
	var semanticBackend SemanticBackend
	if sb, ok := overrides.semanticBackend.(SemanticBackend); ok {
		semanticBackend = sb
	}

	cfg, err := ResolveConfig(opts...)
	if err != nil {
		return nil, fmt.Errorf("textguard: %w", err)
	}

	if cfg.PromptGuardModelPath != "" && semanticBackend == nil {
		return nil, fmt.Errorf("textguard: a configured model path requires WithSemanticBackend")
	}
	return &Guard{
		config:          cfg,
		semanticBackend: semanticBackend,
		includeContext:  overrides.includeContext,
	}, nil
}

// Scan runs the read-only analysis pipeline on text. Semantic scoring is
// included if a SemanticBackend was configured.
func (g *Guard) Scan(text string, opts ...ScanOption) (*ScanResult, error) {
	return g.doScan(text, opts, true)
}

// Clean normalizes and cleans text according to the configured preset.
// Scan is run first (without semantic scoring) to produce findings.
func (g *Guard) Clean(text string, opts ...ScanOption) (*CleanResult, error) {
	includeContext, err := parseScanOpts(opts)
	if err != nil {
		return nil, err
	}
	includeContext = includeContext || g.includeContext

	scanResult, err := g.doScan(text, opts, false)
	if err != nil {
		return nil, err
	}

	result := clean.CleanText(text, g.config, includeContext, scanResult)
	return result, nil
}

// MatchYara runs the YARA matcher against text. The text is first normalized
// and decoded (matching the Python match_yara behavior).
// Returns an error if YARA is not configured (neither bundled nor rules_dir).
func (g *Guard) MatchYara(text string) ([]Finding, error) {
	if !utf8.ValidString(text) {
		return nil, fmt.Errorf("textguard: input must be valid UTF-8")
	}
	matcher, err := g.loadYara()
	if err != nil {
		return nil, err
	}

	// Normalize aggressively (matching Python's match_yara behavior).
	normalizedText, _ := normalize.NormalizeText(text,
		normalize.WithNormForm(g.config.PresetSettings().NormalizationForm),
		normalize.WithStripANSI(true),
		normalize.WithStripInvisible(true),
		normalize.WithStripBidi(true),
		normalize.WithStripVariationSelectors(true),
		normalize.WithStripTagChars(true),
		normalize.WithStripSoftHyphens(true),
		normalize.WithCollapseWhitespace(true),
	)

	decoded := decode.TextLayers(normalizedText)
	return matcher.Match(text, decoded.Text), nil
}

// ScoreSemantic runs the semantic backend on text and returns a
// SemanticResult. Returns an error if no semantic backend is configured.
func (g *Guard) ScoreSemantic(text string) (*SemanticResult, error) {
	if g.semanticBackend == nil {
		return nil, fmt.Errorf("textguard: semantic backend is not configured for this Guard instance")
	}

	scores, err := g.semanticBackend.ScoreText(text)
	if err != nil {
		return nil, fmt.Errorf("textguard: semantic scoring failed: %w", err)
	}

	result := scoresToSemanticResult(scores, g.semanticBackend.ModelSource())
	return result, nil
}

// ---------------------------------------------------------------------------
// Internal methods
// ---------------------------------------------------------------------------

// doScan is the shared scan implementation. When includeSemantic is true and a
// SemanticBackend is configured, semantic scoring is performed.
func (g *Guard) doScan(text string, opts []ScanOption, includeSemantic bool) (*ScanResult, error) {
	return g.doScanBudget(text, opts, includeSemantic, nil)
}

func (g *Guard) doScanBudget(text string, opts []ScanOption, includeSemantic bool, budget *tgtypes.FindingBudget) (*ScanResult, error) {
	if !utf8.ValidString(text) {
		return nil, fmt.Errorf("textguard: input must be valid UTF-8")
	}
	includeContext, err := parseScanOpts(opts)
	if err != nil {
		return nil, err
	}
	includeContext = includeContext || g.includeContext

	result := scan.ScanTextBounded(text, g.config, includeContext, budget)

	// YARA backend (lazy-loaded).
	if g.config.YaraBundled || g.config.YaraRulesDir != "" {
		matcher, err := g.loadYara()
		if err != nil {
			return nil, fmt.Errorf("textguard: YARA backend failed: %w", err)
		}
		yaraFindings := matcher.MatchBounded(text, result.DecodedText, budget)
		result.Findings = append(result.Findings, yaraFindings...)
		result.Findings = scan.DedupeFindings(result.Findings)
	}

	// Semantic backend (if configured and requested).
	if includeSemantic && g.semanticBackend != nil {
		scores, err := g.semanticBackend.ScoreText(text)
		if err != nil {
			return nil, fmt.Errorf("textguard: semantic scoring failed: %w", err)
		}
		result.Semantic = scoresToSemanticResult(scores, g.semanticBackend.ModelSource())
	}

	return result, nil
}

// loadYara lazily initializes the YARA matcher using sync.Once. If
// initialization fails, the error is permanently cached for this Guard's
// lifetime — callers that need retry semantics should create a new Guard.
func (g *Guard) loadYara() (*yaramatch.Matcher, error) {
	g.yaraOnce.Do(func() {
		g.yaraMatcher, g.yaraErr = yaramatch.New(g.config.YaraBundled, g.config.YaraRulesDir)
	})
	if g.yaraErr != nil {
		return nil, g.yaraErr
	}
	return g.yaraMatcher, nil
}

// parseScanOpts extracts the includeContext flag from ScanOptions.
func parseScanOpts(opts []ScanOption) (bool, error) {
	var overrides configOverrides
	for _, o := range opts {
		o(&overrides)
	}
	if overrides.preset != nil || overrides.confusables != nil || overrides.splitTokens != nil || overrides.yaraRulesDir != nil || overrides.yaraBundled != nil || overrides.promptGuardModelPath != nil || overrides.semanticBackend != nil || overrides.isolated {
		return false, fmt.Errorf("textguard: configure guard options with NewGuard, not per scan or clean call")
	}
	return overrides.includeContext, nil
}

// ---------------------------------------------------------------------------
// Scoring thresholds (mirrored from promptguard/thresholds.go to avoid import)
// ---------------------------------------------------------------------------

const (
	thresholdMedium   = 0.35
	thresholdHigh     = 0.7
	thresholdCritical = 0.9
)

// scoresToSemanticResult converts raw model scores to a SemanticResult.
// Takes the maximum score across all segments, clamps to [0.0, 1.0], and maps
// it to a severity tier. Threshold values mirror promptguard/thresholds.go.
func scoresToSemanticResult(scores []float64, classifierID string) *SemanticResult {
	score := 0.0
	for _, s := range scores {
		if s > score {
			score = s
		}
	}
	// Clamp to [0.0, 1.0] matching promptguard.TierFor() behavior.
	if score < 0.0 {
		score = 0.0
	} else if score > 1.0 {
		score = 1.0
	}

	var tier string
	switch {
	case score >= thresholdCritical:
		tier = "critical"
	case score >= thresholdHigh:
		tier = "high"
	case score >= thresholdMedium:
		tier = "medium"
	default:
		tier = "none"
	}

	return &SemanticResult{
		Score:        score,
		Tier:         tier,
		ClassifierID: classifierID,
	}
}

// ---------------------------------------------------------------------------
// Package-level convenience functions
// ---------------------------------------------------------------------------

// Scan creates an ephemeral Guard with default settings and runs Scan.
// Options can include both guard-level options (WithPreset, etc.) and
// scan-level options (IncludeContext).
func Scan(text string, opts ...Option) (*ScanResult, error) {
	g, err := NewGuard(opts...)
	if err != nil {
		return nil, err
	}
	return g.Scan(text)
}

// Clean creates an ephemeral Guard with default settings and runs Clean.
// Options can include both guard-level options (WithPreset, etc.) and
// scan-level options (IncludeContext).
func Clean(text string, opts ...Option) (*CleanResult, error) {
	g, err := NewGuard(opts...)
	if err != nil {
		return nil, err
	}
	return g.Clean(text)
}
