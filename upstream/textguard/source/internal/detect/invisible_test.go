package detect

import (
	"strings"
	"testing"
)

// --------------------------------------------------------------------------
// DetectInvisibleText — tests ported from Python test_detectors.py
// --------------------------------------------------------------------------

func TestDetectInvisibleText_ExpectedSeverities(t *testing.T) {
	// Python: test_invisible_detector_assigns_expected_severities
	// "safe\u202eevil\u202c \u00ad\U000E0041"
	// \u202E = RLO (bidi), \u202C = PDF (bidi), \u00AD = soft hyphen, \U000E0041 = tag char
	text := "safe\u202eevil\u202c \u00ad\U000E0041"
	findings := DetectInvisibleText(text, false)

	severities := make(map[string]string)
	for _, f := range findings {
		severities[f.Kind] = f.Severity
	}

	if sev, ok := severities["bidi_control"]; !ok {
		t.Error("expected bidi_control finding")
	} else if sev != "error" {
		t.Errorf("bidi_control severity: got %q, want %q", sev, "error")
	}

	if sev, ok := severities["soft_hyphen"]; !ok {
		t.Error("expected soft_hyphen finding")
	} else if sev != "warn" {
		t.Errorf("soft_hyphen severity: got %q, want %q", sev, "warn")
	}

	if sev, ok := severities["tag_character"]; !ok {
		t.Error("expected tag_character finding")
	} else if sev != "error" {
		t.Errorf("tag_character severity: got %q, want %q", sev, "error")
	}
}

func TestDetectInvisibleText_ANSIEscape(t *testing.T) {
	// Python: second part of test_invisible_detector_assigns_expected_severities
	findings := DetectInvisibleText("\x1b[31mred\x1b[0m", false)
	found := false
	for _, f := range findings {
		if f.Kind == "ansi_escape" && strings.Contains(f.Detail, "detected") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected ansi_escape finding with 'detected' in detail")
	}
}

func TestDetectInvisibleText_MathOperatorsAndDeprecatedFormatting(t *testing.T) {
	// Python: test_invisible_math_operators_and_deprecated_formatting_are_detected
	// U+2062 INVISIBLE TIMES — invisible math operator
	findings := DetectInvisibleText("A\u2062B", false)
	found := false
	for _, f := range findings {
		if f.Kind == "invisible_char" && strings.Contains(f.Codepoint, "U+2062") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected invisible_char finding with U+2062 codepoint")
	}

	// U+206A INHIBIT SYMMETRIC SWAPPING — deprecated but valid
	findings = DetectInvisibleText("text\u206Amore", false)
	found = false
	for _, f := range findings {
		if f.Kind == "invisible_char" && strings.Contains(f.Codepoint, "U+206A") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected invisible_char finding with U+206A codepoint")
	}
}

func TestDetectInvisibleText_InvisibleCharCodepoint(t *testing.T) {
	// ZERO WIDTH SPACE (U+200B) — should be detected as invisible_char
	findings := DetectInvisibleText("hello\u200Bworld", false)
	found := false
	for _, f := range findings {
		if f.Kind == "invisible_char" && strings.Contains(f.Codepoint, "U+200B") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected invisible_char finding with U+200B")
	}
}

func TestDetectInvisibleText_VariationSelector(t *testing.T) {
	// VS1 (U+FE00) — variation selector
	findings := DetectInvisibleText("text\uFE00end", false)
	found := false
	for _, f := range findings {
		if f.Kind == "variation_selector" && strings.Contains(f.Codepoint, "U+FE00") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected variation_selector finding with U+FE00")
	}
}

func TestDetectInvisibleText_CombiningAbuse(t *testing.T) {
	// 4 consecutive combining marks (default cap is 3) — the 4th should be flagged
	// U+0300 = COMBINING GRAVE ACCENT
	text := "a\u0300\u0301\u0302\u0303"
	findings := DetectInvisibleText(text, false)
	found := false
	for _, f := range findings {
		if f.Kind == "combining_abuse" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected combining_abuse finding for 4 consecutive combining marks")
	}
}

