package normalize

import (
	"testing"

	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
	"github.com/shisa-ai/textguard-go/internal/charclass"
)

// findingKinds returns a set of unique kinds from a slice of findings.
func findingKinds(findings []textguard.Finding) map[string]bool {
	kinds := make(map[string]bool, len(findings))
	for _, f := range findings {
		kinds[f.Kind] = true
	}
	return kinds
}

func TestNormalizePreservesBenignMultilingualText(t *testing.T) {
	samples := []string{
		"こんにちは 世界",
		"مرحبا بالعالم",
		"سلام دنیا",
	}

	for _, sample := range samples {
		normalized, findings := NormalizeText(sample)
		if normalized != sample {
			t.Errorf("NormalizeText(%q) = %q, want %q", sample, normalized, sample)
		}
		if len(findings) != 0 {
			t.Errorf("NormalizeText(%q) produced %d findings, want 0", sample, len(findings))
		}
	}
}

func TestNormalizeStripsInvisibleAndBidiControls(t *testing.T) {
	normalized, findings := NormalizeText(
		"hello\u200b\u202eworld\u202c",
		WithStripInvisible(true),
		WithStripBidi(true),
	)

	if normalized != "helloworld" {
		t.Errorf("got %q, want %q", normalized, "helloworld")
	}

	kinds := findingKinds(findings)
	if !kinds["bidi_control"] {
		t.Error("expected bidi_control finding")
	}
	if !kinds["invisible_char"] {
		t.Error("expected invisible_char finding")
	}
}

func TestNormalizeStripsTagSoftHyphenAndVariationSelector(t *testing.T) {
	raw := "A\U000E0041\u00adB\ufe0f"
	normalized, findings := NormalizeText(
		raw,
		WithStripTagChars(true),
		WithStripSoftHyphens(true),
		WithStripVariationSelectors(true),
	)

	if normalized != "AB" {
		t.Errorf("got %q, want %q", normalized, "AB")
	}

	kinds := findingKinds(findings)
	want := map[string]bool{
		"soft_hyphen":        true,
		"tag_character":      true,
		"variation_selector": true,
	}
	for k := range want {
		if !kinds[k] {
			t.Errorf("expected %s finding", k)
		}
	}
	if len(kinds) != len(want) {
		t.Errorf("got %d finding kinds, want %d", len(kinds), len(want))
	}
}

func TestNormalizeStripsANSIAndCollapsesWhitespace(t *testing.T) {
	raw := "\x1b[31mred\x1b[0m\t value\n\nnext"
	normalized, findings := NormalizeText(
		raw,
		WithStripANSI(true),
		WithCollapseWhitespace(true),
	)

	if normalized != "red value next" {
		t.Errorf("got %q, want %q", normalized, "red value next")
	}
	if len(findings) == 0 {
		t.Fatal("expected at least one finding")
	}
	if findings[0].Kind != "ansi_escape" {
		t.Errorf("first finding kind = %q, want %q", findings[0].Kind, "ansi_escape")
	}
}

func TestNormalizeCapsCombiningMarks(t *testing.T) {
	cap := charclass.DefaultCombiningMarkCap
	// Build string: "q" + (cap+2) combining acute accents
	raw := "q"
	for i := 0; i < cap+2; i++ {
		raw += "\u0301"
	}

	normalized, findings := NormalizeText(
		raw,
		WithMaxCombiningMarks(&cap),
	)

	// Expect "q" + exactly cap combining marks
	want := "q"
	for i := 0; i < cap; i++ {
		want += "\u0301"
	}
	if normalized != want {
		t.Errorf("got %q, want %q", normalized, want)
	}

	if len(findings) != 2 {
		t.Fatalf("got %d findings, want 2", len(findings))
	}
	for _, f := range findings {
		if f.Kind != "combining_abuse" {
			t.Errorf("finding kind = %q, want %q", f.Kind, "combining_abuse")
		}
	}
}

func TestStripNonASCIIIsLossyAndExplicit(t *testing.T) {
	raw := "\uFF21\uFF22\uFF23 caf\u00e9 東京"
	got := StripNonASCII(raw)
	want := "ABC cafe "
	if got != want {
		t.Errorf("StripNonASCII(%q) = %q, want %q", raw, got, want)
	}
}

// Additional edge case tests

func TestNormalizeEmptyString(t *testing.T) {
	normalized, findings := NormalizeText("")
	if normalized != "" {
		t.Errorf("got %q, want empty string", normalized)
	}
	if len(findings) != 0 {
		t.Errorf("got %d findings, want 0", len(findings))
	}
}

func TestNormalizePlainASCII(t *testing.T) {
	text := "Hello, world!"
	normalized, findings := NormalizeText(text)
	if normalized != text {
		t.Errorf("got %q, want %q", normalized, text)
	}
	if len(findings) != 0 {
		t.Errorf("got %d findings, want 0", len(findings))
	}
}

func TestNormalizeFromPreset(t *testing.T) {
	preset, ok := textguard.GetPreset(textguard.PresetStrict)
	if !ok {
		t.Fatal("strict preset not found")
	}

	// strict preset: strip everything, NFKC form
	raw := "hello\u200b\u202eworld\u202c"
	normalized, findings := NormalizeText(raw, FromPreset(preset))
	if normalized != "helloworld" {
		t.Errorf("got %q, want %q", normalized, "helloworld")
	}
	if len(findings) == 0 {
		t.Error("expected findings from strict preset")
	}
}

func TestNormalizeWithNFKC(t *testing.T) {
	// U+2126 OHM SIGN normalizes to U+03A9 GREEK CAPITAL LETTER OMEGA under NFKC
	raw := "\u2126"
	normalized, findings := NormalizeText(raw, WithNormForm(textguard.NormNFKC))
	if normalized != "\u03A9" {
		t.Errorf("NFKC normalization: got %q (U+%04X), want U+03A9", normalized, []rune(normalized)[0])
	}
	if len(findings) != 0 {
		t.Errorf("got %d findings, want 0", len(findings))
	}
}

func TestNormalizeInvalidFormPanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Error("expected panic for invalid normalization form")
		}
	}()
	NormalizeText("test", WithNormForm("NFD"))
}

func TestStripNonASCIIEmpty(t *testing.T) {
	got := StripNonASCII("")
	if got != "" {
		t.Errorf("StripNonASCII empty: got %q, want empty", got)
	}
}

func TestNormalizeFindingsHaveOffsets(t *testing.T) {
	// Check that findings carry offset information
	normalized, findings := NormalizeText(
		"a\u200bb",
		WithStripInvisible(true),
	)
	if normalized != "ab" {
		t.Errorf("got %q, want %q", normalized, "ab")
	}
	if len(findings) != 1 {
		t.Fatalf("got %d findings, want 1", len(findings))
	}
	if findings[0].Offset == nil {
		t.Error("expected non-nil offset")
	} else if *findings[0].Offset != 1 {
		t.Errorf("offset = %d, want 1", *findings[0].Offset)
	}
	if findings[0].Codepoint != "U+200B" {
		t.Errorf("codepoint = %q, want %q", findings[0].Codepoint, "U+200B")
	}
}

func TestNormalizeANSIFindingsHaveOffsets(t *testing.T) {
	raw := "pre\x1b[31mred"
	_, findings := NormalizeText(raw, WithStripANSI(true))
	if len(findings) != 1 {
		t.Fatalf("got %d findings, want 1", len(findings))
	}
	if findings[0].Offset == nil {
		t.Fatal("expected non-nil offset")
	}
	if *findings[0].Offset != 3 {
		t.Errorf("ANSI offset = %d, want 3", *findings[0].Offset)
	}
}
