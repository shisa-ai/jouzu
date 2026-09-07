// Modified for deterministic Unicode conformance and bounded native scanning.
package tgtypes

// FindingLimitError signals incomplete coverage. Callers must not interpret a
// scan stopped by this limit as having no findings.
type FindingLimitError struct{}

func (FindingLimitError) Error() string { return "textguard: finding limit exceeded" }

// FindingBudget bounds findings as they are produced, before deduplication.
// It belongs to one scan and must not be shared between concurrent scans.
// A nil budget preserves the unrestricted library behavior.
type FindingBudget struct {
	remaining int
}

func NewFindingBudget(limit int) *FindingBudget {
	if limit < 1 {
		panic("textguard: finding limit must be positive")
	}
	return &FindingBudget{remaining: limit}
}

// Take reserves one finding before constructing its detail or allocating an
// offset. The bounded scan entry point recovers only FindingLimitError; other
// panics remain programmer errors. Internal producers need not return partial
// results through every layer of the analysis pipeline.
func (b *FindingBudget) Take() {
	if b == nil {
		return
	}
	if b.remaining == 0 {
		panic(FindingLimitError{})
	}
	b.remaining--
}
