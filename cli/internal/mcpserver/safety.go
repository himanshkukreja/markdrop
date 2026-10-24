package mcpserver

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// AllowAnyPathEnv turns the secret-path guard off (MARKDROP_MCP_ALLOW_ANY_PATH=1).
const AllowAnyPathEnv = "MARKDROP_MCP_ALLOW_ANY_PATH"

// Guard refuses to share well-known secret locations, or to save downloads
// into them. An AI app can be talked into calling share_files by text it reads
// (a web page, an issue, a file): this stops "share ~/.ssh" from turning into
// a link to the user's keys. It is a safety net, not a sandbox.
type Guard struct {
	Home     string
	AllowAny bool
}

// NewGuard reads the user's home directory and AllowAnyPathEnv.
func NewGuard() *Guard {
	home, _ := os.UserHomeDir()
	return &Guard{Home: home, AllowAny: os.Getenv(AllowAnyPathEnv) == "1"}
}

// Folders that hold credentials, matched as any path component.
var secretDirs = map[string]string{
	".ssh":            "SSH keys",
	".aws":            "AWS credentials",
	".gnupg":          "GnuPG keys",
	".kube":           "Kubernetes credentials",
	".azure":          "Azure credentials",
	".password-store": "a password store",
}

// Two consecutive path components that hold credentials.
var secretPairs = []struct{ a, b, why string }{
	{".config", "gcloud", "Google Cloud credentials"},
	{".config", "gh", "GitHub CLI tokens"},
	{".docker", "config.json", "Docker registry credentials"},
	{"library", "keychains", "macOS Keychains"},
	{"share", "keyrings", "the desktop keyring"},
}

// Single file names that hold credentials.
var secretFiles = map[string]string{
	".netrc":           "login credentials",
	".npmrc":           "npm tokens",
	".pypirc":          "PyPI tokens",
	".git-credentials": "git credentials",
	".pgpass":          "PostgreSQL passwords",
}

var (
	sshKeyName = regexp.MustCompile(`^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$`)
	secretExt  = map[string]string{
		".pem": "a PEM key or certificate", ".p12": "a PKCS#12 key bundle", ".pfx": "a PKCS#12 key bundle",
		".keychain": "a macOS keychain", ".keychain-db": "a macOS keychain",
	}
)

// Places a download must never land: they run what is put there.
var autostartPairs = []struct{ a, b, why string }{
	{"library", "launchagents", "macOS login items"},
	{"library", "launchdaemons", "macOS system services"},
	{".config", "autostart", "desktop autostart"},
	{".config", "systemd", "systemd user services"},
}

// secretReason says why path is a secret location, or "" if it isn't.
// Comparisons ignore case: macOS and Windows file systems usually do.
func secretReason(path string) string {
	parts := splitPath(path)
	for i, p := range parts {
		lp := strings.ToLower(p)
		if why, ok := secretDirs[lp]; ok {
			return why
		}
		if why, ok := secretFiles[lp]; ok {
			return why
		}
		if strings.HasPrefix(lp, ".env") {
			return "environment secrets (.env)"
		}
		if sshKeyName.MatchString(lp) {
			return "an SSH private key"
		}
		if why, ok := secretExt[filepath.Ext(lp)]; ok {
			return why
		}
		if i+1 < len(parts) {
			next := strings.ToLower(parts[i+1])
			for _, sp := range secretPairs {
				if lp == sp.a && next == sp.b {
					return sp.why
				}
			}
		}
	}
	return ""
}

func autostartReason(path string) string {
	parts := splitPath(path)
	for i := 0; i+1 < len(parts); i++ {
		a, b := strings.ToLower(parts[i]), strings.ToLower(parts[i+1])
		for _, sp := range autostartPairs {
			if a == sp.a && b == sp.b {
				return sp.why
			}
		}
	}
	return ""
}

func splitPath(path string) []string {
	path = filepath.ToSlash(filepath.Clean(path))
	var out []string
	for _, p := range strings.Split(path, "/") {
		if p != "" && p != "." {
			out = append(out, p)
		}
	}
	return out
}

