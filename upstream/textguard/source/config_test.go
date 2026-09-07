// Modified for Jouzu: isolate Windows home-directory configuration in tests.
package textguard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// helper: setEnv sets an env var for the duration of a test and restores it on cleanup.
func setEnv(t *testing.T, key, value string) {
	t.Helper()
	if key == "HOME" {
		// os.UserHomeDir uses USERPROFILE on Windows rather than HOME.
		setEnv(t, "USERPROFILE", value)
	}
	old, existed := os.LookupEnv(key)
	os.Setenv(key, value)
	t.Cleanup(func() {
		if existed {
			os.Setenv(key, old)
		} else {
			os.Unsetenv(key)
		}
	})
}

// helper: unsetEnv unsets an env var for the duration of a test and restores it on cleanup.
func unsetEnv(t *testing.T, key string) {
	t.Helper()
	old, existed := os.LookupEnv(key)
	os.Unsetenv(key)
	t.Cleanup(func() {
		if existed {
			os.Setenv(key, old)
		} else {
			os.Unsetenv(key)
		}
	})
}

// helper: clearTextguardEnvVars unsets all TEXTGUARD_* env vars for test isolation.
func clearTextguardEnvVars(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"TEXTGUARD_PRESET",
		"TEXTGUARD_CONFUSABLES",
		"TEXTGUARD_PROMPTGUARD_MODEL",
		"TEXTGUARD_YARA_RULES_DIR",
		"TEXTGUARD_YARA_BUNDLED",
		"TEXTGUARD_SPLIT_TOKENS",
	} {
		unsetEnv(t, key)
	}
}

// helper: writeConfigFile creates a config.toml in the given dir structure.
func writeConfigFile(t *testing.T, baseDir, content string) string {
	t.Helper()
	configDir := filepath.Join(baseDir, "textguard")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q): %v", configDir, err)
	}
	configPath := filepath.Join(configDir, "config.toml")
	if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q): %v", configPath, err)
	}
	return configPath
}

// --- Tests for defaults ---

func TestConfigDefaults(t *testing.T) {
	clearTextguardEnvVars(t)
	// Point HOME and XDG to a temp dir with no config file
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	setEnv(t, "XDG_CONFIG_HOME", filepath.Join(tmp, "xdg"))

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetDefault {
		t.Errorf("Preset = %q, want %q", cfg.Preset, PresetDefault)
	}
	if cfg.Confusables != ConfusablesTrimmed {
		t.Errorf("Confusables = %q, want %q", cfg.Confusables, ConfusablesTrimmed)
	}
	if cfg.SplitTokens {
		t.Error("SplitTokens should be false by default")
	}
	if cfg.YaraBundled {
		t.Error("YaraBundled should be false by default")
	}
	if cfg.YaraRulesDir != "" {
		t.Errorf("YaraRulesDir = %q, want empty", cfg.YaraRulesDir)
	}
	if cfg.PromptGuardModelPath != "" {
		t.Errorf("PromptGuardModelPath = %q, want empty", cfg.PromptGuardModelPath)
	}
}

// --- Tests for PresetSettings ---

func TestConfigPresetSettings(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	setEnv(t, "XDG_CONFIG_HOME", filepath.Join(tmp, "xdg"))

	cfg, err := ResolveConfig(WithPreset(PresetStrict))
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	ps := cfg.PresetSettings()
	if ps.Name != PresetStrict {
		t.Errorf("PresetSettings().Name = %q, want %q", ps.Name, PresetStrict)
	}
	if ps.NormalizationForm != NormNFKC {
		t.Errorf("PresetSettings().NormalizationForm = %q, want %q", ps.NormalizationForm, NormNFKC)
	}
	if !ps.DecodeOnClean {
		t.Error("strict PresetSettings().DecodeOnClean should be true")
	}
	if !ps.StripInvisible {
		t.Error("strict PresetSettings().StripInvisible should be true")
	}
}

// --- Tests for config precedence ---

