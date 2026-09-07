// Modified for deterministic Unicode conformance and bounded native scanning.
// Package yaramatch provides a pure-Go YARA rule matcher that parses simple
// .yara files and compiles string patterns to Go *regexp.Regexp.
//
// Only single-string rules with condition "$a" are supported. Unsupported
// features (multi-string conditions, hex patterns, modules, etc.) cause a
// parse error.
package yaramatch

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/shisa-ai/textguard-go/internal/data"
	textguard "github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// compiledRule holds a parsed and compiled YARA rule.
type compiledRule struct {
	name     string
	severity string
	pattern  *regexp.Regexp
}

// Matcher holds a set of compiled YARA rules and can match text against them.
type Matcher struct {
	rules []compiledRule
}

// New creates a Matcher by loading and compiling YARA rules.
//
// If bundled is true, the 13 embedded rules from internal/data are loaded.
// If rulesDir is non-empty, .yara files are loaded from that directory.
// Both may be combined. At least one source must be provided.
//
// Returns an error if no rules are found, a rule file cannot be parsed,
// or an unsupported YARA feature is used.
func New(bundled bool, rulesDir string) (*Matcher, error) {
	if !bundled && rulesDir == "" {
		return nil, fmt.Errorf("yaramatch: YARA backend is not enabled. Set bundled=true or provide a rules directory")
	}

	var rules []compiledRule

	if bundled {
		for _, rf := range data.YaraRuleFiles() {
			parsed, err := parseYaraSource(rf.Name, string(rf.Content))
			if err != nil {
				return nil, fmt.Errorf("yaramatch: bundled rule %s: %w", rf.Name, err)
			}
			rules = append(rules, parsed...)
		}
	}

	if rulesDir != "" {
		entries, err := os.ReadDir(rulesDir)
		if err != nil {
			return nil, fmt.Errorf("yaramatch: failed to read rules directory %q: %w", rulesDir, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yara") {
				continue
			}
			content, err := os.ReadFile(filepath.Join(rulesDir, entry.Name()))
			if err != nil {
				return nil, fmt.Errorf("yaramatch: failed to read rule file %s: %w", entry.Name(), err)
			}
			parsed, err := parseYaraSource(entry.Name(), string(content))
			if err != nil {
				return nil, fmt.Errorf("yaramatch: custom rule %s: %w", entry.Name(), err)
			}
			rules = append(rules, parsed...)
		}
	}

	if len(rules) == 0 {
		return nil, fmt.Errorf("yaramatch: no YARA rules were found for the configured backend")
	}

	return &Matcher{rules: rules}, nil
}

// Match runs all compiled rules against rawText and, when it differs,
// decodedText. Empty decoded text is still a candidate.
// Returns a slice of Findings (never nil).
func (m *Matcher) Match(rawText string, decodedText string) []textguard.Finding {
	return m.MatchBounded(rawText, decodedText, nil)
}

// MatchBounded reserves each matched rule before constructing its finding.
func (m *Matcher) MatchBounded(rawText string, decodedText string, budget *textguard.FindingBudget) []textguard.Finding {
	findings := m.matchOne(rawText, "raw", budget)
	if decodedText != rawText {
		findings = append(findings, m.matchOne(decodedText, "decoded", budget)...)
	}
	if findings == nil {
		findings = []textguard.Finding{}
	}
	return findings
}

// matchOne runs all rules against the given text and returns findings.
func (m *Matcher) matchOne(text string, sourceLabel string, budgets ...*textguard.FindingBudget) []textguard.Finding {
	var budget *textguard.FindingBudget
	if len(budgets) > 0 {
		budget = budgets[0]
	}
	var findings []textguard.Finding
	text = byteText(text)
	for _, r := range m.rules {
		if r.pattern.MatchString(text) {
			budget.Take()
			findings = append(findings, textguard.Finding{
				Kind:     "yara:" + r.name,
				Severity: r.severity,
				Detail:   fmt.Sprintf("Matched YARA rule %s on %s text", r.name, sourceLabel),
			})
		}
	}
	return findings
}

