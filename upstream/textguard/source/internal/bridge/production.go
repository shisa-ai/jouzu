// Modified for deterministic Unicode conformance and bounded native scanning.
package bridge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"unicode/utf8"

	textguard "github.com/shisa-ai/textguard-go"
)

const ProductionVersion = 1
const ProductionFindingBudget = 4096
const ProductionReportLimit = 64
const ProductionResponseLimit = 64 << 10

// ProductionRunner accepts only deterministic scans under one fixed policy.
// It is initialized without reading environment or filesystem configuration.
type ProductionRunner struct{ guard *textguard.Guard }

type ProductionFinding struct {
	Kind      string `json:"kind"`
	Severity  string `json:"severity"`
	Offset    *int   `json:"offset"`
	Codepoint string `json:"codepoint"`
}

type ProductionResponse struct {
	Version        int                 `json:"version"`
	ID             string              `json:"id"`
	InputSHA256    string              `json:"input_sha256"`
	Status         string              `json:"status"`
	Reason         string              `json:"reason,omitempty"`
	Findings       []ProductionFinding `json:"findings"`
	FindingCount   int                 `json:"finding_count"`
	SeverityCounts map[string]int      `json:"severity_counts"`
	DecodeReasons  []string            `json:"decode_reasons"`
}

func NewProductionRunner() (*ProductionRunner, error) {
	guard, err := textguard.NewGuard(textguard.WithIsolatedConfig(), textguard.WithSplitTokens(true), textguard.WithYaraBundled(true))
	if err != nil {
		return nil, err
	}
	return &ProductionRunner{guard: guard}, nil
}

func (r *ProductionRunner) Handle(payload []byte) []byte {
	response := r.scan(payload)
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) > ProductionResponseLimit {
		response.Status, response.Reason = "unavailable", "output-limit"
		response.Findings = []ProductionFinding{}
		response.DecodeReasons = []string{}
		encoded, _ = json.Marshal(response)
	}
	return encoded
}

func (r *ProductionRunner) scan(payload []byte) ProductionResponse {
	response := ProductionResponse{
		Version: ProductionVersion, Status: "unavailable", Reason: "protocol",
		Findings: []ProductionFinding{}, DecodeReasons: []string{},
		SeverityCounts: map[string]int{"info": 0, "warn": 0, "error": 0},
	}
	if len(payload) > MaxRequestBytes || validateJSON(payload) != nil {
		return response
	}
	var request struct {
		Version int     `json:"version"`
		ID      string  `json:"id"`
		Text    *string `json:"text"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.Version != ProductionVersion || request.Text == nil {
		return response
	}
	if len(request.ID) < 1 || len(request.ID) > 64 {
		return response
	}
	for _, c := range request.ID {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return response
		}
	}
	response.ID = request.ID
	if !utf8.ValidString(*request.Text) {
		return response
	}
	if len(*request.Text) > MaxInputBytes {
		response.Reason = "input-limit"
		return response
	}
	sum := sha256.Sum256([]byte(*request.Text))
	response.InputSHA256 = hex.EncodeToString(sum[:])
	result, err := r.guard.ScanBounded(*request.Text, ProductionFindingBudget)
	if err != nil {
		var limit textguard.FindingLimitError
		if errors.As(err, &limit) {
			response.Reason = "finding-limit"
		} else {
			response.Reason = "scanner"
		}
		return response
	}
	response.Status, response.Reason = "clear", ""
	response.FindingCount = len(result.Findings)
	if response.FindingCount > 0 {
		response.Status = "findings"
	}
	for _, f := range result.Findings {
		response.SeverityCounts[f.Severity]++
		if len(response.Findings) < ProductionReportLimit {
			response.Findings = append(response.Findings, ProductionFinding{f.Kind, f.Severity, f.Offset, f.Codepoint})
		}
	}
	response.DecodeReasons = result.DecodeReasonCodes
	for _, reason := range response.DecodeReasons {
		if reason == "encoding:decode_bound_hit" || reason == "encoding:decode_depth_limited" {
			response.Status, response.Reason = "unavailable", "decode-limit"
		}
	}
	return response
}