func TestDetectInvisibleText_NoCombiningAbuseUnderCap(t *testing.T) {
	// Exactly 3 combining marks (at default cap 3) — should NOT be flagged
	// U+0300, U+0301, U+0302
	text := "a\u0300\u0301\u0302"
	findings := DetectInvisibleText(text, false)
	for _, f := range findings {
		if f.Kind == "combining_abuse" {
			t.Error("should not flag combining_abuse when combining marks <= cap")
		}
	}
}

func TestDetectInvisibleText_InDecodedText(t *testing.T) {
	// When in_decoded_text=true, offsets should be nil and detail includes "in decoded text"
	text := "safe\u202eevil"
	findings := DetectInvisibleText(text, true)

	if len(findings) == 0 {
		t.Fatal("expected findings for bidi control in decoded text")
	}

	for _, f := range findings {
		if f.Offset != nil {
			t.Errorf("expected nil offset in decoded text mode for kind=%s, got %d", f.Kind, *f.Offset)
		}
		if !strings.Contains(f.Detail, "in decoded text") {
			t.Errorf("detail should include 'in decoded text' for kind=%s, got: %s", f.Kind, f.Detail)
		}
	}
}

func TestDetectInvisibleText_OffsetsAreCharacterBased(t *testing.T) {
	// Offsets should be character (rune) positions, not byte positions
	// "x" + U+200B (3 bytes in UTF-8) + "y"
	text := "x\u200By"
	findings := DetectInvisibleText(text, false)

	found := false
	for _, f := range findings {
		if f.Kind == "invisible_char" && f.Offset != nil {
			if *f.Offset != 1 {
				t.Errorf("expected rune offset 1, got %d", *f.Offset)
			}
			found = true
		}
	}
	if !found {
		t.Error("expected invisible_char finding")
	}
}

func TestDetectInvisibleText_ANSIOffsets(t *testing.T) {
	// ANSI escape at start has offset 0
	text := "\x1b[31mred"
	findings := DetectInvisibleText(text, false)
	found := false
	for _, f := range findings {
		if f.Kind == "ansi_escape" && f.Offset != nil && *f.Offset == 0 {
			found = true
		}
	}
	if !found {
		t.Error("expected ansi_escape finding with offset 0")
	}
}

func TestDetectInvisibleText_EmptyString(t *testing.T) {
	findings := DetectInvisibleText("", false)
	if len(findings) != 0 {
		t.Errorf("expected 0 findings for empty string, got %d", len(findings))
	}
}

func TestDetectInvisibleText_SafeString(t *testing.T) {
	findings := DetectInvisibleText("hello world", false)
	if len(findings) != 0 {
		t.Errorf("expected 0 findings for safe string, got %d", len(findings))
	}
}

func TestDetectInvisibleText_NonNilSlice(t *testing.T) {
	// Even with no findings, the result should be non-nil empty slice
	findings := DetectInvisibleText("hello", false)
	if findings == nil {
		t.Error("expected non-nil empty slice, got nil")
	}
}

func TestDetectInvisibleText_MultipleFindings(t *testing.T) {
	// Text with multiple invisible chars
	text := "\u200B\u200C\u200D"
	findings := DetectInvisibleText(text, false)
	count := 0
	for _, f := range findings {
		if f.Kind == "invisible_char" {
			count++
		}
	}
	if count != 3 {
		t.Errorf("expected 3 invisible_char findings, got %d", count)
	}
}

func TestDetectInvisibleText_DetailFormat(t *testing.T) {
	// Verify detail format: "Kind Name U+XXXX"
	findings := DetectInvisibleText("\u200B", false)
	if len(findings) == 0 {
		t.Fatal("expected findings")
	}
	f := findings[0]
	if f.Kind != "invisible_char" {
		t.Errorf("expected kind invisible_char, got %s", f.Kind)
	}
	if f.Detail != "Invisible Char U+200B" {
		t.Errorf("unexpected detail format: %s", f.Detail)
	}
	if f.Codepoint != "U+200B" {
		t.Errorf("expected codepoint U+200B, got %s", f.Codepoint)
	}
}

func TestDetectInvisibleText_BidiDetail(t *testing.T) {
	// Bidi control detail
	findings := DetectInvisibleText("\u202E", false)
	if len(findings) == 0 {
		t.Fatal("expected findings")
	}
	f := findings[0]
	if f.Kind != "bidi_control" {
		t.Errorf("expected kind bidi_control, got %s", f.Kind)
	}
	if f.Detail != "Bidi Control U+202E" {
		t.Errorf("unexpected detail: %s", f.Detail)
	}
}