// parseYaraSource parses a .yara file's content and returns compiled rules.
// Only single-string rules with condition "$a" are supported.
func parseYaraSource(filename string, content string) ([]compiledRule, error) {
	var rules []compiledRule
	seen := make(map[string]bool)

	// Normalize line endings
	content = strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(content, "\n")

	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])

		// Skip blank lines and standalone comments
		if line == "" || strings.HasPrefix(line, "//") {
			i++
			continue
		}

		// Look for "rule <name> {"
		if !strings.HasPrefix(line, "rule ") {
			return nil, fmt.Errorf("%s:%d: unsupported syntax %q", filename, i+1, line)
		}

		rule, nextIdx, err := parseRule(lines, i, filename)
		if err != nil {
			return nil, err
		}
		if seen[rule.name] {
			return nil, fmt.Errorf("%s: duplicate rule %q", filename, rule.name)
		}
		seen[rule.name] = true
		rules = append(rules, rule)
		i = nextIdx
	}

	return rules, nil
}

// parseRule parses a single rule starting at line index i.
// Returns the compiled rule and the index of the line after the rule's closing brace.
func parseRule(lines []string, startIdx int, filename string) (compiledRule, int, error) {
	line := strings.TrimSpace(lines[startIdx])

	// Extract rule name from "rule <name> {" or "rule <name>{"
	name := extractRuleName(line)
	if name == "" || !regexp.MustCompile(`^rule\s+[A-Za-z_][A-Za-z0-9_]*\s*\{$`).MatchString(line) {
		return compiledRule{}, 0, fmt.Errorf("cannot parse rule name from line: %q", line)
	}

	var (
		severity    string
		patternStr  string
		patternType string // "regex" or "literal"
		regexFlags  string
		inMeta      bool
		inStrings   bool
		inCondition bool
		condText    string
		stringCount int
		closed      bool
		section     int
	)

	i := startIdx + 1
	for i < len(lines) {
		raw := lines[i]
		trimmed := strings.TrimSpace(raw)

		// End of rule
		if trimmed == "}" {
			closed = true
			i++
			break
		}

		// Section headers
		if trimmed == "meta:" {
			if section >= 1 {
				return compiledRule{}, 0, fmt.Errorf("rule %q: repeated or misplaced meta section", name)
			}
			section = 1
			inMeta = true
			inStrings = false
			inCondition = false
			i++
			continue
		}
		if trimmed == "strings:" {
			if section >= 2 {
				return compiledRule{}, 0, fmt.Errorf("rule %q: repeated or misplaced strings section", name)
			}
			section = 2
			inMeta = false
			inStrings = true
			inCondition = false
			i++
			continue
		}
		if trimmed == "condition:" {
			if section != 2 {
				return compiledRule{}, 0, fmt.Errorf("rule %q: misplaced condition section", name)
			}
			section = 3
			inMeta = false
			inStrings = false
			inCondition = true
			i++
			continue
		}

		// Skip blank lines and comments inside rule body
		if trimmed == "" || strings.HasPrefix(trimmed, "//") {
			i++
			continue
		}

		if inMeta {
			if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\s*=\s*("([^"\\]|\\.)*"|-?[0-9]+|true|false)$`).MatchString(trimmed) {
				return compiledRule{}, 0, fmt.Errorf("rule %q: unsupported metadata %q", name, trimmed)
			}
			key, val := parseMetaLine(trimmed)
			if key == "severity" {
				severity = val
			}
			i++
			continue
		}

		if inStrings {
			// Parse string definition: $a = "literal" or $a = /regex/flags
			// Also detect hex patterns: $a = { hex bytes }
			varName, pType, pStr, flags, err := parseStringLine(trimmed)
			if err != nil {
				return compiledRule{}, 0, fmt.Errorf("rule %q in %s: %w", name, filename, err)
			}
			if varName != "$a" {
				return compiledRule{}, 0, fmt.Errorf("rule %q: only string $a is supported", name)
			}
			stringCount++
			if stringCount > 1 {
				return compiledRule{}, 0, fmt.Errorf("rule %q in %s: unsupported: multiple string definitions (only single-string rules with condition: $a are supported)", name, filename)
			}
			patternType = pType
			patternStr = pStr
			regexFlags = flags
			i++
			continue
		}

		if inCondition {
			condText += " " + trimmed
			i++
			continue
		}

		return compiledRule{}, 0, fmt.Errorf("rule %q: unsupported body syntax %q", name, trimmed)
	}

	if !closed {
		return compiledRule{}, 0, fmt.Errorf("rule %q: missing closing brace", name)
	}
	// Validate condition
	condText = strings.TrimSpace(condText)
	if condText != "$a" {
		return compiledRule{}, 0, fmt.Errorf("rule %q in %s: unsupported condition %q (only \"$a\" is supported)", name, filename, condText)
	}

	if patternStr == "" {
		return compiledRule{}, 0, fmt.Errorf("rule %q in %s: no string pattern found", name, filename)
	}

	// Compile pattern
	var re *regexp.Regexp
	var err error
	switch patternType {
	case "regex":
		pat, translateErr := bytePattern(patternStr)
		if translateErr != nil {
			return compiledRule{}, 0, fmt.Errorf("rule %q: %w", name, translateErr)
		}
		if strings.Contains(regexFlags, "i") {
			pat = "(?i)" + pat
		}
		if strings.Contains(regexFlags, "s") {
			pat = "(?s)" + pat
		}
		re, err = regexp.Compile(pat)
		if err != nil {
			return compiledRule{}, 0, fmt.Errorf("rule %q in %s: failed to compile regex %q: %w", name, filename, patternStr, err)
		}
	case "literal":
		re = regexp.MustCompile(regexp.QuoteMeta(byteText(patternStr)))
	default:
		return compiledRule{}, 0, fmt.Errorf("rule %q in %s: unknown pattern type %q", name, filename, patternType)
	}

	return compiledRule{
		name:     name,
		severity: coerceSeverity(severity),
		pattern:  re,
	}, i, nil
}

