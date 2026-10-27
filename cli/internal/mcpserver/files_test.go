package mcpserver

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/files/fakeapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type filesEnv struct {
	fake     *fakeapi.Server
	home     string
	stateDir string
	mgr      *Manager
}

func newFilesEnv(t *testing.T, token string) *filesEnv {
	t.Helper()
	f := fakeapi.New()
	t.Cleanup(f.Close)
	g, home := fakeHome(t)
	e := &filesEnv{fake: f, home: home, stateDir: filepath.Join(t.TempDir(), "uploads")}
	var w io.Writer = io.Discard
	if testing.Verbose() {
		w = os.Stderr
	}
	e.mgr = NewManager(Config{
		Server: f.URL, ShareURL: func(id string) string { return "http://localhost:3000/share/" + id },
		Guard: g, Downloads: t.TempDir(), Log: log.New(w, "mcp: ", log.Lmicroseconds),
		FilesToken: token, UserAgent: "markdrop-cli/test (mcp)",
		NewUploader: func(c *files.Client) *files.Uploader {
			c.Attempts, c.Backoff = 2, time.Millisecond
			return &files.Uploader{Client: c, StateDir: e.stateDir, Backoff: time.Millisecond,
				PollInterval: 5 * time.Millisecond, ProgressTick: 5 * time.Millisecond}
		},
	})
	t.Cleanup(func() { e.mgr.Shutdown(time.Second) })
	return e
}

func (e *filesEnv) file(t *testing.T, rel string, size int) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	_, _ = rand.Read(data)
	p := filepath.Join(e.home, rel)
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

// connectWithProgress connects a client that records progress notifications.
func connectWithProgress(t *testing.T, m *Manager) (*mcp.ClientSession, func() []*mcp.ProgressNotificationParams) {
	t.Helper()
	var mu sync.Mutex
	var got []*mcp.ProgressNotificationParams
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	ss, err := NewServer(m, "0.4.0-test").Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
			mu.Lock()
			got = append(got, req.Params)
			mu.Unlock()
		},
	}).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs, func() []*mcp.ProgressNotificationParams {
		mu.Lock()
		defer mu.Unlock()
		return append([]*mcp.ProgressNotificationParams(nil), got...)
	}
}

