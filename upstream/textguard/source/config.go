// Modified for deterministic Unicode conformance and bounded native scanning.
package textguard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/shisa-ai/textguard-go/internal/tgtypes"
)

// ---------------------------------------------------------------------------
// Type aliases re-exported from internal/tgtypes
// ---------------------------------------------------------------------------

// PresetName identifies a built-in configuration preset.
type PresetName = tgtypes.PresetName

const (
	PresetDefault = tgtypes.PresetDefault
	PresetStrict  = tgtypes.PresetStrict
	PresetASCII   = tgtypes.PresetASCII
)

// ConfusablesMode controls which confusable mapping dataset is used.
type ConfusablesMode = tgtypes.ConfusablesMode

const (
	ConfusablesTrimmed = tgtypes.ConfusablesTrimmed
	ConfusablesFull    = tgtypes.ConfusablesFull
)

// NormalizationForm specifies the Unicode normalization form.
type NormalizationForm = tgtypes.NormalizationForm

const (
	NormNFC  = tgtypes.NormNFC
	NormNFKC = tgtypes.NormNFKC
)

// Preset holds the full set of flags for a named configuration preset.
type Preset = tgtypes.Preset

// TextGuardConfig is the resolved runtime configuration.
type TextGuardConfig = tgtypes.TextGuardConfig

// GetPreset returns the Preset for the given name and a boolean indicating
// whether it was found.
var GetPreset = tgtypes.GetPreset

// PresetNames returns the sorted list of available preset names.
var PresetNames = tgtypes.PresetNames

// ---------------------------------------------------------------------------
// Functional options
// ---------------------------------------------------------------------------

// Option is a functional option for configuring TextGuardConfig via ResolveConfig.
type Option func(*configOverrides)

// configOverrides holds optional overrides. Pointer fields distinguish "set" from "unset".
type configOverrides struct {
	preset               *PresetName
	confusables          *ConfusablesMode
	splitTokens          *bool
	yaraRulesDir         *string
	yaraBundled          *bool
	promptGuardModelPath *string

	// Non-config fields extracted by NewGuard before passing to ResolveConfig.
	semanticBackend interface{} // SemanticBackend; stored as interface{} to avoid import cycle
	includeContext  bool        // per-call scan option
	isolated        bool        // ignore configuration files and environment
}

// WithIsolatedConfig ignores configuration files and TEXTGUARD environment
// variables. Only explicit options and built-in defaults configure the guard.
func WithIsolatedConfig() Option {
	return func(o *configOverrides) { o.isolated = true }
}

// WithPreset sets the preset name.
func WithPreset(p PresetName) Option {
	return func(o *configOverrides) { o.preset = &p }
}

// WithConfusables sets the confusables mode.
func WithConfusables(m ConfusablesMode) Option {
	return func(o *configOverrides) { o.confusables = &m }
}

// WithSplitTokens enables or disables split-token detection.
func WithSplitTokens(b bool) Option {
	return func(o *configOverrides) { o.splitTokens = &b }
}

// WithYaraBundled enables or disables bundled YARA rules.
func WithYaraBundled(b bool) Option {
	return func(o *configOverrides) { o.yaraBundled = &b }
}

// WithYaraRulesDir sets a custom YARA rules directory.
func WithYaraRulesDir(dir string) Option {
	return func(o *configOverrides) { o.yaraRulesDir = &dir }
}