func TestDetectInvisibleText_TagCharDetail(t *testing.T) {
	findings := DetectInvisibleText("\U000E0041", false)
	if len(findings) == 0 {
		t.Fatal("expected findings")
	}
	f := findings[0]
	if f.Kind != "tag_character" {
		t.Errorf("expected kind tag_character, got %s", f.Kind)
	}
	// U+E0041 > 0xFFFF so 6 digits
	if f.Codepoint != "U+0E0041" {
		t.Errorf("expected codepoint U+0E0041, got %s", f.Codepoint)
	}
}

func TestDetectInvisibleText_SoftHyphenDetail(t *testing.T) {
	findings := DetectInvisibleText("\u00AD", false)
	if len(findings) == 0 {
		t.Fatal("expected findings")
	}
	f := findings[0]
	if f.Kind != "soft_hyphen" {
		t.Errorf("expected kind soft_hyphen, got %s", f.Kind)
	}
	if f.Detail != "Soft Hyphen U+00AD" {
		t.Errorf("unexpected detail: %s", f.Detail)
	}
}

func TestDetectInvisibleText_VariationSelectorSupplemental(t *testing.T) {
	// Test supplemental variation selector (U+E0100, in SMP)
	text := "a\U000E0100b"
	findings := DetectInvisibleText(text, false)
	found := false
	for _, f := range findings {
		if f.Kind == "variation_selector" && strings.Contains(f.Codepoint, "U+0E0100") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected variation_selector finding for U+E0100")
	}
}

func TestDetectInvisibleText_CombiningAbuseDetail(t *testing.T) {
	// Check combining abuse detail message
	text := "a\u0300\u0301\u0302\u0303"
	findings := DetectInvisibleText(text, false)
	found := false
	for _, f := range findings {
		if f.Kind == "combining_abuse" {
			if !strings.Contains(f.Detail, "Combining mark cap exceeded") {
				t.Errorf("unexpected detail: %s", f.Detail)
			}
			if !strings.Contains(f.Detail, "3") {
				t.Errorf("detail should mention cap value 3: %s", f.Detail)
			}
			found = true
			break
		}
	}
	if !found {
		t.Error("expected combining_abuse finding")
	}
}

func TestDetectInvisibleText_CombiningAbuseInDecodedText(t *testing.T) {
	text := "a\u0300\u0301\u0302\u0303"
	findings := DetectInvisibleText(text, true)
	found := false
	for _, f := range findings {
		if f.Kind == "combining_abuse" {
			if f.Offset != nil {
				t.Errorf("expected nil offset in decoded text mode, got %d", *f.Offset)
			}
			if !strings.Contains(f.Detail, "in decoded text") {
				t.Errorf("detail should mention 'in decoded text': %s", f.Detail)
			}
			found = true
			break
		}
	}
	if !found {
		t.Error("expected combining_abuse finding in decoded text mode")
	}
}

func TestDetectInvisibleText_CombiningAbuseResetOnNonCombining(t *testing.T) {
	// 3 combining marks, then a base char, then 3 more — should NOT flag
	text := "a\u0300\u0301\u0302b\u0300\u0301\u0302"
	findings := DetectInvisibleText(text, false)
	for _, f := range findings {
		if f.Kind == "combining_abuse" {
			t.Error("should not flag combining_abuse when runs are <= cap")
		}
	}
}

func TestDetectInvisibleText_AllCategoriesTogether(t *testing.T) {
	// Test text with all categories present
	// invisible (U+200B) + bidi (U+202E) + tag (U+E0041) + variation selector (U+FE00) + soft hyphen (U+00AD)
	text := "a\u200B\u202E\U000E0041\uFE00\u00ADb"
	findings := DetectInvisibleText(text, false)

	kinds := make(map[string]bool)
	for _, f := range findings {
		kinds[f.Kind] = true
	}

	expected := []string{"invisible_char", "bidi_control", "tag_character", "variation_selector", "soft_hyphen"}
	for _, k := range expected {
		if !kinds[k] {
			t.Errorf("expected finding kind %q", k)
		}
	}
}
