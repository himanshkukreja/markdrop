package cmd

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/files/fakeapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"
)

// cliArgsEnv makes the test binary act as the markdrop CLI (for tests that
// need a real process: exit codes, kill -9 mid-upload).
const cliArgsEnv = "MARKDROP_TEST_CLI_ARGS"

func TestMain(m *testing.M) {
	if raw := os.Getenv(cliArgsEnv); raw != "" {
		var args []string
		if err := json.Unmarshal([]byte(raw), &args); err != nil {
			panic(err)
		}
		rootCmd.SetArgs(args)
		if err := rootCmd.Execute(); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type cliEnv struct {
	t        *testing.T
	fake     *fakeapi.Server
	stateDir string
}

// setup isolates the token, config and cache folders and points the file
// commands at a fake API.
func setup(t *testing.T) *cliEnv {
	t.Helper()
	f := fakeapi.New()
	t.Cleanup(f.Close)
	dir := t.TempDir()
	t.Setenv(files.TokenEnv, fakeapi.Token)
	t.Setenv(files.ConfigDirEnv, filepath.Join(dir, "config"))
	t.Setenv(files.CacheDirEnv, filepath.Join(dir, "cache"))
	e := &cliEnv{t: t, fake: f, stateDir: filepath.Join(dir, "cache", "uploads")}
	oldUp, oldTTY := newUploader, stderrIsTTY
	newUploader = func(c *files.Client) *files.Uploader {
		c.Attempts, c.Backoff = 2, time.Millisecond
		return &files.Uploader{Client: c, StateDir: e.stateDir, Backoff: time.Millisecond,
			PollInterval: 5 * time.Millisecond, ProgressTick: 2 * time.Millisecond}
	}
	stderrIsTTY = func(io.Writer) bool { return false }
	t.Cleanup(func() { newUploader, stderrIsTTY = oldUp, oldTTY })
	return e
}

// run executes a fresh markdrop root with args against the fake.
func (e *cliEnv) run(args ...string) (stdout, stderr string, err error) {
	root := &cobra.Command{Use: "markdrop", SilenceUsage: true, SilenceErrors: true}
	old := flagServer
	defer func() { flagServer = old }()
	root.PersistentFlags().StringVar(&flagServer, "server", defaultServer, "")
	addFileCommands(root)
	var out, errb bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errb)
	root.SetIn(strings.NewReader(""))
	root.SetArgs(append(args, "--server", e.fake.URL))
	err = root.ExecuteContext(context.Background())
	return out.String(), errb.String(), err
}

func randomFile(t *testing.T, name string, size int) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	_, _ = rand.Read(data)
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

// oneJSONObject asserts stdout is exactly one JSON object and nothing else.
func oneJSONObject(t *testing.T, stdout string) map[string]any {
	t.Helper()
	if strings.Count(stdout, "\n") != 1 || !strings.HasSuffix(stdout, "}\n") || !strings.HasPrefix(stdout, "{") {
		t.Fatalf("stdout is not exactly one JSON line: %q", stdout)
	}
	dec := json.NewDecoder(strings.NewReader(stdout))
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil {
		t.Fatalf("stdout JSON: %v (%q)", err, stdout)
	}
	if _, err := dec.Token(); err != io.EOF {
		t.Fatalf("more than one JSON value on stdout: %q", stdout)
	}
	return obj
}

func TestUploadJSONIsOneObject(t *testing.T) {
	e := setup(t)
	path, data := randomFile(t, "Launch Video.mp4", 3<<20+7)
	stdout, stderr, err := e.run("upload", path, "--title", "Launch", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj := oneJSONObject(t, stdout)
	sum, _ := files.SHA256File(path)
	if obj["slug"] != "launch-video" || obj["url"] != e.fake.WebBase+"/launch-video" || obj["version"] != 1.0 ||
		obj["size_bytes"] != float64(len(data)) || obj["sha256"] != sum || obj["content_type"] != "video/mp4" {
		t.Errorf("result %v", obj)
	}
	if strings.Contains(stderr, "\r") || strings.Contains(stderr, "Uploading") || strings.Contains(stderr, "Hashing") {
		t.Errorf("progress drawn without a terminal: %q", stderr)
	}
	if e.fake.LastCreate["title"] != "Launch" || e.fake.LastCreate["access"] != nil {
		t.Errorf("create %v", e.fake.LastCreate)
	}
}

func TestUploadHumanOutput(t *testing.T) {
	e := setup(t)
	path, _ := randomFile(t, "notes.pdf", 1000)
	stdout, stderr, err := e.run("upload", path, "--password", "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if stdout != e.fake.WebBase+"/notes\n" {
		t.Errorf("stdout %q", stdout)
	}
	if !strings.Contains(stderr, "✓ Published notes") {
		t.Errorf("stderr %q", stderr)
	}
	if e.fake.LastCreate["access"] != "password" || e.fake.LastCreate["password"] != "s3cret" {
		t.Errorf("create %v", e.fake.LastCreate)
	}
	for _, bad := range [][]string{
		{"upload", path, "--access", "public"},
		{"upload", path, "--access", "password"},
		{"upload", path, "--access", "workspace"},
	} {
		if _, _, err := e.run(bad...); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestProgressOnlyOnATerminal(t *testing.T) {
	e := setup(t)
	stderrIsTTY = func(io.Writer) bool { return true }
	e.fake.PartHook = func(string, int, int) int { time.Sleep(10 * time.Millisecond); return 0 }
	path, _ := randomFile(t, "p.mp4", 4<<20)
	stdout, stderr, err := e.run("upload", path, "--json")
	if err != nil {
		t.Fatal(err)
	}
	oneJSONObject(t, stdout) // progress never reaches stdout
	for _, want := range []string{"\r\033[K  Hashing", "\r\033[K  Uploading [", "100%", "Verifying p.mp4 on the server"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr lacks %q: %q", want, stderr)
		}
	}
	if !strings.HasSuffix(stderr, "\r\033[K") {
		t.Errorf("progress line not cleared at the end: %q", stderr[max(0, len(stderr)-40):])
	}
}

func TestReplaceVersionsRestoreInfo(t *testing.T) {
	e := setup(t)
	e.fake.AddDoc("demo-clip", fakeapi.Token, "artifact", []byte("v1 bytes"), "video/mp4")
	path, data := randomFile(t, "v2.mp4", 2<<20)

	stdout, stderr, err := e.run("replace", "https://www.markdrop.in/demo-clip", path)
	if err != nil {
		t.Fatal(err, stderr)
	}
	if stdout != e.fake.WebBase+"/demo-clip\nversion 2\n" || !strings.Contains(stderr, "Replaced demo-clip — version 2") {
		t.Errorf("replace: %q / %q", stdout, stderr)
	}
	if !bytes.Equal(e.fake.CurrentData("demo-clip"), data) {
		t.Error("replace didn't swap the bytes")
	}

	stdout, _, err = e.run("versions", "demo-clip", "--json")
	if err != nil {
		t.Fatal(err)
	}
	vs := oneJSONObject(t, stdout)["versions"].([]any)
	if len(vs) != 2 || vs[0].(map[string]any)["current"] != true || vs[0].(map[string]any)["version"] != 2.0 {
		t.Errorf("versions %v", vs)
	}
	stdout, _, err = e.run("versions", "http://localhost:3000/demo-clip")
	if err != nil || !strings.Contains(stdout, "VERSION") || !strings.Contains(stdout, "* 2") || !strings.Contains(stdout, "  1") {
		t.Errorf("versions table %q %v", stdout, err)
	}

	stdout, stderr, err = e.run("restore", "demo-clip", "1")
	if err != nil || stdout != e.fake.WebBase+"/demo-clip\nversion 3\n" || !strings.Contains(stderr, "Restored version 1") {
		t.Errorf("restore %q %q %v", stdout, stderr, err)
	}
	if string(e.fake.CurrentData("demo-clip")) != "v1 bytes" {
		t.Error("restore didn't bring v1 back")
	}
	stdout, _, err = e.run("restore", "demo-clip", "v2", "--json")
	if err != nil || oneJSONObject(t, stdout)["version"] != 4.0 {
		t.Errorf("restore --json %q %v", stdout, err)
	}

	stdout, _, err = e.run("info", "demo-clip", "--json")
	if err != nil {
		t.Fatal(err)
	}
	info := oneJSONObject(t, stdout)
	if info["slug"] != "demo-clip" || info["version"] != 4.0 || info["media"] == nil || info["poster_url"] == nil {
		t.Errorf("info %v", info)
	}
	stdout, _, err = e.run("info", "demo-clip")
	if err != nil || !strings.Contains(stdout, "640×360 · 2s · h264") || !strings.HasPrefix(stdout, e.fake.WebBase+"/demo-clip\n") {
		t.Errorf("info %q %v", stdout, err)
	}
}

func TestErrorsAreClearAndStdoutEmpty(t *testing.T) {
	e := setup(t)
	e.fake.AddDoc("theirs", fakeapi.OtherToken, "artifact", []byte("x"), "video/mp4")
	e.fake.AddDoc("notes", fakeapi.Token, "markdown", []byte("# x"), "text/markdown")
	path, _ := randomFile(t, "e.mp4", 100)
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"replace", "theirs", path, "--json"}, "not allowed to start the upload: You don't own this document"},
		{[]string{"replace", "notes", path, "--json"}, "notes is a markdown document; use update_document"},
		{[]string{"versions", "theirs", "--json"}, "You don't own this document"},
		{[]string{"restore", "notes", "1"}, "markdown document"},
		{[]string{"info", "nope"}, "not found"},
		{[]string{"restore", "theirs", "zero"}, "not a version number"},
		{[]string{"replace", "https://markdrop.in/share/abcdef1234", path}, "peer-to-peer share link"},
		{[]string{"upload", path, "--token", "mdk_wrong"}, "token was rejected"},
	}
	for _, c := range cases {
		stdout, _, err := e.run(c.args...)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: err %v, want %q", c.args, err, c.want)
		}
		if stdout != "" {
			t.Errorf("%v: stdout %q", c.args, stdout)
		}
	}
	t.Setenv(files.TokenEnv, "")
	_, _, err := e.run("upload", path)
	if !errors.Is(err, files.ErrNoToken) || !strings.Contains(err.Error(), "https://markdrop.in/settings/tokens") {
		t.Errorf("no token: %v", err)
	}
	if e.fake.TotalPuts() != 0 {
		t.Error("parts sent despite errors")
	}
}

