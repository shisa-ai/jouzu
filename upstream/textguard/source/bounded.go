// Modified for deterministic Unicode conformance and bounded native scanning.
package textguard

import (
	"fmt"

	"github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// MaxBoundedInputBytes is the UTF-8 input ceiling for ScanBounded.
const MaxBoundedInputBytes = 256 << 10

// FindingLimitError means analysis stopped before establishing complete coverage.
type FindingLimitError = tgtypes.FindingLimitError

// ScanBounded runs deterministic analysis with an input ceiling and a shared
// producer budget. The budget counts transformation and detector findings before
// deduplication, including normalization findings discarded by the scan result.
// Exhaustion returns no partial result and a FindingLimitError. The ordinary
// Scan API remains unchanged. Semantic backends are not invoked.
//
// maxFindings must be between 1 and 65536. These limits bound finding allocation,
// not total process resident memory; hosts must also enforce execution deadlines.
func (g *Guard) ScanBounded(text string, maxFindings int, opts ...ScanOption) (result *ScanResult, err error) {
	if len(text) > MaxBoundedInputBytes {
		return nil, fmt.Errorf("textguard: bounded input exceeds %d UTF-8 bytes", MaxBoundedInputBytes)
	}
	if maxFindings < 1 || maxFindings > 65536 {
		return nil, fmt.Errorf("textguard: finding budget must be between 1 and 65536")
	}
	defer func() {
		if value := recover(); value != nil {
			if limit, ok := value.(tgtypes.FindingLimitError); ok {
				result, err = nil, limit
			} else {
				panic(value)
			}
		}
	}()
	return g.doScanBudget(text, opts, false, tgtypes.NewFindingBudget(maxFindings))
}