func TestConfigPrecedence_KwargsThenEnvThenFileThenDefaults(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	// Write a config file at ~/.config/textguard/config.toml
	configBase := filepath.Join(tmp, ".config")
	writeConfigFile(t, configBase,
		"preset = \"strict\"\nconfusables = \"trimmed\"\npromptguard_model = \"~/models/from-file\"\n"+
			"[yara]\nrules_dir = \"~/rules/from-file\"\nbundled = true\n")

	// Set env vars that should override file values
	setEnv(t, "TEXTGUARD_PRESET", "default")
	setEnv(t, "TEXTGUARD_CONFUSABLES", "full")
	setEnv(t, "TEXTGUARD_YARA_RULES_DIR", "~/rules/from-env")

	// Resolve without overrides — should use env > file > defaults
	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetDefault {
		t.Errorf("Preset = %q, want %q (env overrides file)", cfg.Preset, PresetDefault)
	}
	if cfg.Confusables != ConfusablesFull {
		t.Errorf("Confusables = %q, want %q (env overrides file)", cfg.Confusables, ConfusablesFull)
	}
	if !cfg.YaraBundled {
		t.Error("YaraBundled should be true (from file)")
	}
	// yara_rules_dir env should override file
	expectedRulesDir := filepath.Join(tmp, "rules", "from-env")
	if cfg.YaraRulesDir != expectedRulesDir {
		t.Errorf("YaraRulesDir = %q, want %q (env overrides file)", cfg.YaraRulesDir, expectedRulesDir)
	}
	// promptguard_model_path from file (no env override)
	expectedModelPath := filepath.Join(tmp, "models", "from-file")
	if cfg.PromptGuardModelPath != expectedModelPath {
		t.Errorf("PromptGuardModelPath = %q, want %q (from file)", cfg.PromptGuardModelPath, expectedModelPath)
	}

	// Now resolve with functional overrides — should override env
	cfg2, err := ResolveConfig(WithPreset(PresetASCII), WithConfusables(ConfusablesTrimmed))
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg2.Preset != PresetASCII {
		t.Errorf("Preset = %q, want %q (override trumps env)", cfg2.Preset, PresetASCII)
	}
	if cfg2.Confusables != ConfusablesTrimmed {
		t.Errorf("Confusables = %q, want %q (override trumps env)", cfg2.Confusables, ConfusablesTrimmed)
	}
}

// --- Tests for XDG_CONFIG_HOME ---

func TestConfigFilePathHonorsXDGConfigHome(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	homeDir := filepath.Join(tmp, "home")
	os.MkdirAll(homeDir, 0o755)
	xdgRoot := filepath.Join(tmp, "xdg")

	writeConfigFile(t, xdgRoot, "preset = \"strict\"\n")

	setEnv(t, "HOME", homeDir)
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetStrict {
		t.Errorf("Preset = %q, want %q (from XDG config file)", cfg.Preset, PresetStrict)
	}
}

// --- Tests for unknown config file keys ---

func TestConfigFileRejectsUnknownKeys(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	homeDir := filepath.Join(tmp, "home")
	os.MkdirAll(homeDir, 0o755)
	xdgRoot := filepath.Join(tmp, "xdg")

	writeConfigFile(t, xdgRoot, "presets = \"strict\"\n") // typo: "presets" instead of "preset"

	setEnv(t, "HOME", homeDir)
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error for unknown config key, got nil")
	}
	expected := "Unexpected textguard config file keys: presets"
	if got := err.Error(); !strings.Contains(got, expected) {
		t.Errorf("error = %q, want it to contain %q", got, expected)
	}
}

func TestConfigFileRejectsUnknownYaraKeys(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "xdg")
	writeConfigFile(t, xdgRoot, "[yara]\nrulz_dir = \"/tmp\"\n") // typo

	setEnv(t, "HOME", filepath.Join(tmp, "home"))
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error for unknown yara config key, got nil")
	}
	if got := err.Error(); !strings.Contains(got, "rulz_dir") {
		t.Errorf("error = %q, want it to mention 'rulz_dir'", got)
	}
}

// --- Tests for bool env var coercion ---

