package textguard

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/shisa-ai/textguard-go/internal/charclass"
)

func TestVersion(t *testing.T) {
	if Version != "1.0.0" {
		t.Errorf("Version = %q, want %q", Version, "1.0.0")
	}
}

func TestNewScanResult_JSONSlicesNotNull(t *testing.T) {
	sr := NewScanResult()
	data, err := json.Marshal(sr)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s := string(data)

	// Findings should be [] not null
	if !strings.Contains(s, `"findings":[]`) {
		t.Errorf("ScanResult.Findings serialized as null, want []; got: %s", s)
	}
	// DecodeReasonCodes should be [] not null
	if !strings.Contains(s, `"decode_reason_codes":[]`) {
		t.Errorf("ScanResult.DecodeReasonCodes serialized as null, want []; got: %s", s)
	}
}

func TestNewCleanResult_JSONSlicesNotNull(t *testing.T) {
	cr := NewCleanResult()
	data, err := json.Marshal(cr)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s := string(data)

	if !strings.Contains(s, `"changes":[]`) {
		t.Errorf("CleanResult.Changes serialized as null, want []; got: %s", s)
	}
	if !strings.Contains(s, `"findings":[]`) {
		t.Errorf("CleanResult.Findings serialized as null, want []; got: %s", s)
	}
}

func TestNewDecodedText_JSONSlicesNotNull(t *testing.T) {
	dt := NewDecodedText()
	data, err := json.Marshal(dt)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s := string(data)

	if !strings.Contains(s, `"reason_codes":[]`) {
		t.Errorf("DecodedText.ReasonCodes serialized as null, want []; got: %s", s)
	}
	if !strings.Contains(s, `"findings":[]`) {
		t.Errorf("DecodedText.Findings serialized as null, want []; got: %s", s)
	}
}

func TestFinding_OffsetNullable(t *testing.T) {
	// Offset nil should serialize as null
	f := Finding{Kind: "test", Severity: "warn", Offset: nil}
	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s := string(data)
	if !strings.Contains(s, `"offset":null`) {
		t.Errorf("Finding.Offset nil serialized wrong, want null; got: %s", s)
	}

	// Offset = 0 should serialize as 0
	zero := 0
	f2 := Finding{Kind: "test", Severity: "warn", Offset: &zero}
	data2, err := json.Marshal(f2)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s2 := string(data2)
	if !strings.Contains(s2, `"offset":0`) {
		t.Errorf("Finding.Offset 0 serialized wrong, want 0; got: %s", s2)
	}

	// Offset = 42 should serialize as 42
	val := 42
	f3 := Finding{Kind: "test", Severity: "warn", Offset: &val}
	data3, err := json.Marshal(f3)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s3 := string(data3)
	if !strings.Contains(s3, `"offset":42`) {
		t.Errorf("Finding.Offset 42 serialized wrong, want 42; got: %s", s3)
	}
}

func TestScanResult_NilSlicesAreNull(t *testing.T) {
	// Verify that bare struct (no constructor) produces null for slices
	sr := ScanResult{}
	data, err := json.Marshal(sr)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	s := string(data)
	if !strings.Contains(s, `"findings":null`) {
		t.Errorf("bare ScanResult.Findings should be null; got: %s", s)
	}
}

func TestNewScanResult_EmptyConstructor(t *testing.T) {
	sr := NewScanResult()
	if sr.Findings == nil {
		t.Error("NewScanResult().Findings is nil, want non-nil empty slice")
	}
	if len(sr.Findings) != 0 {
		t.Errorf("NewScanResult().Findings length = %d, want 0", len(sr.Findings))
	}
	if sr.DecodeReasonCodes == nil {
		t.Error("NewScanResult().DecodeReasonCodes is nil, want non-nil empty slice")
	}
	if len(sr.DecodeReasonCodes) != 0 {
		t.Errorf("NewScanResult().DecodeReasonCodes length = %d, want 0", len(sr.DecodeReasonCodes))
	}
}

func TestNewCleanResult_EmptyConstructor(t *testing.T) {
	cr := NewCleanResult()
	if cr.Changes == nil {
		t.Error("NewCleanResult().Changes is nil, want non-nil empty slice")
	}
	if cr.Findings == nil {
		t.Error("NewCleanResult().Findings is nil, want non-nil empty slice")
	}
}