// extractRuleName extracts the rule name from a line like "rule my_rule {".
func extractRuleName(line string) string {
	// Remove "rule " prefix
	rest := strings.TrimPrefix(line, "rule ")
	// Name ends at space or {
	name := ""
	for _, ch := range rest {
		if ch == ' ' || ch == '{' || ch == '\t' {
			break
		}
		name += string(ch)
	}
	return name
}

// parseMetaLine parses a meta line like `severity = "warn"` or `description = "text"`.
// Returns key and value (unquoted).
func parseMetaLine(line string) (string, string) {
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", ""
	}
	key := strings.TrimSpace(parts[0])
	val := strings.TrimSpace(parts[1])
	// Remove surrounding quotes
	val = strings.Trim(val, "\"")
	return key, val
}

// parseStringLine parses a YARA string definition line.
// Returns: variable name, pattern type ("regex" or "literal"), pattern string, flags, error.
// Returns error for unsupported patterns (hex, etc.).
func parseStringLine(line string) (string, string, string, string, error) {
	// Expected format: $a = /regex/flags or $a = "literal"
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", "", "", "", fmt.Errorf("cannot parse string definition: %q", line)
	}

	varName := strings.TrimSpace(parts[0])
	value := strings.TrimSpace(parts[1])

	// Hex pattern: { xx xx xx }
	if strings.HasPrefix(value, "{") {
		return "", "", "", "", fmt.Errorf("unsupported: hex string patterns are not supported (only regex /pattern/ and literal \"string\" patterns)")
	}

	// Regex pattern: /pattern/flags
	if strings.HasPrefix(value, "/") {
		pattern, flags, err := parseRegexValue(value)
		if err != nil {
			return "", "", "", "", err
		}
		return varName, "regex", pattern, flags, nil
	}

	// Literal string: "pattern"
	if strings.HasPrefix(value, "\"") {
		lit, err := parseLiteralValue(value)
		if err != nil {
			return "", "", "", "", err
		}
		return varName, "literal", lit, "", nil
	}

	return "", "", "", "", fmt.Errorf("unsupported string pattern format: %q", value)
}

// parseRegexValue parses /pattern/flags from the value portion of a YARA string line.
// The value may have trailing whitespace or inline comments.
func parseRegexValue(value string) (string, string, error) {
	if !strings.HasPrefix(value, "/") {
		return "", "", fmt.Errorf("expected regex to start with '/', got %q", value)
	}

	// Find the closing / — scan from the end to handle regex containing /
	// But we need to be careful: the pattern itself might contain escaped slashes.
	// YARA regex uses / as delimiter; Go doesn't. We need to find the last /
	// that's followed by optional flags and then end-of-meaningful-content.

	// The first unescaped slash closes the regex; later slashes may be comments.
	content := value[1:] // skip opening /

	lastSlash := -1
	for j := 0; j < len(content); j++ {
		if content[j] == '/' {
			// Check it's not escaped
			escaped := false
			k := j - 1
			for k >= 0 && content[k] == '\\' {
				escaped = !escaped
				k--
			}
			if !escaped {
				lastSlash = j
				break
			}
		}
	}

	if lastSlash < 0 {
		return "", "", fmt.Errorf("unterminated regex in %q", value)
	}

	pattern := content[:lastSlash]
	remainder := content[lastSlash+1:]

	// Flags are the alpha chars immediately after the closing /
	flags := ""
	for _, ch := range remainder {
		if ch >= 'a' && ch <= 'z' {
			flags += string(ch)
		} else {
			break
		}
	}

	tail := strings.TrimSpace(remainder[len(flags):])
	if strings.Trim(flags, "is") != "" || tail != "" && !strings.HasPrefix(tail, "//") {
		return "", "", fmt.Errorf("unsupported regex flags or modifiers: %q", remainder)
	}
	return pattern, flags, nil
}

