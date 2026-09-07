// Package data provides embedded data files (scripts, confusables, YARA rules)
// with lazy-parsed accessors guarded by sync.Once.
package data

import (
	"embed"
	"encoding/json"
	"io/fs"
	"sync"
)

//go:embed scripts.json
var scriptsRaw []byte

//go:embed confusables.json
var confusablesRaw []byte

//go:embed confusables_full.json
var confusablesFullRaw []byte

//go:embed allowed_signers
var AllowedSigners []byte

//go:embed rules/*.yara
var yaraRulesFS embed.FS

// --- Script ranges ---

// ScriptRange represents a Unicode codepoint range belonging to a script.
type ScriptRange struct {
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Script string `json:"script"`
}

type scriptsFile struct {
	Ranges []ScriptRange `json:"ranges"`
}

var (
	scriptRangesOnce sync.Once
	scriptRangesData []ScriptRange
)

// ScriptRanges returns the parsed script ranges from scripts.json.
// The result is cached after the first call.
func ScriptRanges() []ScriptRange {
	scriptRangesOnce.Do(func() {
		var f scriptsFile
		if err := json.Unmarshal(scriptsRaw, &f); err != nil {
			panic("data: failed to parse scripts.json: " + err.Error())
		}
		scriptRangesData = f.Ranges
	})
	return scriptRangesData
}

// --- Confusables ---

// ConfusableMapping holds one confusable entry.
type ConfusableMapping struct {
	MappingType   string   `json:"mapping_type"`
	SourceScript  string   `json:"source_script"`
	Target        string   `json:"target"`
	TargetScripts []string `json:"target_scripts"`
}

type confusablesFile struct {
	Mappings map[string]ConfusableMapping `json:"mappings"`
}

var (
	confusablesOnce sync.Once
	confusablesData map[string]ConfusableMapping
)

// Confusables returns the parsed confusable mappings from confusables.json (trimmed set).
// Keys are hex codepoint strings (e.g., "019B").
func Confusables() map[string]ConfusableMapping {
	confusablesOnce.Do(func() {
		var f confusablesFile
		if err := json.Unmarshal(confusablesRaw, &f); err != nil {
			panic("data: failed to parse confusables.json: " + err.Error())
		}
		confusablesData = f.Mappings
	})
	return confusablesData
}

var (
	confusablesFullOnce sync.Once
	confusablesFullData map[string]ConfusableMapping
)

// ConfusablesFull returns the parsed confusable mappings from confusables_full.json.
// Keys are hex codepoint strings (e.g., "00F6").
func ConfusablesFull() map[string]ConfusableMapping {
	confusablesFullOnce.Do(func() {
		var f confusablesFile
		if err := json.Unmarshal(confusablesFullRaw, &f); err != nil {
			panic("data: failed to parse confusables_full.json: " + err.Error())
		}
		confusablesFullData = f.Mappings
	})
	return confusablesFullData
}

// --- YARA rules ---

// YaraRuleFile holds the name and content of a single .yara rule file.
type YaraRuleFile struct {
	Name    string
	Content []byte
}

var (
	yaraRuleFilesOnce sync.Once
	yaraRuleFilesData []YaraRuleFile
)

// YaraRuleFiles returns all bundled .yara rule files.
func YaraRuleFiles() []YaraRuleFile {
	yaraRuleFilesOnce.Do(func() {
		entries, err := fs.ReadDir(yaraRulesFS, "rules")
		if err != nil {
			panic("data: failed to read rules directory: " + err.Error())
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			content, err := fs.ReadFile(yaraRulesFS, "rules/"+entry.Name())
			if err != nil {
				panic("data: failed to read rule file " + entry.Name() + ": " + err.Error())
			}
			yaraRuleFilesData = append(yaraRuleFilesData, YaraRuleFile{
				Name:    entry.Name(),
				Content: content,
			})
		}
	})
	return yaraRuleFilesData
}