// WithPromptGuardModelPath sets the PromptGuard model path.
func WithPromptGuardModelPath(p string) Option {
	return func(o *configOverrides) { o.promptGuardModelPath = &p }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

// ResolveConfig builds a TextGuardConfig by merging (in priority order):
// functional options > environment variables > config file > defaults.
func ResolveConfig(opts ...Option) (*TextGuardConfig, error) {
	// Collect functional option overrides.
	var overrides configOverrides
	for _, o := range opts {
		o(&overrides)
	}

	// Layer 1: config file values (lowest priority after defaults).
	merged := make(map[string]interface{})
	if !overrides.isolated {
		fileVals, err := configFileValues()
		if err != nil {
			return nil, err
		}
		for k, v := range fileVals {
			merged[k] = v
		}
		// Layer 2: environment variable values.
		for k, v := range environmentValues() {
			merged[k] = v
		}
	}

	// Layer 3: functional option overrides (highest priority).
	if overrides.preset != nil {
		merged["preset"] = string(*overrides.preset)
	}
	if overrides.confusables != nil {
		merged["confusables"] = string(*overrides.confusables)
	}
	if overrides.splitTokens != nil {
		merged["split_tokens"] = *overrides.splitTokens
	}
	if overrides.yaraRulesDir != nil {
		merged["yara_rules_dir"] = *overrides.yaraRulesDir
	}
	if overrides.yaraBundled != nil {
		merged["yara_bundled"] = *overrides.yaraBundled
	}
	if overrides.promptGuardModelPath != nil {
		merged["promptguard_model_path"] = *overrides.promptGuardModelPath
	}

	// Coerce and build the config.
	preset, err := coercePreset(merged["preset"], "default")
	if err != nil {
		return nil, err
	}

	confusables, err := coerceConfusables(merged["confusables"], "trimmed")
	if err != nil {
		return nil, err
	}

	splitTokens, err := coerceBool(merged["split_tokens"], false, "split_tokens")
	if err != nil {
		return nil, err
	}

	yaraBundled, err := coerceBool(merged["yara_bundled"], false, "yara_bundled")
	if err != nil {
		return nil, err
	}

	yaraRulesDir, err := coerceOptionalPath(merged["yara_rules_dir"])
	if err != nil {
		return nil, err
	}

	promptGuardModelPath, err := coerceOptionalPath(merged["promptguard_model_path"])
	if err != nil {
		return nil, err
	}

	return &TextGuardConfig{
		Preset:               preset,
		Confusables:          confusables,
		SplitTokens:          splitTokens,
		YaraBundled:          yaraBundled,
		YaraRulesDir:         yaraRulesDir,
		PromptGuardModelPath: promptGuardModelPath,
	}, nil
}

// ---------------------------------------------------------------------------
// XDG / config file path helpers
// ---------------------------------------------------------------------------

// ConfigFilePath returns the default config file path based on XDG conventions.
func ConfigFilePath() string {
	return filepath.Join(xdgConfigHome(), "textguard", "config.toml")
}

// xdgConfigHome returns the XDG_CONFIG_HOME directory, falling back to ~/.config.
func xdgConfigHome() string {
	raw := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if raw != "" {
		return expandTilde(raw)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return filepath.Join(home, ".config")
}

// ---------------------------------------------------------------------------
// Config file parsing
// ---------------------------------------------------------------------------

// tomlConfig represents the raw TOML structure.
type tomlConfig struct {
	Preset               *string     `toml:"preset"`
	Confusables          *string     `toml:"confusables"`
	SplitTokens          interface{} `toml:"split_tokens"`
	PromptGuardModel     *string     `toml:"promptguard_model"`
	PromptGuardModelPath *string     `toml:"promptguard_model_path"`
	Yara                 *tomlYara   `toml:"yara"`
}

type tomlYara struct {
	RulesDir *string     `toml:"rules_dir"`
	Bundled  interface{} `toml:"bundled"`
}

// configFileValues reads the config file and returns a flat key-value map.
func configFileValues() (map[string]interface{}, error) {
	path := ConfigFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	// Parse into a raw map first to validate keys.
	var rawMap map[string]interface{}
	if _, err := toml.Decode(string(data), &rawMap); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}
	if err := validateConfigFileKeys(rawMap); err != nil {
		return nil, err
	}

	// Parse into typed struct.
	var cfg tomlConfig
	if _, err := toml.Decode(string(data), &cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	values := make(map[string]interface{})
	if cfg.Preset != nil {
		values["preset"] = *cfg.Preset
	}
	if cfg.Confusables != nil {
		values["confusables"] = *cfg.Confusables
	}
	if cfg.SplitTokens != nil {
		values["split_tokens"] = cfg.SplitTokens
	}
	// promptguard_model is an alias for promptguard_model_path.
	if cfg.PromptGuardModel != nil {
		values["promptguard_model_path"] = *cfg.PromptGuardModel
	}
	if cfg.PromptGuardModelPath != nil {
		values["promptguard_model_path"] = *cfg.PromptGuardModelPath
	}
	if cfg.Yara != nil {
		if cfg.Yara.RulesDir != nil {
			values["yara_rules_dir"] = *cfg.Yara.RulesDir
		}
		if cfg.Yara.Bundled != nil {
			values["yara_bundled"] = cfg.Yara.Bundled
		}
	}

	return values, nil
}

// validateConfigFileKeys checks for unexpected top-level and [yara] keys.
func validateConfigFileKeys(data map[string]interface{}) error {
	validTopLevel := map[string]bool{
		"confusables":            true,
		"preset":                 true,
		"promptguard_model":      true,
		"promptguard_model_path": true,
		"split_tokens":           true,
		"yara":                   true,
	}

	var invalidKeys []string
	for k := range data {
		if !validTopLevel[k] {
			invalidKeys = append(invalidKeys, k)
		}
	}
	if len(invalidKeys) > 0 {
		sortStrings(invalidKeys)
		return fmt.Errorf("Unexpected textguard config file keys: %s", strings.Join(invalidKeys, ", "))
	}

	// Validate [yara] section if present.
	yaraRaw, ok := data["yara"]
	if !ok {
		return nil
	}
	yaraMap, ok := yaraRaw.(map[string]interface{})
	if !ok {
		return fmt.Errorf("config [yara] section must be a table")
	}
	validYara := map[string]bool{
		"bundled":   true,
		"rules_dir": true,
	}
	var invalidYaraKeys []string
	for k := range yaraMap {
		if !validYara[k] {
			invalidYaraKeys = append(invalidYaraKeys, k)
		}
	}
	if len(invalidYaraKeys) > 0 {
		sortStrings(invalidYaraKeys)
		return fmt.Errorf("Unexpected textguard config [yara] keys: %s", strings.Join(invalidYaraKeys, ", "))
	}

	return nil
}

// sortStrings sorts a string slice in place (avoids importing "sort" for one call).
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

// environmentValues reads TEXTGUARD_* env vars and returns a flat key-value map.
func environmentValues() map[string]interface{} {
	values := make(map[string]interface{})
	if v := os.Getenv("TEXTGUARD_PRESET"); v != "" {
		values["preset"] = v
	}
	if v := os.Getenv("TEXTGUARD_CONFUSABLES"); v != "" {
		values["confusables"] = v
	}
	if v := os.Getenv("TEXTGUARD_PROMPTGUARD_MODEL"); v != "" {
		values["promptguard_model_path"] = v
	}
	if v := os.Getenv("TEXTGUARD_YARA_RULES_DIR"); v != "" {
		values["yara_rules_dir"] = v
	}
	if v := os.Getenv("TEXTGUARD_YARA_BUNDLED"); v != "" {
		values["yara_bundled"] = v
	}
	if v := os.Getenv("TEXTGUARD_SPLIT_TOKENS"); v != "" {
		values["split_tokens"] = v
	}
	return values
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

// coercePreset validates and converts a value to PresetName.
func coercePreset(value interface{}, defaultVal string) (PresetName, error) {
	if value == nil {
		value = defaultVal
	}
	s, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("unsupported preset: %v", value)
	}
	name := PresetName(s)
	if _, exists := tgtypes.GetPreset(name); !exists {
		return "", fmt.Errorf("unsupported preset: %q", s)
	}
	return name, nil
}

// coerceConfusables validates and converts a value to ConfusablesMode.
func coerceConfusables(value interface{}, defaultVal string) (ConfusablesMode, error) {
	if value == nil {
		value = defaultVal
	}
	s, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("unsupported confusables mode: %v", value)
	}
	mode := ConfusablesMode(s)
	if mode != ConfusablesTrimmed && mode != ConfusablesFull {
		return "", fmt.Errorf("unsupported confusables mode: %q", s)
	}
	return mode, nil
}

// coerceBool converts a value to bool, supporting string representations from
// environment variables (true/false/1/0/yes/no/on/off).
func coerceBool(value interface{}, defaultVal bool, fieldName string) (bool, error) {
	if value == nil {
		return defaultVal, nil
	}
	switch v := value.(type) {
	case bool:
		return v, nil
	case string:
		normalized := strings.TrimSpace(strings.ToLower(v))
		switch normalized {
		case "1", "true", "yes", "on":
			return true, nil
		case "0", "false", "no", "off":
			return false, nil
		}
	}
	return false, fmt.Errorf("%s must be a bool", fieldName)
}

// coerceOptionalPath converts a value to a resolved file path string,
// expanding ~ to the user's home directory. Returns "" for nil/empty values.
func coerceOptionalPath(value interface{}) (string, error) {
	if value == nil {
		return "", nil
	}
	s, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("expected path-like value, got %T", value)
	}
	if s == "" {
		return "", nil
	}
	return expandTilde(s), nil
}

// expandTilde expands a leading ~ to the user's home directory.
func expandTilde(path string) string {
	if !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[2:])
	}
	// ~user/... form — just return as-is (Go doesn't easily resolve other users).
	return path
}
