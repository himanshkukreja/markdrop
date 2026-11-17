package cmd

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/files/fakeapi"
)

// tree writes files (relative path → size) under a temp folder.
func tree(t *testing.T, sizes map[string]int) string {
	t.Helper()
	root := t.TempDir()
	for rel, size := range sizes {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, size)
		_, _ = rand.Read(data)
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestUploadFolderIntoWorkspaceMirrorsSubfolders(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	root := tree(t, map[string]int{
		"q3.pdf": 1000, "demo.mp4": 3<<20 + 5, "specs/api.pdf": 2000, "specs/v2/deep.pdf": 10,
		".DS_Store": 10, ".git/config": 10,
	})
	stdout, stderr, err := e.run("upload", root, "--workspace", "Acme", "--folder", "guides")
	if err != nil {
		t.Fatal(err, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 4 {
		t.Fatalf("want 4 links, got %q", stdout)
	}
	var paths []string
	for _, l := range lines {
		url, rel, ok := strings.Cut(l, "\t")
		if !ok || !strings.HasPrefix(url, "https://") {
			t.Fatalf("line %q", l)
		}
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	if strings.Join(paths, ",") != "demo.mp4,q3.pdf,specs/api.pdf,specs/v2/deep.pdf" {
		t.Errorf("paths %v", paths)
	}
	// One create call, one complete call, for every file.
	if e.fake.BatchCreates != 1 || e.fake.BatchCompletes != 1 || e.fake.Creates != 4 {
		t.Errorf("batch creates %d, completes %d, creates %d", e.fake.BatchCreates, e.fake.BatchCompletes, e.fake.Creates)
	}
	if got := strings.Join(e.fake.FoldersMade, ","); got != "guides/specs,guides/specs/v2" {
		t.Errorf("folders made %q", got)
	}
	if d := e.fake.Doc("deep"); d == nil || d.FolderPath != "guides/specs/v2" {
		t.Errorf("deep.pdf filed in %+v", d)
	}
	if d := e.fake.Doc("q3"); d == nil || d.FolderPath != "guides" {
		t.Errorf("q3.pdf filed in %+v", d)
	}
	// No --access: the server's default (the folder's "new items start as") decides.
	if e.fake.LastCreate["access"] != nil {
		t.Errorf("access sent: %v", e.fake.LastCreate["access"])
	}
	if !strings.Contains(stderr, "Published 4 of 4") {
		t.Errorf("stderr %q", stderr)
	}
	// Again: the folders exist now, so none is made twice.
	if _, stderr, err := e.run("upload", root, "--workspace", "Acme", "--folder", "guides", "--access", "private"); err != nil {
		t.Fatal(err, stderr)
	}
	if len(e.fake.FoldersMade) != 2 || e.fake.LastCreate["access"] != "private" {
		t.Errorf("folders %v, access %v", e.fake.FoldersMade, e.fake.LastCreate["access"])
	}
}

func TestUploadFolderWithoutWorkspaceAndOneBadFile(t *testing.T) {
	e := setup(t)
	e.fake.MaxBytes = 5000
	root := tree(t, map[string]int{"a.pdf": 100, "sub/b.pdf": 200, "big.mp4": 6000})
	stdout, stderr, err := e.run("upload", root, "--json")
	if err == nil || !strings.Contains(err.Error(), "1 of 3 file(s) were not published") {
		t.Fatalf("err %v", err)
	}
	var res files.DirResult
	if err := json.NewDecoder(bytes.NewReader([]byte(stdout))).Decode(&res); err != nil {
		t.Fatalf("json %v: %q", err, stdout)
	}
	if res.Done != 2 || res.Failed != 1 {
		t.Errorf("result %+v", res)
	}
	for _, f := range res.Files {
		if (f.Path == "big.mp4") != (f.Error != "") {
			t.Errorf("file %+v", f)
		}
		if f.Path == "big.mp4" && !strings.Contains(f.Error, "too large") {
			t.Errorf("error %q", f.Error)
		}
	}
	if !strings.Contains(stderr, "need --workspace") {
		t.Errorf("no note about sub-folders: %q", stderr)
	}
}

func TestUploadFolderRefusesSingleFileFlags(t *testing.T) {
	e := setup(t)
	root := tree(t, map[string]int{"a.pdf": 10})
	if _, _, err := e.run("upload", root, "--slug", "abc"); err == nil || !strings.Contains(err.Error(), "single file") {
		t.Errorf("err %v", err)
	}
	if _, _, err := e.run("upload", root, "--folder", "x"); err == nil || !strings.Contains(err.Error(), "--folder needs --workspace") {
		t.Errorf("err %v", err)
	}
}

func TestListDirSkipsHidden(t *testing.T) {
	root := tree(t, map[string]int{"b.pdf": 1, "a/c.pdf": 1, ".env": 1, "a/.cache/x": 1})
	got, err := files.ListDir(root)
	if err != nil || strings.Join(got, ",") != "a/c.pdf,b.pdf" {
		t.Errorf("ListDir %v %v", got, err)
	}
}

func TestUploadFolderResumesOpenSessions(t *testing.T) {
	e := setup(t)
	root := tree(t, map[string]int{"a.pdf": 100, "b.pdf": 3<<20 + 1})
	// A run that opened the uploads and died before sending anything.
	c := &files.Client{Base: e.fake.URL, Token: fakeapi.Token}
	var reqs []files.CreateUploadRequest
	for _, n := range []string{"a.pdf", "b.pdf"} {
		sum, _ := files.SHA256File(filepath.Join(root, n))
		fi, _ := os.Stat(filepath.Join(root, n))
		reqs = append(reqs, files.CreateUploadRequest{FileName: n, SizeBytes: fi.Size(), SHA256: sum,
			ContentType: "application/pdf"})
	}
	if _, err := c.CreateUploads(t.Context(), reqs); err != nil {
		t.Fatal(err)
	}
	before := len(e.fake.SessionIDs())
	stdout, stderr, err := e.run("upload", root)
	if err != nil {
		t.Fatal(err, stderr)
	}
	if strings.Count(stdout, "\n") != 2 || len(e.fake.SessionIDs()) != before {
		t.Errorf("stdout %q, sessions %d → %d", stdout, before, len(e.fake.SessionIDs()))
	}
	if !strings.Contains(stderr, "Resuming the upload") {
		t.Errorf("stderr %q", stderr)
	}
}
