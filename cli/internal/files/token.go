package files

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TokenEnv is the environment variable holding the API token.
const TokenEnv = "MARKDROP_TOKEN"

// ConfigDirEnv overrides where `markdrop login` stores the token.
const ConfigDirEnv = "MARKDROP_CONFIG_DIR"

// TokenPath is <user config dir>/markdrop/token (for example
// ~/Library/Application Support/markdrop/token on macOS,
// ~/.config/markdrop/token on Linux), or $MARKDROP_CONFIG_DIR/token.
func TokenPath() (string, error) {
	if d := strings.TrimSpace(os.Getenv(ConfigDirEnv)); d != "" {
		return filepath.Join(d, "token"), nil
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("no config directory for the token: %w", err)
	}
	return filepath.Join(d, "markdrop", "token"), nil
}

// ResolveToken picks the token: the explicit value (--token), then
// $MARKDROP_TOKEN, then the one saved by `markdrop login`. source says which.
func ResolveToken(explicit string) (token, source string) {
	if t := strings.TrimSpace(explicit); t != "" {
		return t, "--token"
	}
	if t := strings.TrimSpace(os.Getenv(TokenEnv)); t != "" {
		return t, TokenEnv
	}
	if t, err := LoadToken(); err == nil && t != "" {
		p, _ := TokenPath()
		return t, p
	}
	return "", ""
}

// LoadToken reads the saved token ("" if none).
func LoadToken() (string, error) {
	p, err := TokenPath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// SaveToken stores the token readable by this user only (0600 in a 0700
// folder) and returns where.
func SaveToken(token string) (string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", errors.New("the token is empty")
	}
	if strings.ContainsAny(token, " \t\r\n") {
		return "", errors.New("a token has no spaces or line breaks")
	}
	p, err := TokenPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "token.*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", err
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return "", err
	}
	return p, os.Chmod(p, 0o600)
}

// DeleteToken removes the saved token; it reports whether there was one.
func DeleteToken() (bool, error) {
	p, err := TokenPath()
	if err != nil {
		return false, err
	}
	err = os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
