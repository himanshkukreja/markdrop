package cmd

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/peer"
)

func TestBuildShareURL(t *testing.T) {
	cases := []struct{ server, web, want string }{
		{defaultServer, "", "https://markdrop.in/share/abc123def0"},
		{"http://localhost:8080", "", "http://localhost:3000/share/abc123def0"},
		{"http://127.0.0.1:8097", "http://localhost:3198/", "http://localhost:3198/share/abc123def0"},
		{"http://127.0.0.1:8097", "", "http://127.0.0.1:8097/share/abc123def0"},
	}
	for _, c := range cases {
		if got := buildShareURL(c.server, c.web, "abc123def0"); got != c.want {
			t.Errorf("buildShareURL(%q,%q) = %q, want %q", c.server, c.web, got, c.want)
		}
	}
}

func TestParseRoomID(t *testing.T) {
	for in, want := range map[string]string{
		"https://markdrop.in/share/a3f7c12e01":  "a3f7c12e01",
		"https://www.markdrop.in/share/a3f7c12e": "a3f7c12e",
		" a3f7c12e01 ":                          "a3f7c12e01",
	} {
		if got, err := parseRoomID(in); err != nil || got != want {
			t.Errorf("parseRoomID(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "https://markdrop.in/d/x", "a/b", "abc"} {
		if _, err := parseRoomID(bad); err == nil {
			t.Errorf("parseRoomID(%q) accepted", bad)
		}
	}
}

func TestGeneratedIDs(t *testing.T) {
	if !regexp.MustCompile(`^[0-9a-f]{10}$`).MatchString(generateRoomID()) {
		t.Error("room id shape")
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(generateHostKey()) {
		t.Error("host key shape (the server wants 32-64 hex)")
	}
	if version != "0.5.0" {
		t.Errorf("default version %q", version)
	}
}

// send and mcp attribute shares with the same token the file commands use:
// --token, then $MARKDROP_TOKEN, then the one saved by `markdrop login`.
func TestShareBlobUsesTheResolvedToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(files.ConfigDirEnv, filepath.Join(dir, "config"))
	t.Setenv(files.TokenEnv, "")
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := peer.SourceFromPath(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	tokenOf := func(blob string) *string {
		t.Helper()
		raw, err := base64.RawURLEncoding.DecodeString(blob)
		if err != nil {
			t.Fatalf("blob %q: %v", blob, err)
		}
		var p struct {
			T *string `json:"t"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		return p.T
	}

	if b := shareBlob(src, ""); b != "" {
		t.Fatalf("anonymous send should carry no blob, got %q", b)
	}
	if _, err := files.SaveToken("mdk_saved"); err != nil {
		t.Fatal(err)
	}
	if tok := tokenOf(shareBlob(src, "")); tok == nil || *tok != "mdk_saved" {
		t.Errorf("saved login token not used: %v", tok)
	}
	t.Setenv(files.TokenEnv, "mdk_env")
	if tok := tokenOf(shareBlob(src, "")); tok == nil || *tok != "mdk_env" {
		t.Errorf("MARKDROP_TOKEN should beat the saved token: %v", tok)
	}
	if tok := tokenOf(shareBlob(src, "mdk_flag")); tok == nil || *tok != "mdk_flag" {
		t.Errorf("--token should win: %v", tok)
	}
	if sendCmd.Flags().Lookup("token") == nil {
		t.Error("send has no --token flag")
	}
}

func TestMCPHelpListsEveryTool(t *testing.T) {
	for _, name := range []string{
		"upload_file", "replace_file", "list_file_versions", "restore_file_version", "get_file_info",
		"list_workspaces", "list_folders", "share_files", "share_status", "stop_share", "receive_share",
	} {
		if !strings.Contains(mcpCmd.Long, name) {
			t.Errorf("markdrop mcp --help doesn't list %s", name)
		}
	}
}