func TestShaMismatchFailsAndChangesNothing(t *testing.T) {
	e := setup(t)
	e.fake.Corrupt = true
	e.fake.AddDoc("clip", fakeapi.Token, "artifact", []byte("original"), "video/mp4")
	path, _ := randomFile(t, "n.mp4", 1<<20)
	stdout, _, err := e.run("replace", "clip", path, "--json")
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") || !strings.Contains(err.Error(), "Nothing was changed") {
		t.Fatalf("err %v", err)
	}
	if stdout != "" || string(e.fake.CurrentData("clip")) != "original" || len(e.fake.Doc("clip").Versions) != 1 {
		t.Errorf("stdout %q / document changed", stdout)
	}
}

func TestVerifyingIsPolledByTheCommand(t *testing.T) {
	e := setup(t)
	e.fake.VerifyPolls = 2
	path, _ := randomFile(t, "slow.mp4", 1<<20)
	stdout, _, err := e.run("upload", path, "--json")
	if err != nil || oneJSONObject(t, stdout)["slug"] != "slow" {
		t.Fatalf("%q %v", stdout, err)
	}
	if e.fake.StatusGets != 3 {
		t.Errorf("polls %d", e.fake.StatusGets)
	}
}

func TestLoginStoresTokenPrivately(t *testing.T) {
	e := setup(t)
	t.Setenv(files.TokenEnv, "")
	if _, _, err := e.run("login", "--token", "mdk_wrong"); err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("bad token accepted: %v", err)
	}
	if tok, _ := files.LoadToken(); tok != "" {
		t.Fatal("rejected token was saved")
	}
	_, stderr, err := e.run("login", "--token", fakeapi.Token)
	if err != nil || !strings.Contains(stderr, "Logged in as testowner@example.com") {
		t.Fatalf("%q %v", stderr, err)
	}
	p, _ := files.TokenPath()
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("token file %v %v", fi, err)
	}
	if di, _ := os.Stat(filepath.Dir(p)); di.Mode().Perm() != 0o700 {
		t.Errorf("config dir mode %v", di.Mode())
	}
	// The saved token now authenticates uploads.
	path, _ := randomFile(t, "a.pdf", 10)
	if _, _, err := e.run("upload", path); err != nil {
		t.Fatal(err)
	}
	// --token beats the environment, which beats the saved token.
	t.Setenv(files.TokenEnv, "mdk_wrong")
	if _, _, err := e.run("info", "a"); err == nil {
		t.Error("env token should take precedence over the saved one")
	}
	if _, _, err := e.run("info", "a", "--token", fakeapi.Token); err != nil {
		t.Errorf("--token should win: %v", err)
	}
	if _, stderr, err := e.run("logout"); err != nil || !strings.Contains(stderr, "removed") {
		t.Errorf("logout %q %v", stderr, err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Error("token file still there")
	}
}

