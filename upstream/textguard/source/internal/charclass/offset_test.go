// Modified for deterministic Unicode conformance and bounded native scanning.
package charclass

import (
	"testing"
	"unicode/utf8"
)

func TestByteToRuneTableMalformedUTF8(t *testing.T) {
	for _, text := range []string{"", "a日😀z", "\xff", "a\xff", "\xf0\x9f", "\xff日\xfe"} {
		t.Run(text, func(t *testing.T) { checkOffsetTable(t, text) })
	}
}

func FuzzByteToRuneTable(f *testing.F) {
	for _, text := range []string{"", "a日😀z", "\xff", "\xf0\x9f", "\xff日\xfe"} {
		f.Add(text)
	}
	f.Fuzz(func(t *testing.T, text string) { checkOffsetTable(t, text) })
}

func checkOffsetTable(t *testing.T, text string) {
	t.Helper()
	table := NewByteToRuneTable(text)
	runeIndex := 0
	for i := 0; i < len(text); {
		_, size := utf8.DecodeRuneInString(text[i:])
		for j := 0; j < size; j++ {
			if got := table.RuneOffset(i + j); got != runeIndex {
				t.Fatalf("offset %d: got %d, want %d", i+j, got, runeIndex)
			}
		}
		i += size
		runeIndex++
	}
	if got := table.RuneOffset(len(text)); got != runeIndex {
		t.Fatalf("end offset: got %d, want %d", got, runeIndex)
	}
}
