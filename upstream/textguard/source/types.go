package textguard

import "github.com/shisa-ai/textguard-go/internal/tgtypes"

// Version is the library version, matching the Python textguard release.
const Version = tgtypes.Version

// Type aliases re-exported from internal/tgtypes so the public API surface
// is unchanged while internal packages import from tgtypes to avoid cycles.

// FindingContext holds a short excerpt of the original text surrounding a finding.
type FindingContext = tgtypes.FindingContext

// Finding represents a single issue detected during scanning.
// Offset is a pointer so it serializes to JSON null (not 0) when absent.
type Finding = tgtypes.Finding

// Change records a single transformation applied during cleaning.
type Change = tgtypes.Change

// SemanticResult holds the output of a semantic (ML) classifier.
type SemanticResult = tgtypes.SemanticResult

// DecodedText holds the result of recursive text decoding.
type DecodedText = tgtypes.DecodedText

// NewDecodedText creates a DecodedText with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
var NewDecodedText = tgtypes.NewDecodedText

// ScanResult is the read-only analysis output from Scan().
type ScanResult = tgtypes.ScanResult

// NewScanResult creates a ScanResult with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
var NewScanResult = tgtypes.NewScanResult

// CleanResult holds cleaned output plus the findings that informed it.
type CleanResult = tgtypes.CleanResult

// NewCleanResult creates a CleanResult with all slice fields initialized to
// non-nil empty slices so JSON marshalling produces [] instead of null.
var NewCleanResult = tgtypes.NewCleanResult