func callWithProgress(t *testing.T, ctx context.Context, cs *mcp.ClientSession, name string, args any, token any) (*mcp.CallToolResult, map[string]any, error) {
	t.Helper()
	p := &mcp.CallToolParams{Name: name, Arguments: args}
	if token != nil {
		p.SetProgressToken(token)
	}
	res, err := cs.CallTool(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	var out map[string]any
	if res.StructuredContent != nil {
		b, _ := json.Marshal(res.StructuredContent)
		_ = json.Unmarshal(b, &out)
	}
	return res, out, nil
}

func TestFileToolsEndToEnd(t *testing.T) {
	e := newFilesEnv(t, fakeapi.Token)
	e.fake.PartHook = func(string, int, int) int { time.Sleep(120 * time.Millisecond); return 0 }
	cs, progress := connectWithProgress(t, e.mgr)
	path, data := e.file(t, "Movies/Launch Demo.mp4", 6<<20+99)

	res, out, err := callWithProgress(t, context.Background(), cs, "upload_file",
		map[string]any{"path": "~/Movies/Launch Demo.mp4", "title": "Launch", "access": "private"}, "up-1")
	if err != nil || res.IsError {
		t.Fatalf("upload_file: %v %s", err, resultText(res))
	}
	sum, _ := files.SHA256File(path)
	if out["url"] != e.fake.WebBase+"/launch-demo" || out["slug"] != "launch-demo" || out["version"] != 1.0 ||
		out["size_bytes"] != float64(len(data)) || out["sha256"] != sum || len(out) != 5 {
		t.Errorf("upload_file output %v", out)
	}
	if !strings.Contains(resultText(res), "Published launch-demo") || !strings.Contains(resultText(res), "replace_file") {
		t.Errorf("text %q", resultText(res))
	}
	if e.fake.LastCreate["access"] != "private" || e.fake.LastCreate["title"] != "Launch" {
		t.Errorf("create %v", e.fake.LastCreate)
	}

	// Progress: bytes, total = file size, strictly increasing, ends at the total.
	notes := progress()
	if len(notes) < 3 {
		t.Fatalf("only %d progress notifications", len(notes))
	}
	prev := -1.0
	sawUploading := false
	for _, n := range notes {
		if n.ProgressToken != "up-1" || n.Total != float64(len(data)) || n.Progress <= prev {
			t.Errorf("bad notification %+v (previous %v)", n, prev)
		}
		prev = n.Progress
		sawUploading = sawUploading || strings.HasPrefix(n.Message, "Uploading Launch Demo.mp4:")
	}
	if !sawUploading || notes[0].Message != "Checking Launch Demo.mp4 (6.0 MB)…" ||
		notes[len(notes)-1].Progress != float64(len(data)) || !strings.HasPrefix(notes[len(notes)-1].Message, "Verifying") {
		t.Errorf("notifications %+v … %+v", notes[0], notes[len(notes)-1])
	}

	// replace_file keeps the link and makes a version.
	e.fake.Lock()
	e.fake.PartHook = nil
	e.fake.Unlock()
	newPath, newData := e.file(t, "Movies/v2.mp4", 1<<20)
	res, out, err = callWithProgress(t, context.Background(), cs, "replace_file",
		map[string]any{"document": "https://markdrop.in/launch-demo", "path": newPath}, nil)
	if err != nil || res.IsError {
		t.Fatalf("replace_file: %v %s", err, resultText(res))
	}
	if out["url"] != e.fake.WebBase+"/launch-demo" || out["version"] != 2.0 || out["size_bytes"] != float64(len(newData)) {
		t.Errorf("replace output %v", out)
	}
	if !strings.Contains(resultText(res), "unchanged") || !bytes.Equal(e.fake.CurrentData("launch-demo"), newData) {
		t.Errorf("replace text %q", resultText(res))
	}
	if len(progress()) != len(notes) {
		t.Error("progress sent without a progress token")
	}

	res, out, _ = callWithProgress(t, context.Background(), cs, "list_file_versions", map[string]any{"document": "launch-demo"}, nil)
	vs, _ := out["versions"].([]any)
	if res.IsError || out["slug"] != "launch-demo" || len(vs) != 2 || vs[0].(map[string]any)["current"] != true {
		t.Fatalf("list_file_versions %v %s", out, resultText(res))
	}
	if !strings.Contains(resultText(res), "version 2 (current)") {
		t.Errorf("versions text %q", resultText(res))
	}

	res, out, _ = callWithProgress(t, context.Background(), cs, "restore_file_version",
		map[string]any{"document": "launch-demo", "version": 1}, nil)
	if res.IsError || out["version"] != 3.0 || out["slug"] != "launch-demo" || !bytes.Equal(e.fake.CurrentData("launch-demo"), data) {
		t.Fatalf("restore %v %s", out, resultText(res))
	}

	res, out, _ = callWithProgress(t, context.Background(), cs, "get_file_info", map[string]any{"document": "launch-demo"}, nil)
	media, _ := out["media"].(map[string]any)
	if res.IsError || out["version"] != 3.0 || media["width"] != 640.0 || out["poster_url"] == nil || out["sha256"] != sum {
		t.Fatalf("get_file_info %v %s", out, resultText(res))
	}
	if !strings.Contains(resultText(res), "640×360") {
		t.Errorf("info text %q", resultText(res))
	}
	// A file without media info: nullable fields come back as null and still
	// satisfy the output schema.
	e.fake.AddDoc("deck", fakeapi.Token, "artifact", []byte("%PDF"), "application/pdf")
	res, out, _ = callWithProgress(t, context.Background(), cs, "get_file_info", map[string]any{"document": "deck"}, nil)
	if res.IsError || out["media"] != nil || out["poster_url"] != nil {
		t.Fatalf("pdf info %v %s", out, resultText(res))
	}
}

func TestFileToolErrors(t *testing.T) {
	e := newFilesEnv(t, fakeapi.Token)
	e.fake.AddDoc("theirs", fakeapi.OtherToken, "artifact", []byte("x"), "video/mp4")
	e.fake.AddDoc("notes", fakeapi.Token, "markdown", []byte("# n"), "text/markdown")
	e.fake.AddDoc("mine", fakeapi.Token, "artifact", []byte("orig"), "video/mp4")
	cs, _ := connectWithProgress(t, e.mgr)
	e.file(t, "Movies/ok.mp4", 2000)

	check := func(name string, args map[string]any, want string) {
		t.Helper()
		res, _, err := callWithProgress(t, context.Background(), cs, name, args, nil)
		if err != nil {
			t.Fatalf("%s: protocol error %v", name, err)
		}
		if !res.IsError || !strings.Contains(resultText(res), want) {
			t.Errorf("%s %v: %v %q, want error with %q", name, args, res.IsError, resultText(res), want)
		}
	}
	check("upload_file", map[string]any{"path": "~/.ssh/id_ed25519"}, "refused to upload")
	check("upload_file", map[string]any{"path": "~/work/app/.env"}, "refused to upload")
	check("upload_file", map[string]any{"path": "~/work/clean"}, "is a folder")
	check("upload_file", map[string]any{"path": "~/missing.mp4"}, "cannot access")
	check("upload_file", map[string]any{"path": "~/Movies/ok.mp4", "access": "public"}, "")
	check("upload_file", map[string]any{"path": "~/Movies/ok.mp4", "access": "password"}, "needs a password")
	check("replace_file", map[string]any{"document": "theirs", "path": "~/Movies/ok.mp4"}, "You don't own this document")
	check("replace_file", map[string]any{"document": "notes", "path": "~/Movies/ok.mp4"}, "markdown document; use update_document")
	check("replace_file", map[string]any{"document": "https://markdrop.in/share/abcdef1234", "path": "~/Movies/ok.mp4"}, "peer-to-peer share link")
	check("list_file_versions", map[string]any{"document": "theirs"}, "not allowed")
	check("restore_file_version", map[string]any{"document": "mine", "version": 0}, "")
	check("restore_file_version", map[string]any{"document": "mine", "version": 9}, "Version 9 not found")
	check("get_file_info", map[string]any{"document": "nope"}, "not found")
	if e.fake.TotalPuts() != 0 {
		t.Error("parts sent despite errors")
	}

	e.fake.Lock()
	e.fake.Corrupt = true
	e.fake.Unlock()
	check("replace_file", map[string]any{"document": "mine", "path": "~/Movies/ok.mp4"}, "sha256 mismatch")
	if string(e.fake.CurrentData("mine")) != "orig" {
		t.Error("a failed verification changed the document")
	}

	// No token: a clear tool error, nothing sent.
	noTok := newFilesEnv(t, "")
	cs2, _ := connectWithProgress(t, noTok.mgr)
	noTok.file(t, "a.mp4", 10)
	for _, c := range []struct {
		name string
		args map[string]any
	}{
		{"upload_file", map[string]any{"path": "~/a.mp4"}},
		{"get_file_info", map[string]any{"document": "x"}},
	} {
		res, _, _ := callWithProgress(t, context.Background(), cs2, c.name, c.args, nil)
		if !res.IsError || !strings.Contains(resultText(res), "MARKDROP_TOKEN") || !strings.Contains(resultText(res), files.TokensURL) {
			t.Errorf("%s without token: %q", c.name, resultText(res))
		}
	}
	if noTok.fake.Creates != 0 {
		t.Error("request sent without a token")
	}
}

// A long upload doesn't hold up other tool calls, and a cancelled call
// resumes when it is made again.
func TestUploadDoesNotBlockAndResumesAfterCancel(t *testing.T) {
	e := newFilesEnv(t, fakeapi.Token)
	e.fake.AddDoc("mine", fakeapi.Token, "artifact", []byte("orig"), "video/mp4")
	cs, _ := connectWithProgress(t, e.mgr)
	e.file(t, "big.mp4", 8<<20)

	hold := make(chan struct{})
	var once sync.Once
	started := make(chan struct{})
	e.fake.PartHook = func(_ string, n, _ int) int {
		if _, stored := e.fake.Counts(); len(stored) >= 2 {
			once.Do(func() { close(started) })
			<-hold
		}
		return 0
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := callWithProgress(t, ctx, cs, "upload_file", map[string]any{"path": "~/big.mp4"}, "p")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("upload never started")
	}
	// Other calls answer while the upload is stuck mid-transfer.
	qctx, qcancel := context.WithTimeout(context.Background(), 5*time.Second)
	res, out, err := callWithProgress(t, qctx, cs, "get_file_info", map[string]any{"document": "mine"}, nil)
	qcancel()
	if err != nil || res.IsError || out["slug"] != "mine" {
		t.Fatalf("get_file_info during an upload: %v %v", err, out)
	}
	res, _, err = callWithProgress(t, context.Background(), cs, "share_status", map[string]any{}, nil)
	if err != nil || res.IsError {
		t.Fatalf("share_status during an upload: %v", err)
	}

	cancel() // the client gives up on the call
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled call never returned")
	}
	close(hold)
	// The server-side upload stops: no new parts start, the session stays
	// open on the server and remembered locally.
	if !e.fake.Quiesce(10 * time.Second) {
		t.Fatal("part handlers still running")
	}
	sent := e.fake.TotalPuts()
	time.Sleep(100 * time.Millisecond)
	if !e.fake.Quiesce(10*time.Second) || e.fake.TotalPuts() != sent {
		t.Fatal("the cancelled upload kept sending parts")
	}
	if m, _ := filepath.Glob(filepath.Join(e.stateDir, "*.json")); len(m) != 1 || e.fake.Completes != 0 {
		t.Fatalf("state %v, completes %d", m, e.fake.Completes)
	}
	_, before := e.fake.Counts()
	e.fake.Lock()
	e.fake.PartHook = nil
	e.fake.Unlock()
	e.fake.ResetCounts()

	res, out, err = callWithProgress(t, context.Background(), cs, "upload_file", map[string]any{"path": "~/big.mp4"}, nil)
	if err != nil || res.IsError {
		t.Fatalf("resume: %v %s", err, resultText(res))
	}
	puts, _ := e.fake.Counts()
	for n := range puts {
		if before[n] > 0 {
			t.Errorf("part %d was sent again after the resume", n)
		}
	}
	if e.fake.Creates != 0 || len(puts) != 8-len(before) {
		t.Errorf("creates %d, resumed puts %v, stored before %v", e.fake.Creates, puts, before)
	}
	if out["slug"] != "big" {
		t.Errorf("out %v", out)
	}
}
