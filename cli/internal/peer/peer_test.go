package peer

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/markdrop/cli/internal/signaling/sigtest"
)

// Fixtures produced by the browser's encodeShareMeta (frontend/src/lib/webrtc.ts)
// run under Node with the same inputs.
func TestEncodeShareMetaMatchesBrowser(t *testing.T) {
	got := EncodeShareMeta(ShareMeta{Name: "résumé <final> & co.pdf", Size: 12345, Mime: "application/pdf", Token: "mdk_abc123", Count: 1})
	want := "eyJuIjoicsOpc3Vtw6kgPGZpbmFsPiAmIGNvLnBkZiIsInMiOjEyMzQ1LCJtIjoiYXBwbGljYXRpb24vcGRmIiwidCI6Im1ka19hYmMxMjMiLCJjIjoxfQ"
	if got != want {
		t.Fatalf("blob mismatch\n got %s\nwant %s", got, want)
	}
	got = EncodeShareMeta(ShareMeta{Name: "markdrop-files.zip", Size: 0, Mime: "application/zip", Count: 3})
	want = "eyJuIjoibWFya2Ryb3AtZmlsZXMuemlwIiwicyI6MCwibSI6ImFwcGxpY2F0aW9uL3ppcCIsInQiOm51bGwsImMiOjN9"
	if got != want {
		t.Fatalf("anonymous blob mismatch\n got %s\nwant %s", got, want)
	}
	// And it decodes the way share_event.decode_blob does.
	raw, err := base64.RawURLEncoding.DecodeString(got)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m["t"] != nil || m["c"].(float64) != 3 {
		t.Fatalf("decoded %v %v", m, err)
	}
}

func TestSafeFileName(t *testing.T) {
	cases := []struct {
		in    string
		nodot bool
		want  string
	}{
		{"report.pdf", false, "report.pdf"},
		{"../../.bashrc", false, ".bashrc"},
		{"../../.bashrc", true, "bashrc"},
		{`..\..\evil.exe`, false, "evil.exe"},
		{"/etc/passwd", false, "passwd"},
		{"..", false, "download"},
		{"", false, "download"},
		{"...", true, "download"},
		{".ssh", true, "ssh"},
		{"a\x00b\nc", false, "a_b_c"},
	}
	for _, c := range cases {
		if got := SafeFileName(c.in, c.nodot); got != c.want {
			t.Errorf("SafeFileName(%q,%v) = %q, want %q", c.in, c.nodot, got, c.want)
		}
	}
}

func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if UniquePath(p) != p {
		t.Fatal("free path changed")
	}
	os.WriteFile(p, nil, 0o644)
	if got := UniquePath(p); got != filepath.Join(dir, "a (1).txt") {
		t.Fatalf("got %s", got)
	}
	os.WriteFile(filepath.Join(dir, "a (1).txt"), nil, 0o644)
	if got := UniquePath(p); got != filepath.Join(dir, "a (2).txt") {
		t.Fatalf("got %s", got)
	}
	tgz := filepath.Join(dir, "x.tar.gz")
	os.WriteFile(tgz, nil, 0o644)
	if got := UniquePath(tgz); got != filepath.Join(dir, "x (1).tar.gz") {
		t.Fatalf("got %s", got)
	}
}

func zipNames(t *testing.T, path string) []string {
	t.Helper()
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var names []string
	for _, f := range r.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

func TestSourceFromPaths(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) string {
		p := filepath.Join(dir, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	f1 := write("one/readme.md", "hello")
	write("one/sub/x.txt", "x")
	f2 := write("two/readme.md", "second readme")
	folder := filepath.Join(dir, "one")
	os.Symlink(filepath.Join(dir, "two"), filepath.Join(folder, "link-to-dir"))
	os.Symlink(f2, filepath.Join(folder, "link-to-file.md"))
	if err := mkfifo(filepath.Join(folder, "pipe")); err != nil {
		t.Logf("mkfifo: %v", err)
	}

	// One file: as-is.
	s, err := SourceFromPaths([]string{f1})
	if err != nil {
		t.Fatal(err)
	}
	if s.IsFolder || s.Name != "readme.md" || s.Size != 5 || s.FileCount != 1 || s.MimeType == "" {
		t.Fatalf("single file source: %+v", s)
	}
	s.Close()

	// One folder: <folder>.zip with the folder on top; symlinked file
	// followed, symlinked folder and the pipe skipped.
	s, err = SourceFromPaths([]string{folder})
	if err != nil {
		t.Fatal(err)
	}
	if !s.IsFolder || s.Name != "one.zip" || s.FileCount != 3 || s.MimeType != "application/zip" {
		t.Fatalf("folder source: %+v", s)
	}
	names := zipNames(t, s.Path)
	want := []string{"one/", "one/link-to-file.md", "one/readme.md", "one/sub/", "one/sub/x.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("folder zip entries %v, want %v", names, want)
	}
	tmp := s.Path
	s.Close()
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatal("temp zip not removed on Close")
	}

	// Several paths: markdrop-files.zip, clashing names made unique.
	s, err = SourceFromPaths([]string{f1, f2, filepath.Join(dir, "one", "sub")})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Name != "markdrop-files.zip" || !s.IsFolder || s.FileCount != 3 || s.FirstName != "readme.md" {
		t.Fatalf("multi source: %+v", s)
	}
	names = zipNames(t, s.Path)
	want = []string{"markdrop-files/readme (2).md", "markdrop-files/readme.md", "markdrop-files/sub/", "markdrop-files/sub/x.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("multi zip entries %v, want %v", names, want)
	}

	if _, err := SourceFromPaths([]string{filepath.Join(dir, "missing")}); err == nil {
		t.Fatal("missing path accepted")
	}
}

func makeZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "in.zip")
	f, _ := os.Create(p)
	zw := zip.NewWriter(f)
	keys := make([]string, 0, len(entries))
	for k := range entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		w, _ := zw.Create(k)
		w.Write([]byte(entries[k]))
	}
	zw.Close()
	f.Close()
	return p
}