// ── Real process: exit codes and kill -9 mid-upload ─────────────────────────

func cliProcess(t *testing.T, e *cliEnv, args ...string) *exec.Cmd {
	t.Helper()
	raw, _ := json.Marshal(append(args, "--server", e.fake.URL))
	c := exec.Command(os.Args[0], "-test.run=^$")
	c.Env = append(os.Environ(), cliArgsEnv+"="+string(raw))
	return c
}

func TestExitCodeAndStreams(t *testing.T) {
	e := setup(t)
	e.fake.AddDoc("theirs", fakeapi.OtherToken, "artifact", []byte("x"), "video/mp4")
	path, _ := randomFile(t, "x.mp4", 1000)

	c := cliProcess(t, e, "replace", "theirs", path, "--json")
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	err := c.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 1 {
		t.Fatalf("exit: %v", err)
	}
	if out.Len() != 0 || !strings.Contains(errb.String(), "Error: not allowed to start the upload: You don't own this document") {
		t.Errorf("stdout %q stderr %q", out.String(), errb.String())
	}

	c = cliProcess(t, e, "upload", path, "--json")
	out.Reset()
	errb.Reset()
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		t.Fatal(err, errb.String())
	}
	oneJSONObject(t, out.String())
	if errb.Len() != 0 {
		t.Errorf("stderr not empty without a terminal: %q", errb.String())
	}
}

