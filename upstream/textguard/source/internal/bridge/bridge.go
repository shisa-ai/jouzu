// Modified for deterministic Unicode conformance and bounded native scanning.
// Package bridge implements the bounded JSON protocol shared by native and WASM runners.
package bridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	textguard "github.com/shisa-ai/textguard-go"
)

const (
	Version          = 1
	MaxInputBytes    = 256 << 10
	MaxRequestBytes  = 2 << 20
	MaxResponseBytes = 8 << 20
)

type Request struct {
	Version        int                       `json:"version"`
	ID             string                    `json:"id"`
	Op             string                    `json:"op"`
	Text           *string                   `json:"text"`
	Preset         textguard.PresetName      `json:"preset"`
	Confusables    textguard.ConfusablesMode `json:"confusables"`
	SplitTokens    bool                      `json:"split_tokens"`
	IncludeContext bool                      `json:"include_context"`
	YaraBundled    bool                      `json:"yara_bundled"`
}

type Response struct {
	ID        string          `json:"id"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	ElapsedMS float64         `json:"elapsed_ms"`
}

type key struct {
	preset      textguard.PresetName
	confusables textguard.ConfusablesMode
	split, yara bool
}

// Runner caches at most 24 explicitly configured guards. It exposes no paths,
// environment configuration, network operations, or semantic backends.
type Runner struct {
	mu     sync.Mutex
	guards map[key]*textguard.Guard
}

func (r *Runner) guard(q Request) (*textguard.Guard, error) {
	k := key{q.Preset, q.Confusables, q.SplitTokens, q.YaraBundled}
	r.mu.Lock()
	defer r.mu.Unlock()
	if g := r.guards[k]; g != nil {
		return g, nil
	}
	g, err := textguard.NewGuard(textguard.WithIsolatedConfig(), textguard.WithPreset(q.Preset),
		textguard.WithConfusables(q.Confusables), textguard.WithSplitTokens(q.SplitTokens), textguard.WithYaraBundled(q.YaraBundled))
	if err != nil {
		return nil, err
	}
	if r.guards == nil {
		r.guards = make(map[key]*textguard.Guard)
	}
	r.guards[k] = g
	return g, nil
}

func errorResponse(id string, err error) []byte {
	// IDs are bounded before they can reach an error response.
	if len(id) > 128 {
		id = ""
	}
	out, _ := json.Marshal(Response{ID: id, Error: err.Error()})
	return out
}

// Handle validates and executes one request. ElapsedMS includes the library
// call and result serialization, excluding transport and guard initialization.
func (r *Runner) Handle(payload []byte) []byte {
	if len(payload) > MaxRequestBytes {
		return errorResponse("", fmt.Errorf("request exceeds %d bytes", MaxRequestBytes))
	}
	if err := validateJSON(payload, "version", "id", "op", "text", "preset", "confusables", "split_tokens", "include_context", "yara_bundled"); err != nil {
		return errorResponse("", err)
	}
	var q Request
	d := json.NewDecoder(bytes.NewReader(payload))
	d.DisallowUnknownFields()
	if err := d.Decode(&q); err != nil {
		return errorResponse("", fmt.Errorf("invalid request schema"))
	}
	if len(q.ID) > 128 {
		return errorResponse("", fmt.Errorf("id exceeds 128 bytes"))
	}
	if q.Version != Version {
		return errorResponse(q.ID, fmt.Errorf("unsupported protocol version"))
	}
	if q.Text == nil || !utf8.ValidString(*q.Text) {
		return errorResponse(q.ID, fmt.Errorf("text must be a Unicode string"))
	}
	if len(*q.Text) > MaxInputBytes {
		return errorResponse(q.ID, fmt.Errorf("text exceeds %d UTF-8 bytes", MaxInputBytes))
	}
	if q.Op != "scan" && q.Op != "clean" {
		return errorResponse(q.ID, fmt.Errorf("op must be scan or clean"))
	}
	if q.Preset == "" {
		q.Preset = textguard.PresetDefault
	}
	if q.Confusables == "" {
		q.Confusables = textguard.ConfusablesTrimmed
	}
	g, err := r.guard(q)
	if err != nil {
		return errorResponse(q.ID, fmt.Errorf("invalid configuration"))
	}
	var opts []textguard.ScanOption
	if q.IncludeContext {
		opts = append(opts, textguard.IncludeContext())
	}
	start := time.Now()
	var result any
	if q.Op == "scan" {
		result, err = g.Scan(*q.Text, opts...)
	} else {
		result, err = g.Clean(*q.Text, opts...)
	}
	if err != nil {
		return errorResponse(q.ID, fmt.Errorf("scan failed"))
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return errorResponse(q.ID, fmt.Errorf("result serialization failed"))
	}
	elapsed := float64(time.Since(start).Nanoseconds()) / 1e6
	if len(encoded) > MaxResponseBytes-1024 {
		return errorResponse(q.ID, fmt.Errorf("result exceeds response limit"))
	}
	out, err := json.Marshal(Response{ID: q.ID, Result: encoded, ElapsedMS: elapsed})
	if err != nil || len(out) > MaxResponseBytes {
		return errorResponse(q.ID, fmt.Errorf("response limit exceeded"))
	}
	return out
}

// validateJSON rejects duplicate keys, trailing values and unpaired JSON
// surrogate escapes instead of letting encoding/json silently replace them.
func validateJSON(payload []byte, allowedKeys ...string) error {
	if !utf8.Valid(payload) || !validScalarEscapes(payload) {
		return fmt.Errorf("request contains invalid Unicode")
	}
	d := json.NewDecoder(bytes.NewReader(payload))
	tok, err := d.Token()
	if err != nil || tok != json.Delim('{') {
		return fmt.Errorf("request must be a JSON object")
	}
	seen := make(map[string]bool)
	for d.More() {
		tok, err = d.Token()
		name, ok := tok.(string)
		if err != nil || !ok || seen[name] || !slices.Contains(allowedKeys, name) {
			return fmt.Errorf("invalid or duplicate request key")
		}
		seen[name] = true
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return fmt.Errorf("invalid JSON value")
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("request fields cannot be null")
		}
		if (name == "preset" || name == "confusables") && bytes.Equal(bytes.TrimSpace(raw), []byte(`""`)) {
			return fmt.Errorf("configuration names cannot be empty")
		}
	}
	if _, err = d.Token(); err != nil {
		return fmt.Errorf("invalid JSON object")
	}
	var trailing any
	if err := d.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing JSON data")
	}
	return nil
}

func validScalarEscapes(b []byte) bool {
	for i := 0; i < len(b); i++ {
		if b[i] != '\\' {
			continue
		}
		i++
		if i >= len(b) {
			return false
		}
		if b[i] != 'u' {
			continue
		}
		if i+4 >= len(b) {
			return false
		}
		cp, err := strconv.ParseUint(string(b[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if cp >= 0xdc00 && cp <= 0xdfff {
			return false
		}
		if cp >= 0xd800 && cp <= 0xdbff {
			if i+6 >= len(b) || b[i+1] != '\\' || b[i+2] != 'u' {
				return false
			}
			lo, err := strconv.ParseUint(string(b[i+3:i+7]), 16, 16)
			if err != nil || lo < 0xdc00 || lo > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
