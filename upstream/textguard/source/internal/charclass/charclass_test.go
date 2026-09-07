package charclass

import (
	"testing"
)

func TestDefaultCombiningMarkCap(t *testing.T) {
	if DefaultCombiningMarkCap != 3 {
		t.Errorf("DefaultCombiningMarkCap = %d, want 3", DefaultCombiningMarkCap)
	}
}

func TestSoftHyphen(t *testing.T) {
	if SoftHyphen != 0x00AD {
		t.Errorf("SoftHyphen = %#x, want 0x00AD", SoftHyphen)
	}
}

func TestInvisibleCodepoints(t *testing.T) {
	// Test known invisible codepoints
	knownInvisible := []rune{
		0x034F, // COMBINING GRAPHEME JOINER
		0x200B, // ZERO WIDTH SPACE
		0x200C, // ZERO WIDTH NON-JOINER
		0x200D, // ZERO WIDTH JOINER
		0x2060, // WORD JOINER
		0xFEFF, // BOM
		0x061C, // ARABIC LETTER MARK
		0x180E, // MONGOLIAN VOWEL SEPARATOR
	}
	for _, cp := range knownInvisible {
		if !IsInvisible(cp) {
			t.Errorf("IsInvisible(%#x) = false, want true", cp)
		}
	}

	// Test known non-invisible codepoints
	knownNonInvisible := []rune{
		'A',
		' ',
		0x202A, // This is bidi, not invisible
		0x00AD, // Soft hyphen (separate category)
	}
	for _, cp := range knownNonInvisible {
		if IsInvisible(cp) {
			t.Errorf("IsInvisible(%#x) = true, want false", cp)
		}
	}

	// Verify total count matches Python set
	if len(InvisibleCodepoints) != 19 {
		t.Errorf("len(InvisibleCodepoints) = %d, want 19", len(InvisibleCodepoints))
	}
}

func TestBidiCodepoints(t *testing.T) {
	// Test known bidi codepoints
	knownBidi := []rune{
		0x202A, // LEFT-TO-RIGHT EMBEDDING
		0x202B, // RIGHT-TO-LEFT EMBEDDING
		0x202C, // POP DIRECTIONAL FORMATTING
		0x202D, // LEFT-TO-RIGHT OVERRIDE
		0x202E, // RIGHT-TO-LEFT OVERRIDE
		0x2066, // LEFT-TO-RIGHT ISOLATE
		0x2067, // RIGHT-TO-LEFT ISOLATE
		0x2068, // FIRST STRONG ISOLATE
		0x2069, // POP DIRECTIONAL ISOLATE
	}
	for _, cp := range knownBidi {
		if !IsBidi(cp) {
			t.Errorf("IsBidi(%#x) = false, want true", cp)
		}
	}

	// Test non-bidi
	if IsBidi('A') {
		t.Error("IsBidi('A') = true, want false")
	}
	if IsBidi(0x200B) {
		t.Error("IsBidi(0x200B) = true, want false (invisible, not bidi)")
	}

	// Python: set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A))
	// range(0x202A, 0x202F) = 5 elements, range(0x2066, 0x206A) = 4 elements = 9 total
	if len(BidiCodepoints) != 9 {
		t.Errorf("len(BidiCodepoints) = %d, want 9", len(BidiCodepoints))
	}
}

func TestTagCharacter(t *testing.T) {
	// Tag characters: U+E0000..U+E007F
	if !IsTagCharacter(0xE0000) {
		t.Error("IsTagCharacter(0xE0000) = false, want true")
	}
	if !IsTagCharacter(0xE007F) {
		t.Error("IsTagCharacter(0xE007F) = false, want true")
	}
	if !IsTagCharacter(0xE0041) {
		t.Error("IsTagCharacter(0xE0041) = false, want true")
	}
	if IsTagCharacter(0xE0080) {
		t.Error("IsTagCharacter(0xE0080) = true, want false (just past range)")
	}
	if IsTagCharacter('A') {
		t.Error("IsTagCharacter('A') = true, want false")
	}
}

func TestVariationSelector(t *testing.T) {
	// VS1-VS16: U+FE00..U+FE0F
	if !IsVariationSelector(0xFE00) {
		t.Error("IsVariationSelector(0xFE00) = false, want true")
	}
	if !IsVariationSelector(0xFE0F) {
		t.Error("IsVariationSelector(0xFE0F) = false, want true")
	}
	if IsVariationSelector(0xFE10) {
		t.Error("IsVariationSelector(0xFE10) = true, want false")
	}

	// VS17-VS256: U+E0100..U+E01EF
	if !IsVariationSelector(0xE0100) {
		t.Error("IsVariationSelector(0xE0100) = false, want true")
	}
	if !IsVariationSelector(0xE01EF) {
		t.Error("IsVariationSelector(0xE01EF) = false, want true")
	}
	if IsVariationSelector(0xE01F0) {
		t.Error("IsVariationSelector(0xE01F0) = true, want false")
	}
	if IsVariationSelector('A') {
		t.Error("IsVariationSelector('A') = true, want false")
	}
}

func TestSoftHyphenClassification(t *testing.T) {
	if !IsSoftHyphen(0x00AD) {
		t.Error("IsSoftHyphen(0x00AD) = false, want true")
	}
	if IsSoftHyphen('-') {
		t.Error("IsSoftHyphen('-') = true, want false")
	}
	if IsSoftHyphen(0) {
		t.Error("IsSoftHyphen(0) = true, want false")
	}
}

func TestANSIEscapeRE(t *testing.T) {
	// Should match ANSI escape sequences
	tests := []struct {
		input string
		match bool
	}{
		{"\x1B[31m", true},     // Red color
		{"\x1B[0m", true},      // Reset
		{"\x1B[1;32m", true},   // Bold green
		{"\x1B[38;5;196m", true}, // 256-color
		{"hello", false},
		{"", false},
	}
	for _, tt := range tests {
		got := ANSIEscapeRE.MatchString(tt.input)
		if got != tt.match {
			t.Errorf("ANSIEscapeRE.MatchString(%q) = %v, want %v", tt.input, got, tt.match)
		}
	}

	// Should find all matches in a string with multiple sequences
	s := "\x1B[31mhello\x1B[0m world"
	matches := ANSIEscapeRE.FindAllString(s, -1)
	if len(matches) != 2 {
		t.Errorf("found %d ANSI matches in %q, want 2", len(matches), s)
	}
}

func TestClassificationMutualExclusion(t *testing.T) {
	// Verify that classification categories don't overlap
	// Invisible codepoints should not be bidi
	for cp := range InvisibleCodepoints {
		if IsBidi(cp) {
			t.Errorf("codepoint %#x is both invisible and bidi", cp)
		}
	}
	// Bidi codepoints should not be invisible
	for cp := range BidiCodepoints {
		if IsInvisible(cp) {
			t.Errorf("codepoint %#x is both bidi and invisible", cp)
		}
	}
}