// The process is killed (SIGKILL) while parts are in flight; running the same
// command again resumes the session and sends only the missing parts.
func TestKilledUploadResumes(t *testing.T) {
	e := setup(t)
	const parts = 10
	path, data := randomFile(t, "long.mp4", parts<<20)

	reached := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	// Set under the fake's lock: the requests come from another process, so
	// the race detector can't see that they follow this write.
	e.fake.Lock()
	e.fake.PartHook = func(_ string, n, _ int) int {
		if _, stored := e.fake.Counts(); len(stored) >= 3 {
			once.Do(func() { close(reached) })
			<-release // hold the part until the client is dead
			return 500
		}
		return 0
	}
	e.fake.Unlock()
	c := cliProcess(t, e, "upload", path, "--json")
	var out1 bytes.Buffer
	c.Stdout = &out1
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-reached:
	case <-time.After(30 * time.Second):
		_ = c.Process.Kill()
		t.Fatal("upload never got 3 parts in")
	}
	_ = c.Process.Kill()
	_ = c.Wait()
	close(release)
	if out1.Len() != 0 {
		t.Fatalf("killed run printed %q", out1.String())
	}
	if !e.fake.Quiesce(10 * time.Second) {
		t.Fatal("part handlers still running")
	}
	_, before := e.fake.Counts()
	if len(before) >= parts {
		t.Fatalf("everything was stored before the kill: %v", before)
	}
	states, _ := filepath.Glob(filepath.Join(e.stateDir, "*.json"))
	if len(states) != 1 {
		t.Fatalf("resumable state: %v", states)
	}
	e.fake.Lock()
	e.fake.PartHook = nil
	e.fake.Unlock()
	e.fake.ResetCounts()

	c = cliProcess(t, e, "upload", path, "--json")
	var out2, err2 bytes.Buffer
	c.Stdout, c.Stderr = &out2, &err2
	if err := c.Run(); err != nil {
		t.Fatal(err, err2.String())
	}
	res := oneJSONObject(t, out2.String())
	puts, _ := e.fake.Counts()
	for n := 1; n <= parts; n++ {
		want := 1
		if before[n] > 0 {
			want = 0
		}
		if puts[n] != want {
			t.Errorf("part %d sent %d times after the restart, want %d", n, puts[n], want)
		}
	}
	if e.fake.Creates != 0 || len(e.fake.SessionIDs()) != 1 {
		t.Errorf("a new session was created (creates %d)", e.fake.Creates)
	}
	if !strings.Contains(err2.String(), "Resuming the upload") {
		t.Errorf("stderr %q", err2.String())
	}
	if !bytes.Equal(e.fake.CurrentData(res["slug"].(string)), data) {
		t.Error("bytes differ")
	}
	if states, _ := filepath.Glob(filepath.Join(e.stateDir, "*.json")); len(states) != 0 {
		t.Errorf("state left after success: %v", states)
	}
	t.Logf("stored before kill: %d of %d parts; resumed run sent %d", len(before), parts, len(puts))
}