// Expand turns "~" and "~/x" into home-relative paths and makes the result
// absolute (relative paths resolve against the server's working directory).
func (g *Guard) Expand(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("empty path")
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if g.Home == "" {
			return "", errors.New("cannot expand ~: no home directory")
		}
		p = filepath.Join(g.Home, p[1:])
	}
	return filepath.Abs(p)
}

// refusal is the error for a refused path.
type refusal struct {
	path, why string
	inside    []string // offending entries of a folder
}

func (r *refusal) Error() string {
	if len(r.inside) > 0 {
		return fmt.Sprintf("refused to share %s: it contains %s (%s). Share the specific files you need instead, "+
			"or set %s=1 in this MCP server's environment if you really mean to share secrets.",
			r.path, strings.Join(r.inside, ", "), r.why, AllowAnyPathEnv)
	}
	return fmt.Sprintf("refused to share %s: it looks like %s. Markdrop's MCP server never shares well-known secret "+
		"locations (SSH/cloud keys, keychains, .env files, private keys) unless %s=1 is set in its environment.",
		r.path, r.why, AllowAnyPathEnv)
}

// CheckSharePath expands p and refuses it if it is, is inside, resolves to, or
// (for a folder) contains a secret location. It returns the absolute path.
func (g *Guard) CheckSharePath(p string) (string, error) {
	abs, err := g.Expand(p)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("cannot access %s: %w", abs, unwrapPathErr(err))
	}
	if !fi.IsDir() && !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file or folder", abs)
	}
	if g.AllowAny {
		return abs, nil
	}
	if why := secretReason(abs); why != "" {
		return "", &refusal{path: abs, why: why}
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("cannot resolve %s: %w", abs, unwrapPathErr(err))
	}
	if why := secretReason(resolved); why != "" {
		return "", &refusal{path: abs + " (→ " + resolved + ")", why: why}
	}
	if fi.IsDir() {
		if err := scanFolder(abs, resolved); err != nil {
			return "", err
		}
	}
	return abs, nil
}

// scanFolder walks a folder (without following symlinked folders, as the zip
// doesn't either) and refuses it if any entry, or any symlink's target, is a
// secret location.
func scanFolder(display, root string) error {
	var hits []string
	why := ""
	note := func(rel, w string) {
		if why == "" {
			why = w
		}
		if len(hits) < 5 {
			hits = append(hits, rel)
		} else if len(hits) == 5 {
			hits = append(hits, "…")
		}
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			if p == root {
				return werr
			}
			return nil // unreadable entries are skipped by the zip too
		}
		if len(hits) > 5 {
			return filepath.SkipAll // enough to refuse and to explain why
		}
		rel, _ := filepath.Rel(root, p)
		if rel == "." {
			return nil
		}
		if w := secretReason(rel); w != "" {
			note(rel, w)
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			if target, err := filepath.EvalSymlinks(p); err == nil {
				if w := secretReason(target); w != "" {
					note(rel+" (→ "+target+")", w)
				}
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("cannot read folder %s: %w", display, unwrapPathErr(err))
	}
	if len(hits) > 0 {
		return &refusal{path: display, why: why, inside: hits}
	}
	return nil
}

// CheckReceiveDir expands dir and refuses secret and autostart locations.
func (g *Guard) CheckReceiveDir(dir string) (string, error) {
	abs, err := g.Expand(dir)
	if err != nil {
		return "", err
	}
	if g.AllowAny {
		return abs, nil
	}
	check := []string{abs}
	// Resolve the deepest part that exists, so a symlinked parent can't hide
	// where the files really go.
	for p := abs; ; p = filepath.Dir(p) {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			rest, _ := filepath.Rel(p, abs)
			check = append(check, filepath.Join(r, rest))
			break
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	for _, c := range check {
		why := secretReason(c)
		if why == "" {
			why = autostartReason(c)
		}
		if why != "" {
			return "", fmt.Errorf("refused to save into %s: it holds %s. Choose another folder, such as ~/Downloads/Markdrop", abs, why)
		}
	}
	return abs, nil
}

func unwrapPathErr(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