func TestBoolEnvironmentValuesAreCoerced(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	tests := []struct {
		envKey   string
		envValue string
		field    string
		wantBool bool
	}{
		{"TEXTGUARD_YARA_BUNDLED", "true", "YaraBundled", true},
		{"TEXTGUARD_YARA_BUNDLED", "1", "YaraBundled", true},
		{"TEXTGUARD_YARA_BUNDLED", "yes", "YaraBundled", true},
		{"TEXTGUARD_YARA_BUNDLED", "on", "YaraBundled", true},
		{"TEXTGUARD_YARA_BUNDLED", "false", "YaraBundled", false},
		{"TEXTGUARD_YARA_BUNDLED", "0", "YaraBundled", false},
		{"TEXTGUARD_YARA_BUNDLED", "no", "YaraBundled", false},
		{"TEXTGUARD_YARA_BUNDLED", "off", "YaraBundled", false},
		{"TEXTGUARD_SPLIT_TOKENS", "1", "SplitTokens", true},
		{"TEXTGUARD_SPLIT_TOKENS", "TRUE", "SplitTokens", true},
		{"TEXTGUARD_SPLIT_TOKENS", "False", "SplitTokens", false},
	}

	for _, tt := range tests {
		t.Run(tt.envKey+"="+tt.envValue, func(t *testing.T) {
			clearTextguardEnvVars(t)
			tmp := t.TempDir()
			setEnv(t, "HOME", tmp)
			unsetEnv(t, "XDG_CONFIG_HOME")
			setEnv(t, tt.envKey, tt.envValue)

			cfg, err := ResolveConfig()
			if err != nil {
				t.Fatalf("ResolveConfig() error: %v", err)
			}

			var got bool
			switch tt.field {
			case "YaraBundled":
				got = cfg.YaraBundled
			case "SplitTokens":
				got = cfg.SplitTokens
			}
			if got != tt.wantBool {
				t.Errorf("%s = %v, want %v", tt.field, got, tt.wantBool)
			}
		})
	}
}

func TestBoolCoercionInvalidValue(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_YARA_BUNDLED", "maybe")

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error for invalid bool env var, got nil")
	}
	if got := err.Error(); !strings.Contains(got, "yara_bundled") {
		t.Errorf("error = %q, want it to mention 'yara_bundled'", got)
	}
}

// --- Tests for invalid preset ---

func TestInvalidPresetReturnsError(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_PRESET", "nonexistent")

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error for invalid preset, got nil")
	}
	if got := err.Error(); !strings.Contains(got, "nonexistent") {
		t.Errorf("error = %q, want it to mention 'nonexistent'", got)
	}
}

func TestInvalidConfusablesModeReturnsError(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_CONFUSABLES", "invalid")

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error for invalid confusables mode, got nil")
	}
	if got := err.Error(); !strings.Contains(got, "invalid") {
		t.Errorf("error = %q, want it to mention 'invalid'", got)
	}
}

// --- Tests for functional options ---

func TestWithPreset(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	for _, p := range []PresetName{PresetDefault, PresetStrict, PresetASCII} {
		cfg, err := ResolveConfig(WithPreset(p))
		if err != nil {
			t.Fatalf("ResolveConfig(WithPreset(%q)): %v", p, err)
		}
		if cfg.Preset != p {
			t.Errorf("Preset = %q, want %q", cfg.Preset, p)
		}
	}
}

func TestWithConfusables(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	for _, m := range []ConfusablesMode{ConfusablesTrimmed, ConfusablesFull} {
		cfg, err := ResolveConfig(WithConfusables(m))
		if err != nil {
			t.Fatalf("ResolveConfig(WithConfusables(%q)): %v", m, err)
		}
		if cfg.Confusables != m {
			t.Errorf("Confusables = %q, want %q", cfg.Confusables, m)
		}
	}
}

func TestWithSplitTokens(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	cfg, err := ResolveConfig(WithSplitTokens(true))
	if err != nil {
		t.Fatalf("ResolveConfig error: %v", err)
	}
	if !cfg.SplitTokens {
		t.Error("SplitTokens = false, want true")
	}
}

func TestWithYaraBundled(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	cfg, err := ResolveConfig(WithYaraBundled(true))
	if err != nil {
		t.Fatalf("ResolveConfig error: %v", err)
	}
	if !cfg.YaraBundled {
		t.Error("YaraBundled = false, want true")
	}
}