func TestExtractRefusesZipSlip(t *testing.T) {
	for _, bad := range []string{"../escape.txt", "a/../../escape.txt", "/abs/x"} {
		z := makeZip(t, map[string]string{bad: "x"})
		dest := t.TempDir()
		_, err := extract(z, dest)
		if bad == "/abs/x" {
			// Joined under dest; must not escape.
			if err == nil {
				if _, serr := os.Stat(filepath.Join(dest, "abs", "x")); serr != nil {
					t.Fatalf("absolute entry handled oddly: %v", serr)
				}
			}
			continue
		}
		if err == nil {
			t.Fatalf("zip-slip entry %q extracted", bad)
		}
	}
}

func TestUnzipFreshNeverOverwrites(t *testing.T) {
	dest := t.TempDir()
	os.MkdirAll(filepath.Join(dest, "markdrop-files"), 0o755)
	os.WriteFile(filepath.Join(dest, "markdrop-files", "keep.txt"), []byte("mine"), 0o644)
	z := makeZip(t, map[string]string{
		"markdrop-files/keep.txt": "theirs",
		".bashrc":                 "evil",
	})
	saved, err := unzipFresh(z, dest, true)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "markdrop-files", "keep.txt")); string(b) != "mine" {
		t.Fatal("existing file overwritten")
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "markdrop-files (1)", "keep.txt")); string(b) != "theirs" {
		t.Fatalf("new folder not placed beside: %v", saved)
	}
	if _, err := os.Stat(filepath.Join(dest, ".bashrc")); err == nil {
		t.Fatal("dotfile planted")
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "bashrc")); string(b) != "evil" {
		t.Fatalf("dotfile not renamed: %v", saved)
	}
	entries, _ := os.ReadDir(dest)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".markdrop-extract") {
			t.Fatal("scratch folder left behind")
		}
	}
}

// TestTransferOverRelay runs a real WebRTC transfer (loopback) through the
// test relay: host serves, guest receives, bytes match; then a second
// recipient on the same room gets it too.
func TestTransferOverRelay(t *testing.T) {
	if testing.Short() {
		t.Skip("webrtc transfer")
	}
	relay := sigtest.New()
	defer relay.Close()

	dir := t.TempDir()
	payload := make([]byte, 3*1024*1024+17)
	rand.Read(payload)
	src := filepath.Join(dir, "payload.bin")
	os.WriteFile(src, payload, 0o644)
	source, err := SourceFromPath(src)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	host, err := signaling.Dial(ctx, signaling.Options{Server: relay.URL, Room: "relaytest1", Role: "host", HostKey: "0123456789abcdef0123456789abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	blob := EncodeShareMeta(ShareMeta{Name: source.Name, Size: source.Size, Mime: source.MimeType, Token: "mdk_x", Count: 1})
	serve := func() chan error {
		ch := make(chan error, 1)
		go func() {
			for raw := range host.Messages() {
				if strings.Contains(string(raw), "guest-joined") {
					break
				}
			}
			ch <- ServeOne(ctx, host, source, HostOptions{Blob: blob})
		}()
		return ch
	}

	for round := 1; round <= 2; round++ {
		served := serve()
		out := t.TempDir()
		if round == 2 {
			os.WriteFile(filepath.Join(out, "payload.bin"), []byte("existing"), 0o644)
		}
		guest, err := signaling.Dial(ctx, signaling.Options{Server: relay.URL, Room: "relaytest1", Role: "guest"})
		if err != nil {
			t.Fatal(err)
		}
		res, err := Receive(ctx, guest, GuestOptions{OutputDir: out, NoOverwrite: true, NoDotfiles: true})
		guest.Close()
		if err != nil {
			t.Fatalf("round %d receive: %v", round, err)
		}
		if err := <-served; err != nil {
			t.Fatalf("round %d serve: %v", round, err)
		}
		if len(res.Saved) != 1 {
			t.Fatalf("saved %v", res.Saved)
		}
		got, _ := os.ReadFile(res.Saved[0])
		if !bytes.Equal(got, payload) {
			t.Fatalf("round %d: bytes differ (%d vs %d)", round, len(got), len(payload))
		}
		if round == 2 && filepath.Base(res.Saved[0]) != "payload (1).bin" {
			t.Fatalf("round 2 overwrote or misnamed: %s", res.Saved[0])
		}
	}
	offers := relay.OfferList()
	if len(offers) == 0 || !strings.Contains(string(offers[0]), `"x":"`+blob+`"`) {
		t.Fatalf("offer did not carry the blob")
	}
}
