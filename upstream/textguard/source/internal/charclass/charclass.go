// Modified for deterministic Unicode conformance and bounded native scanning.
// Package charclass provides shared Unicode codepoint classification functions,
// constants, and the ANSI escape regex used across the textguard library.
package charclass

import (
	"fmt"
	"regexp"
	"unicode/utf8"
)

// DefaultCombiningMarkCap is the default maximum number of consecutive
// combining marks allowed before flagging combining abuse.
const DefaultCombiningMarkCap = 3

// SoftHyphen is the Unicode soft hyphen codepoint.
const SoftHyphen = 0x00AD

// ANSIEscapeRE matches ANSI escape sequences (CSI sequences).
var ANSIEscapeRE = regexp.MustCompile(`\x1B\[[0-?]*[ -/]*[@-~]`)

// InvisibleCodepoints contains Unicode codepoints classified as invisible characters.
var InvisibleCodepoints = map[rune]bool{
	0x034F: true, // COMBINING GRAPHEME JOINER
	0x061C: true, // ARABIC LETTER MARK
	0x180E: true, // MONGOLIAN VOWEL SEPARATOR
	0x200B: true, // ZERO WIDTH SPACE
	0x200C: true, // ZERO WIDTH NON-JOINER
	0x200D: true, // ZERO WIDTH JOINER
	0x2060: true, // WORD JOINER
	0x2061: true, // FUNCTION APPLICATION
	0x2062: true, // INVISIBLE TIMES
	0x2063: true, // INVISIBLE SEPARATOR
	0x2064: true, // INVISIBLE PLUS
	0x2065: true, // <reserved>
	0x206A: true, // INHIBIT SYMMETRIC SWAPPING (deprecated)
	0x206B: true, // ACTIVATE SYMMETRIC SWAPPING (deprecated)
	0x206C: true, // INHIBIT ARABIC FORM SHAPING (deprecated)
	0x206D: true, // ACTIVATE ARABIC FORM SHAPING (deprecated)
	0x206E: true, // NATIONAL DIGIT SHAPES (deprecated)
	0x206F: true, // NOMINAL DIGIT SHAPES (deprecated)
	0xFEFF: true, // ZERO WIDTH NO-BREAK SPACE / BOM
}

// BidiCodepoints contains Unicode bidi control codepoints.
// Range 0x202A-0x202E plus 0x2066-0x2069.
var BidiCodepoints = map[rune]bool{
	0x202A: true, // LEFT-TO-RIGHT EMBEDDING
	0x202B: true, // RIGHT-TO-LEFT EMBEDDING
	0x202C: true, // POP DIRECTIONAL FORMATTING
	0x202D: true, // LEFT-TO-RIGHT OVERRIDE
	0x202E: true, // RIGHT-TO-LEFT OVERRIDE
	0x2066: true, // LEFT-TO-RIGHT ISOLATE
	0x2067: true, // RIGHT-TO-LEFT ISOLATE
	0x2068: true, // FIRST STRONG ISOLATE
	0x2069: true, // POP DIRECTIONAL ISOLATE
}

// IsTagCharacter returns true if the codepoint is a Unicode tag character (U+E0000..U+E007F).
func IsTagCharacter(r rune) bool {
	return r >= 0xE0000 && r <= 0xE007F
}

// IsVariationSelector returns true if the codepoint is a variation selector.
// VS1-VS16 (U+FE00..U+FE0F) plus VS17-VS256 (U+E0100..U+E01EF).
func IsVariationSelector(r rune) bool {
	return (r >= 0xFE00 && r <= 0xFE0F) || (r >= 0xE0100 && r <= 0xE01EF)
}

// IsInvisible returns true if the rune is in the invisible codepoints set.
func IsInvisible(r rune) bool {
	return InvisibleCodepoints[r]
}

// IsBidi returns true if the rune is a bidi control character.
func IsBidi(r rune) bool {
	return BidiCodepoints[r]
}

// IsSoftHyphen returns true if the rune is a soft hyphen.
func IsSoftHyphen(r rune) bool {
	return r == SoftHyphen
}

// ByteOffsetToRuneOffset converts a byte offset to a rune (character) offset.
// For a single conversion this is fine; for multiple conversions on the same
// text, use NewByteToRuneTable for O(1) lookups.
func ByteOffsetToRuneOffset(text string, byteOff int) int {
	return utf8.RuneCountInString(text[:byteOff])
}

// ByteToRuneTable is a pre-computed lookup table that maps byte offsets to
// rune (character) offsets in O(1). Built once in O(n), each lookup is O(1).
type ByteToRuneTable []int

// NewByteToRuneTable builds a lookup table for the given text. The table has
// len(text)+1 entries so that byte offset == len(text) is valid and returns
// the total rune count.
func NewByteToRuneTable(text string) ByteToRuneTable {
	table := make([]int, len(text)+1)
	runeIdx := 0
	for i := 0; i < len(text); {
		// Invalid UTF-8 consumes one byte, not the three-byte encoding of RuneError.
		_, size := utf8.DecodeRuneInString(text[i:])
		for j := 0; j < size; j++ {
			table[i+j] = runeIdx
		}
		i += size
		runeIdx++
	}
	table[len(text)] = runeIdx
	return table
}

// RuneOffset returns the rune offset for the given byte offset.
func (t ByteToRuneTable) RuneOffset(byteOff int) int {
	return t[byteOff]
}

// FormatCodepoint formats a rune as "U+XXXX" (4 hex digits) or "U+XXXXXX"
// (6 hex digits for codepoints above U+FFFF).
func FormatCodepoint(r rune) string {
	if r > 0xFFFF {
		return fmt.Sprintf("U+%06X", r)
	}
	return fmt.Sprintf("U+%04X", r)
}

// KindToTitle converts an underscore-separated kind string to title case.
// E.g., "invisible_char" -> "Invisible Char".
func KindToTitle(kind string) string {
	result := make([]byte, 0, len(kind))
	capitalizeNext := true
	for i := 0; i < len(kind); i++ {
		c := kind[i]
		if c == '_' {
			result = append(result, ' ')
			capitalizeNext = true
		} else {
			if capitalizeNext && c >= 'a' && c <= 'z' {
				result = append(result, c-32)
			} else {
				result = append(result, c)
			}
			capitalizeNext = false
		}
	}
	return string(result)
}