func TestWithYaraRulesDir(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	cfg, err := ResolveConfig(WithYaraRulesDir("/some/path"))
	if err != nil {
		t.Fatalf("ResolveConfig error: %v", err)
	}
	if cfg.YaraRulesDir != "/some/path" {
		t.Errorf("YaraRulesDir = %q, want %q", cfg.YaraRulesDir, "/some/path")
	}
}

func TestWithPromptGuardModelPath(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	cfg, err := ResolveConfig(WithPromptGuardModelPath("/model/path"))
	if err != nil {
		t.Fatalf("ResolveConfig error: %v", err)
	}
	if cfg.PromptGuardModelPath != "/model/path" {
		t.Errorf("PromptGuardModelPath = %q, want %q", cfg.PromptGuardModelPath, "/model/path")
	}
}

// --- Tests for TOML config file ---

func TestConfigFromTOMLFile(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "xdg")
	writeConfigFile(t, xdgRoot, `
preset = "ascii"
confusables = "full"
split_tokens = true
promptguard_model_path = "/models/test"

[yara]
rules_dir = "/yara/rules"
bundled = true
`)

	setEnv(t, "HOME", filepath.Join(tmp, "home"))
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetASCII {
		t.Errorf("Preset = %q, want %q", cfg.Preset, PresetASCII)
	}
	if cfg.Confusables != ConfusablesFull {
		t.Errorf("Confusables = %q, want %q", cfg.Confusables, ConfusablesFull)
	}
	if !cfg.SplitTokens {
		t.Error("SplitTokens should be true from config file")
	}
	if cfg.PromptGuardModelPath != "/models/test" {
		t.Errorf("PromptGuardModelPath = %q, want %q", cfg.PromptGuardModelPath, "/models/test")
	}
	if cfg.YaraRulesDir != "/yara/rules" {
		t.Errorf("YaraRulesDir = %q, want %q", cfg.YaraRulesDir, "/yara/rules")
	}
	if !cfg.YaraBundled {
		t.Error("YaraBundled should be true from config file")
	}
}

func TestConfigFilePromptGuardModelAlias(t *testing.T) {
	// Python supports both "promptguard_model" and "promptguard_model_path"
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "xdg")
	writeConfigFile(t, xdgRoot, `promptguard_model = "/models/alias-test"`)

	setEnv(t, "HOME", filepath.Join(tmp, "home"))
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.PromptGuardModelPath != "/models/alias-test" {
		t.Errorf("PromptGuardModelPath = %q, want %q", cfg.PromptGuardModelPath, "/models/alias-test")
	}
}

// --- Tests for tilde expansion ---

func TestTildeExpansionInPaths(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_YARA_RULES_DIR", "~/rules/test")

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	expected := filepath.Join(tmp, "rules", "test")
	if cfg.YaraRulesDir != expected {
		t.Errorf("YaraRulesDir = %q, want %q", cfg.YaraRulesDir, expected)
	}
}

func TestTildeExpansionInConfigFile(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "xdg")
	writeConfigFile(t, xdgRoot, `
promptguard_model_path = "~/models/test"

[yara]
rules_dir = "~/yara/rules"
`)

	setEnv(t, "HOME", tmp)
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	expectedModel := filepath.Join(tmp, "models", "test")
	if cfg.PromptGuardModelPath != expectedModel {
		t.Errorf("PromptGuardModelPath = %q, want %q", cfg.PromptGuardModelPath, expectedModel)
	}
	expectedRules := filepath.Join(tmp, "yara", "rules")
	if cfg.YaraRulesDir != expectedRules {
		t.Errorf("YaraRulesDir = %q, want %q", cfg.YaraRulesDir, expectedRules)
	}
}

// --- Tests for no config file ---

func TestNoConfigFileUsesDefaults(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	setEnv(t, "XDG_CONFIG_HOME", filepath.Join(tmp, "nonexistent"))

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetDefault {
		t.Errorf("Preset = %q, want %q", cfg.Preset, PresetDefault)
	}
	if cfg.Confusables != ConfusablesTrimmed {
		t.Errorf("Confusables = %q, want %q", cfg.Confusables, ConfusablesTrimmed)
	}
}