// The real `markdrop mcp` process over stdio, driven by an MCP client: the
// file tools work end to end, with progress notifications, and stdout
// carries nothing but the protocol.
func TestMCPServerOverStdio(t *testing.T) {
	e := setup(t)
	e.fake.Lock()
	e.fake.PartHook = func(string, int, int) int { time.Sleep(100 * time.Millisecond); return 0 }
	e.fake.Unlock()
	path, data := randomFile(t, "talk.mp4", 5<<20+3)

	c := cliProcess(t, e, "mcp")
	var stderr bytes.Buffer
	c.Stderr = &stderr
	var mu sync.Mutex
	var notes []*mcp.ProgressNotificationParams
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-test", Version: "1"}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(_ context.Context, r *mcp.ProgressNotificationClientRequest) {
			mu.Lock()
			notes = append(notes, r.Params)
			mu.Unlock()
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: c}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if v := cs.InitializeResult().ServerInfo.Version; v != version {
		t.Errorf("server version %q", v)
	}

	p := &mcp.CallToolParams{Name: "upload_file", Arguments: map[string]any{"path": path}}
	p.SetProgressToken(7)
	res, err := cs.CallTool(ctx, p)
	if err != nil || res.IsError {
		t.Fatalf("upload_file: %v %+v", err, res)
	}
	out := res.StructuredContent.(map[string]any)
	if out["slug"] != "talk" || out["size_bytes"] != float64(len(data)) || out["version"] != 1.0 {
		t.Errorf("out %v", out)
	}
	mu.Lock()
	got := append([]*mcp.ProgressNotificationParams(nil), notes...)
	mu.Unlock()
	if len(got) < 3 || got[len(got)-1].Progress != float64(len(data)) {
		t.Errorf("progress notifications: %d", len(got))
	}
	for i, n := range got {
		if i > 0 && n.Progress <= got[i-1].Progress {
			t.Errorf("progress not increasing at %d", i)
		}
	}

	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_file_info", Arguments: map[string]any{"document": "talk"}})
	if err != nil || res.IsError || res.StructuredContent.(map[string]any)["content_type"] != "video/mp4" {
		t.Fatalf("get_file_info %v %+v", err, res)
	}
	cs.Close()
	if !strings.Contains(stderr.String(), "v"+version+" ready") || !strings.Contains(stderr.String(), "talk.mp4 → new file") {
		t.Errorf("stderr %q", stderr.String())
	}
	t.Logf("%d progress notifications over stdio", len(got))
}

