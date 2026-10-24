package mcpserver

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeHome builds a home folder with the usual secret places in it.
func fakeHome(t *testing.T) (*Guard, string) {
	t.Helper()
	home := t.TempDir()
	if r, err := filepath.EvalSymlinks(home); err == nil {
		home = r
	}
	files := []string{
		".ssh/id_ed25519", ".ssh/config", ".aws/credentials", ".gnupg/pubring.kbx",
		".config/gcloud/application_default_credentials.json", ".kube/config", ".docker/config.json",
		".netrc", ".npmrc", ".pypirc", "Library/Keychains/login.keychain-db",
		"work/app/.env", "work/app/.env.local", "work/app/main.go", "work/certs/server.pem",
		"work/keys/id_rsa", "work/keys/id_rsa.pub", "work/clean/a.txt", "work/clean/sub/b.txt",
		"Documents/report.pdf", "Documents/id_card.png",
	}
	for _, f := range files {
		p := filepath.Join(home, f)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return &Guard{Home: home}, home
}

func TestGuardRefusesSecretLocations(t *testing.T) {
	g, home := fakeHome(t)
	refused := []string{
		"~/.ssh", "~/.ssh/id_ed25519", "~/.ssh/config", "~/.SSH/config", "~/.aws/credentials", "~/.aws",
		"~/.gnupg", "~/.config/gcloud", "~/.config/gcloud/application_default_credentials.json",
		"~/.kube/config", "~/.docker/config.json", "~/.netrc", "~/.npmrc", "~/.pypirc",
		"~/Library/Keychains/login.keychain-db", "~/Library/Keychains",
		"~/work/app/.env", "~/work/app/.env.local", "~/work/certs/server.pem", "~/work/keys/id_rsa",
		"~/work/app",   // folder containing .env files
		"~/work/keys",  // folder containing a private key
		"~",            // home itself contains all of the above
		home + "/work", // absolute path form
	}
	for _, p := range refused {
		_, err := g.CheckSharePath(p)
		var r *refusal
		if !errors.As(err, &r) {
			t.Errorf("%s: want refusal, got %v", p, err)
			continue
		}
		if !strings.Contains(err.Error(), AllowAnyPathEnv) {
			t.Errorf("%s: refusal should say how to override: %v", p, err)
		}
	}

	allowed := []string{"~/work/clean", "~/work/clean/a.txt", "~/work/keys/id_rsa.pub", "~/Documents", "~/Documents/id_card.png"}
	for _, p := range allowed {
		abs, err := g.CheckSharePath(p)
		if err != nil {
			t.Errorf("%s: unexpectedly refused: %v", p, err)
			continue
		}
		if !filepath.IsAbs(abs) {
			t.Errorf("%s: not made absolute: %s", p, abs)
		}
	}

	// Folder refusal lists what it found.
	_, err := g.CheckSharePath("~/work/app")
	if err == nil || !strings.Contains(err.Error(), ".env") {
		t.Fatalf("folder refusal should name the file: %v", err)
	}
}

func TestGuardFollowsSymlinks(t *testing.T) {
	g, home := fakeHome(t)
	innocent := filepath.Join(home, "work", "notes.txt")
	if err := os.Symlink(filepath.Join(home, ".ssh", "id_ed25519"), innocent); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if _, err := g.CheckSharePath(innocent); err == nil {
		t.Fatal("symlink to an SSH key was allowed")
	}
	folder := filepath.Join(home, "work", "clean")
	os.Symlink(filepath.Join(home, ".aws"), filepath.Join(folder, "cloud"))
	if _, err := g.CheckSharePath(folder); err == nil {
		t.Fatal("folder holding a symlink to ~/.aws was allowed")
	}
	linkedDir := filepath.Join(home, "innocent-dir")
	os.Symlink(filepath.Join(home, ".ssh"), linkedDir)
	if _, err := g.CheckSharePath(linkedDir); err == nil {
		t.Fatal("symlinked ~/.ssh was allowed")
	}
}

func TestGuardOverride(t *testing.T) {
	g, _ := fakeHome(t)
	g.AllowAny = true
	if _, err := g.CheckSharePath("~/.ssh/id_ed25519"); err != nil {
		t.Fatalf("override ignored: %v", err)
	}
	t.Setenv(AllowAnyPathEnv, "1")
	if !NewGuard().AllowAny {
		t.Fatal("env override not read")
	}
	t.Setenv(AllowAnyPathEnv, "yes")
	if NewGuard().AllowAny {
		t.Fatal("only 1 should enable the override")
	}
}

func TestGuardMissingAndSpecialPaths(t *testing.T) {
	g, _ := fakeHome(t)
	if _, err := g.CheckSharePath("~/nope.txt"); err == nil || !strings.Contains(err.Error(), "cannot access") {
		t.Fatalf("missing path: %v", err)
	}
	if _, err := g.CheckSharePath("   "); err == nil {
		t.Fatal("blank path accepted")
	}
}

func TestCheckReceiveDir(t *testing.T) {
	g, home := fakeHome(t)
	for _, bad := range []string{"~/.ssh", "~/.aws/sub", "~/Library/LaunchAgents", "~/.config/autostart", "~/.config/systemd/user"} {
		if _, err := g.CheckReceiveDir(bad); err == nil {
			t.Errorf("%s: download allowed into it", bad)
		}
	}
	// A symlink whose target is ~/.ssh.
	os.Symlink(filepath.Join(home, ".ssh"), filepath.Join(home, "inbox"))
	if _, err := g.CheckReceiveDir("~/inbox/new"); err == nil {
		t.Error("symlinked parent into ~/.ssh allowed")
	}
	got, err := g.CheckReceiveDir("~/Downloads/Markdrop")
	if err != nil || got != filepath.Join(home, "Downloads", "Markdrop") {
		t.Fatalf("default dir: %s %v", got, err)
	}
}

func TestParseShareLink(t *testing.T) {
	ok := map[string]string{
		"https://markdrop.in/share/a1b2c3d4e5":      "a1b2c3d4e5",
		"https://www.markdrop.in/share/a1b2c3d4e5/": "a1b2c3d4e5",
		"http://localhost:3000/share/a1b2c3d4e5":    "a1b2c3d4e5",
		"markdrop.in/share/a1b2c3d4e5":              "a1b2c3d4e5",
		"  a1b2c3d4e5  ":                            "a1b2c3d4e5",
		"https://markdrop.in/share/a1b2c3d4e5?x=1":  "a1b2c3d4e5",
	}
	for in, want := range ok {
		got, err := ParseShareLink(in)
		if err != nil || got != want {
			t.Errorf("ParseShareLink(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "abc", "https://markdrop.in/d/a1b2c3d4e5", "https://markdrop.in/share/", "a1b2c3d4e5;rm -rf", "ftp://markdrop.in/share/a1b2c3d4e5", "../../etc"} {
		if _, err := ParseShareLink(bad); err == nil {
			t.Errorf("ParseShareLink(%q) accepted", bad)
		}
	}
}
