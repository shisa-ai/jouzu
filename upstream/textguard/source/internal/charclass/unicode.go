// Modified for deterministic Unicode conformance and bounded native scanning.
package charclass

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

func Letter(r rune) bool    { return unicode.Is(pythonLetters, r) }
func Number(r rune) bool    { return unicode.Is(pythonNumbers, r) }
func Assigned(r rune) bool  { return unicode.Is(pythonAssigned, r) }
func Printable(r rune) bool { return unicode.Is(pythonPrintable, r) }

// LowerForSignals preserves Python's dotted-I expansion before searching for
// ASCII signal words. Simple Unicode lowercasing would turn İ into a bare i.
func LowerForSignals(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i\u0307"))
}

// PythonSpace includes the four information separators accepted by str.isspace.
func PythonSpace(r rune) bool { return unicode.IsSpace(r) || r >= 0x1c && r <= 0x1f }

// PythonWhitespaceClass is the Unicode 15 whitespace set used by Python regexes.
const PythonWhitespaceClass = `\t-\r\x{001c}-\x{0020}\x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}`

// CombiningClass reports the canonical combining class, not the mark category.
func CombiningClass(r rune) uint8 {
	if r < 0x300 || !Assigned(r) {
		return 0
	}
	return norm.NFD.PropertiesString(string(r)).CCC()
}

// ReplaceInvalidUTF8 uses one replacement per ill-formed subsequence, matching
// Python's UTF-8 errors="replace" decoder (including truncated prefixes).
func ReplaceInvalidUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n == 1 {
			lead := s[i]
			want := 0
			switch {
			case lead >= 0xc2 && lead <= 0xdf:
				want = 2
			case lead >= 0xe0 && lead <= 0xef:
				want = 3
			case lead >= 0xf0 && lead <= 0xf4:
				want = 4
			}
			for n < want && i+n < len(s) {
				b := s[i+n]
				if b < 0x80 || b > 0xbf {
					break
				}
				if n == 1 && (lead == 0xe0 && b < 0xa0 || lead == 0xed && b > 0x9f || lead == 0xf0 && b < 0x90 || lead == 0xf4 && b > 0x8f) {
					break
				}
				n++
			}
		}
		out.WriteRune(r)
		i += n
	}
	return out.String()
}