func TestUploadIntoWorkspace(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	path, _ := randomFile(t, "Spec.pdf", 1500)
	stdout, stderr, err := e.run("upload", path, "--workspace", "docs.acme.test", "--folder", "/guides/setup/",
		"--slug", "q3-spec")
	if err != nil {
		t.Fatal(err, stderr)
	}
	if stdout != "https://docs.acme.test/guides/setup/q3-spec\n" {
		t.Errorf("stdout %q (just the canonical link)", stdout)
	}
	if !strings.Contains(stderr, "also at "+e.fake.WebBase+"/q3-spec") {
		t.Errorf("stderr %q", stderr)
	}
	lc := e.fake.LastCreate
	if lc["workspace"] != "ws_acme" || lc["folder"] != "guides/setup" || lc["slug"] != "q3-spec" ||
		lc["access"] != "workspace" {
		t.Errorf("create %v", lc)
	}

	path2, _ := randomFile(t, "Plan.pdf", 900)
	stdout, _, err = e.run("upload", path2, "--workspace", "Side", "--access", "link", "--json")
	if err != nil {
		t.Fatal(err)
	}
	obj := oneJSONObject(t, stdout)
	if obj["url"] != e.fake.WebBase+"/plan" || obj["markdrop_url"] != obj["url"] || e.fake.LastCreate["workspace"] != "ws_side" {
		t.Errorf("no live domain: %v", obj)
	}

	creates := e.fake.Creates
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"upload", path2, "--folder", "guides"}, "--folder needs --workspace"},
		{[]string{"upload", path2, "--slug", "no spaces"}, "--slug must be"},
		{[]string{"upload", path2, "--slug", "ab"}, "--slug must be"},
		{[]string{"upload", path2, "--workspace", "Nope"}, `no workspace "Nope"`},
		{[]string{"upload", path2, "--slug", "q3-spec"}, "already taken"},
		{[]string{"upload", path2, "--workspace", "Acme", "--folder", "missing"}, "Folder not found"},
	} {
		stdout, _, err := e.run(c.args...)
		if err == nil || !strings.Contains(err.Error(), c.want) || stdout != "" {
			t.Errorf("%v: err %v, stdout %q, want %q", c.args, err, stdout, c.want)
		}
	}
	if e.fake.Creates != creates+2 { // only the taken slug and the missing folder reach the API
		t.Errorf("creates %d → %d", creates, e.fake.Creates)
	}
}

func TestWorkspacesCommand(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	stdout, _, err := e.run("workspaces")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, "ws_acme") || !strings.Contains(stdout, "docs.acme.test") ||
		strings.Contains(stdout, "files.acme.test") || !strings.Contains(stdout, "Side") {
		t.Errorf("list %q", stdout)
	}
	stdout, _, err = e.run("workspaces", "acme")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, "guides/setup") || !strings.Contains(stdout, "f_setup") {
		t.Errorf("folders %q", stdout)
	}
	stdout, _, err = e.run("workspaces", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if ws := oneJSONObject(t, stdout)["workspaces"].([]any); len(ws) != 2 {
		t.Errorf("json %q", stdout)
	}
	stdout, stderr, err := e.run("workspaces", "Side")
	if err != nil || stdout != "" || !strings.Contains(stderr, "no folders yet") {
		t.Errorf("empty: %v %q %q", err, stdout, stderr)
	}
}