func TestNewDecodedText_EmptyConstructor(t *testing.T) {
	dt := NewDecodedText()
	if dt.ReasonCodes == nil {
		t.Error("NewDecodedText().ReasonCodes is nil, want non-nil empty slice")
	}
	if dt.Findings == nil {
		t.Error("NewDecodedText().Findings is nil, want non-nil empty slice")
	}
}

func TestScanResult_InstanceIndependence(t *testing.T) {
	sr1 := NewScanResult()
	sr2 := NewScanResult()
	sr1.Findings = append(sr1.Findings, Finding{Kind: "test"})
	if len(sr2.Findings) != 0 {
		t.Error("modifying one ScanResult's Findings affected another instance")
	}
}

func TestCleanResult_RoundTrip(t *testing.T) {
	cr := NewCleanResult()
	cr.Text = "cleaned"
	cr.OriginalText = "original"
	cr.Changes = []Change{{Kind: "normalized", Detail: "NFC applied"}}
	offset := 5
	cr.Findings = []Finding{{
		Kind:     "invisible",
		Severity: "medium",
		Detail:   "zero-width space",
		Offset:   &offset,
		Context:  &FindingContext{Excerpt: "hello\u200bworld"},
	}}

	data, err := json.Marshal(cr)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var cr2 CleanResult
	if err := json.Unmarshal(data, &cr2); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if cr2.Text != cr.Text {
		t.Errorf("round-trip Text = %q, want %q", cr2.Text, cr.Text)
	}
	if len(cr2.Changes) != 1 || cr2.Changes[0].Kind != "normalized" {
		t.Errorf("round-trip Changes mismatch: %+v", cr2.Changes)
	}
	if len(cr2.Findings) != 1 || cr2.Findings[0].Kind != "invisible" {
		t.Errorf("round-trip Findings mismatch: %+v", cr2.Findings)
	}
	if cr2.Findings[0].Context == nil || cr2.Findings[0].Context.Excerpt != "hello\u200bworld" {
		t.Error("round-trip FindingContext mismatch")
	}
}

func TestPresetNames(t *testing.T) {
	names := PresetNames()
	if len(names) != 3 {
		t.Fatalf("PresetNames() returned %d names, want 3", len(names))
	}
	// Should be sorted
	expected := []string{"ascii", "default", "strict"}
	for i, name := range names {
		if name != expected[i] {
			t.Errorf("PresetNames()[%d] = %q, want %q", i, name, expected[i])
		}
	}
}

func TestPresetConstants(t *testing.T) {
	// Verify all presets exist via GetPreset
	for _, name := range []PresetName{PresetDefault, PresetStrict, PresetASCII} {
		if _, ok := GetPreset(name); !ok {
			t.Errorf("GetPreset(%q) not found", name)
		}
	}

	// Verify specific preset values
	def, _ := GetPreset(PresetDefault)
	if def.NormalizationForm != NormNFC {
		t.Errorf("default preset normalization = %q, want NFC", def.NormalizationForm)
	}
	if def.DecodeOnClean {
		t.Error("default preset DecodeOnClean should be false")
	}
	if def.StripInvisible {
		t.Error("default preset StripInvisible should be false")
	}
	if !def.StripTagChars {
		t.Error("default preset StripTagChars should be true")
	}
	if !def.CollapseWhitespace {
		t.Error("default preset CollapseWhitespace should be true")
	}
	if def.MaxCombiningMarks == nil || *def.MaxCombiningMarks != charclass.DefaultCombiningMarkCap {
		t.Errorf("default preset MaxCombiningMarks = %v, want %d", def.MaxCombiningMarks, charclass.DefaultCombiningMarkCap)
	}

	strict, _ := GetPreset(PresetStrict)
	if strict.NormalizationForm != NormNFKC {
		t.Errorf("strict preset normalization = %q, want NFKC", strict.NormalizationForm)
	}
	if !strict.DecodeOnClean {
		t.Error("strict preset DecodeOnClean should be true")
	}
	if !strict.StripInvisible {
		t.Error("strict preset StripInvisible should be true")
	}
	if !strict.StripANSI {
		t.Error("strict preset StripANSI should be true")
	}

	ascii, _ := GetPreset(PresetASCII)
	if !ascii.ASCIITransliterate {
		t.Error("ascii preset ASCIITransliterate should be true")
	}
	if ascii.NormalizationForm != NormNFKC {
		t.Errorf("ascii preset normalization = %q, want NFKC", ascii.NormalizationForm)
	}
}