// parseLiteralValue extracts a quoted string value, handling basic escapes.
func parseLiteralValue(value string) (string, error) {
	if !strings.HasPrefix(value, "\"") {
		return "", fmt.Errorf("expected literal string to start with '\"', got %q", value)
	}

	// Find closing quote (handle escaped quotes)
	content := value[1:]
	var result strings.Builder
	i := 0
	for i < len(content) {
		if content[i] == '\\' && i+1 < len(content) {
			switch content[i+1] {
			case '"':
				result.WriteByte('"')
			case '\\':
				result.WriteByte('\\')
			case 'n':
				result.WriteByte('\n')
			case 't':
				result.WriteByte('\t')
			case 'r':
				result.WriteByte('\r')
			case 'x':
				if i+3 >= len(content) {
					return "", fmt.Errorf("incomplete hex literal escape")
				}
				b, err := strconv.ParseUint(content[i+2:i+4], 16, 8)
				if err != nil {
					return "", fmt.Errorf("invalid hex literal escape")
				}
				result.WriteByte(byte(b))
				i += 2
			default:
				return "", fmt.Errorf("unsupported literal escape: %q", content[i:i+2])
			}
			i += 2
			continue
		}
		if content[i] == '"' {
			tail := strings.TrimSpace(content[i+1:])
			if tail != "" && !strings.HasPrefix(tail, "//") {
				return "", fmt.Errorf("unsupported literal modifiers: %q", tail)
			}
			return result.String(), nil
		}
		result.WriteByte(content[i])
		i++
	}

	return "", fmt.Errorf("unterminated string literal in %q", value)
}

func bytePattern(pattern string) (string, error) {
	if strings.Contains(pattern, "(?") || strings.Contains(pattern, "[:") {
		return "", fmt.Errorf("unsupported regex syntax")
	}
	var out strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		b := pattern[i]
		if b == '\\' {
			if i+1 == len(pattern) {
				return "", fmt.Errorf("incomplete regex escape")
			}
			i++
			switch pattern[i] {
			case 's':
				if inClass {
					out.WriteString(`\t-\r `)
				} else {
					out.WriteString(`[\t-\r ]`)
				}
			case 'S':
				if inClass {
					return "", fmt.Errorf("unsupported \\S inside character class")
				}
				out.WriteString(`[^\t-\r ]`)
			case 'x':
				if i+2 >= len(pattern) {
					return "", fmt.Errorf("incomplete hex regex escape")
				}
				v, err := strconv.ParseUint(pattern[i+1:i+3], 16, 8)
				if err != nil {
					return "", fmt.Errorf("unsupported hex regex escape")
				}
				if v >= 128 {
					out.WriteRune(0xe000 + rune(v))
				} else {
					out.WriteString(pattern[i-1 : i+3])
				}
				i += 2
			default:
				c := pattern[i]
				if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' {
					if !strings.ContainsRune("nrtfavbBdDwW", rune(c)) {
						return "", fmt.Errorf("unsupported regex escape")
					}
				}
				out.WriteByte('\\')
				out.WriteByte(c)
			}
			continue
		}
		if b == '[' {
			inClass = true
		}
		if b == ']' {
			inClass = false
		}
		if b >= 128 {
			out.WriteRune(0xe000 + rune(b))
		} else {
			out.WriteByte(b)
		}
	}
	return out.String(), nil
}

// byteText maps non-ASCII UTF-8 bytes to private-use runes. RE2 then matches
// bytes as YARA does, without Unicode case folding or multibyte dot semantics.
func byteText(text string) string {
	for i := 0; i < len(text); i++ {
		if text[i] >= 128 {
			var out strings.Builder
			out.WriteString(text[:i])
			for ; i < len(text); i++ {
				if text[i] < 128 {
					out.WriteByte(text[i])
				} else {
					out.WriteRune(0xe000 + rune(text[i]))
				}
			}
			return out.String()
		}
	}
	return text
}

// coerceSeverity validates severity values. Valid values are "info", "warn", "error".
// Anything else (or empty) defaults to "error".
func coerceSeverity(s string) string {
	switch s {
	case "info", "warn", "error":
		return s
	default:
		return "error"
	}
}