// --- Tests for multiple options combined ---

func TestMultipleOptionsCombined(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	cfg, err := ResolveConfig(
		WithPreset(PresetStrict),
		WithConfusables(ConfusablesFull),
		WithSplitTokens(true),
		WithYaraBundled(true),
		WithYaraRulesDir("/custom/rules"),
		WithPromptGuardModelPath("/custom/model"),
	)
	if err != nil {
		t.Fatalf("ResolveConfig error: %v", err)
	}
	if cfg.Preset != PresetStrict {
		t.Errorf("Preset = %q, want strict", cfg.Preset)
	}
	if cfg.Confusables != ConfusablesFull {
		t.Errorf("Confusables = %q, want full", cfg.Confusables)
	}
	if !cfg.SplitTokens {
		t.Error("SplitTokens should be true")
	}
	if !cfg.YaraBundled {
		t.Error("YaraBundled should be true")
	}
	if cfg.YaraRulesDir != "/custom/rules" {
		t.Errorf("YaraRulesDir = %q, want /custom/rules", cfg.YaraRulesDir)
	}
	if cfg.PromptGuardModelPath != "/custom/model" {
		t.Errorf("PromptGuardModelPath = %q, want /custom/model", cfg.PromptGuardModelPath)
	}
}

// --- Test ConfigFilePath ---

func TestConfigFilePath(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")

	got := ConfigFilePath()
	expected := filepath.Join(tmp, ".config", "textguard", "config.toml")
	if got != expected {
		t.Errorf("ConfigFilePath() = %q, want %q", got, expected)
	}
}

func TestConfigFilePath_WithXDG(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "custom-config")
	setEnv(t, "HOME", tmp)
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	got := ConfigFilePath()
	expected := filepath.Join(xdgRoot, "textguard", "config.toml")
	if got != expected {
		t.Errorf("ConfigFilePath() = %q, want %q", got, expected)
	}
}

// --- Test env vars for each field ---

func TestEnvVarPreset(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_PRESET", "ascii")

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Preset != PresetASCII {
		t.Errorf("Preset = %q, want ascii", cfg.Preset)
	}
}

func TestEnvVarConfusables(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_CONFUSABLES", "full")

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.Confusables != ConfusablesFull {
		t.Errorf("Confusables = %q, want full", cfg.Confusables)
	}
}

func TestEnvVarPromptGuardModel(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_PROMPTGUARD_MODEL", "/env/model")

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.PromptGuardModelPath != "/env/model" {
		t.Errorf("PromptGuardModelPath = %q, want /env/model", cfg.PromptGuardModelPath)
	}
}

func TestEnvVarYaraRulesDir(t *testing.T) {
	clearTextguardEnvVars(t)
	tmp := t.TempDir()
	setEnv(t, "HOME", tmp)
	unsetEnv(t, "XDG_CONFIG_HOME")
	setEnv(t, "TEXTGUARD_YARA_RULES_DIR", "/env/rules")

	cfg, err := ResolveConfig()
	if err != nil {
		t.Fatalf("ResolveConfig() error: %v", err)
	}
	if cfg.YaraRulesDir != "/env/rules" {
		t.Errorf("YaraRulesDir = %q, want /env/rules", cfg.YaraRulesDir)
	}
}

// --- Test that the TOML [yara] section must be a table ---

func TestConfigFileYaraMustBeTable(t *testing.T) {
	clearTextguardEnvVars(t)

	tmp := t.TempDir()
	xdgRoot := filepath.Join(tmp, "xdg")
	writeConfigFile(t, xdgRoot, `yara = "not a table"`)

	setEnv(t, "HOME", filepath.Join(tmp, "home"))
	setEnv(t, "XDG_CONFIG_HOME", xdgRoot)

	_, err := ResolveConfig()
	if err == nil {
		t.Fatal("expected error when [yara] is not a table")
	}
	if got := err.Error(); !strings.Contains(got, "must be a table") {
		t.Errorf("error = %q, want it to contain 'must be a table'", got)
	}
}
