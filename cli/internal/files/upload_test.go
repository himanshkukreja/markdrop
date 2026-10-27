package files

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/files/fakeapi"
)

const mib = 1 << 20

func newFake(t *testing.T) *fakeapi.Server {
	t.Helper()
	f := fakeapi.New()
	t.Cleanup(f.Close)
	return f
}

func newUploader(t *testing.T, f *fakeapi.Server, token string) *Uploader {
	t.Helper()
	return &Uploader{
		Client:       &Client{Base: f.URL, Token: token, UserAgent: "markdrop-cli/test", Attempts: 3, Backoff: time.Millisecond},
		StateDir:     filepath.Join(t.TempDir(), "uploads"),
		Backoff:      time.Millisecond,
		PollInterval: 5 * time.Millisecond,
		ProgressTick: 5 * time.Millisecond,
	}
}

func writeFile(t *testing.T, name string, size int) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	_, _ = rand.Read(data)
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

func stateFiles(t *testing.T, u *Uploader) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(u.StateDir, "*.json"))
	return m
}

func TestUploadHappyPath(t *testing.T) {
	f := newFake(t)
	// Hold each part briefly so the parallelism shows.
	f.PartHook = func(_ string, _, _ int) int { time.Sleep(30 * time.Millisecond); return 0 }
	u := newUploader(t, f, fakeapi.Token)
	path, data := writeFile(t, "Demo Clip.mp4", 6*mib+12345) // 7 parts

	var phases []Phase
	var last Progress
	var mu sync.Mutex
	res, err := u.Upload(context.Background(), UploadOptions{
		Path: path, Title: "Demo", Access: "private",
		OnProgress: func(p Progress) {
			mu.Lock()
			defer mu.Unlock()
			if len(phases) == 0 || phases[len(phases)-1] != p.Phase {
				phases = append(phases, p.Phase)
			} else if p.Done < last.Done {
				t.Errorf("progress went backwards: %d after %d", p.Done, last.Done)
			}
			last = p
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Slug != "demo-clip" || res.Version != 1 || res.SizeBytes != int64(len(data)) ||
		res.URL != f.WebBase+"/demo-clip" || res.ContentType != "video/mp4" {
		t.Fatalf("result: %+v", res)
	}
	sum, _ := SHA256File(path)
	if res.SHA256 != sum || !strings.Contains(string(res.Raw), `"slug":"demo-clip"`) {
		t.Errorf("sha/raw: %+v %s", res, res.Raw)
	}
	if !bytes.Equal(f.CurrentData("demo-clip"), data) {
		t.Fatal("stored bytes differ")
	}
	puts, stored := f.Counts()
	for n := 1; n <= 7; n++ {
		if puts[n] != 1 || stored[n] != 1 {
			t.Errorf("part %d: puts %d stored %d", n, puts[n], stored[n])
		}
	}
	if got := f.MaxInFlight(); got != 4 {
		t.Errorf("max parts in flight = %d, want 4", got)
	}
	if !slices.Equal(phases, []Phase{PhaseHashing, PhaseUploading, PhaseVerifying}) {
		t.Errorf("phases %v", phases)
	}
	if last.Done != int64(len(data)) || last.Total != int64(len(data)) {
		t.Errorf("last progress %+v", last)
	}
	lc := f.LastCreate
	if lc["sha256"] != sum || lc["file_name"] != "Demo Clip.mp4" || lc["content_type"] != "video/mp4" ||
		lc["title"] != "Demo" || lc["access"] != "private" || lc["size_bytes"].(float64) != float64(len(data)) {
		t.Errorf("create request: %v", lc)
	}
	if _, has := lc["target_slug"]; has {
		t.Errorf("target_slug sent for a new upload: %v", lc)
	}
	for _, h := range f.AuthHeaders {
		if h != "Bearer "+fakeapi.Token {
			t.Errorf("auth header %q", h)
		}
	}
	if f.PartCredentials != 0 {
		t.Errorf("%d part uploads carried the API token to the storage", f.PartCredentials)
	}
	if s := stateFiles(t, u); len(s) != 0 {
		t.Errorf("state left behind: %v", s)
	}
}

func TestReplaceKeepsLinkAndVersions(t *testing.T) {
	f := newFake(t)
	f.AddDoc("clip", fakeapi.Token, "artifact", []byte("old video"), "video/mp4")
	u := newUploader(t, f, fakeapi.Token)
	path, data := writeFile(t, "new.mp4", 2*mib+1)
	res, err := u.Upload(context.Background(), UploadOptions{Path: path, TargetSlug: "clip", Access: "private"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Slug != "clip" || res.Version != 2 || res.URL != f.WebBase+"/clip" {
		t.Fatalf("result %+v", res)
	}
	if f.LastCreate["target_slug"] != "clip" {
		t.Errorf("create: %v", f.LastCreate)
	}
	if _, has := f.LastCreate["access"]; has {
		t.Errorf("a replace must not send access: %v", f.LastCreate)
	}
	d := f.Doc("clip")
	if len(d.Versions) != 2 || d.Current != 2 || !bytes.Equal(f.CurrentData("clip"), data) || d.Views != 7 {
		t.Errorf("doc after replace: %+v", d)
	}

	c := u.Client
	vs, err := c.Versions(context.Background(), "clip")
	if err != nil || len(vs.Versions) != 2 || !vs.Versions[0].Current || vs.Versions[0].Version != 2 {
		t.Fatalf("versions %+v %v", vs, err)
	}
	info, err := c.Restore(context.Background(), "clip", 1)
	if err != nil || info.Version != 3 || info.SizeBytes != int64(len("old video")) {
		t.Fatalf("restore %+v %v", info, err)
	}
	if string(f.CurrentData("clip")) != "old video" {
		t.Error("restore didn't bring the old bytes back")
	}
	info, err = c.FileInfo(context.Background(), "clip")
	if err != nil || info.Media == nil || *info.Media.Width != 640 || info.PosterURL == nil {
		t.Fatalf("info %+v %v", info, err)
	}
}

// An upload interrupted after some parts resumes with the same session and
// sends only the parts the server is missing.
func TestResumeSendsOnlyMissingParts(t *testing.T) {
	f := newFake(t)
	u := newUploader(t, f, fakeapi.Token)
	u.Concurrency = 1 // deterministic: parts go 1, 2, 3, …
	path, data := writeFile(t, "big.mp4", 8*mib)

	ctx, cancel := context.WithCancel(context.Background())
	var stored atomic.Int32
	f.AfterStore = func(_ string, n int) {
		if stored.Add(1) == 3 {
			cancel() // "kill" after three parts are on the server
		}
	}
	_, err := u.Upload(ctx, UploadOptions{Path: path})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted upload: %v", err)
	}
	if len(stateFiles(t, u)) != 1 {
		t.Fatal("no resumable state saved")
	}
	_, before := f.Counts()
	f.Lock()
	f.AfterStore = nil
	f.Unlock()
	f.ResetCounts()

	var notices []string
	res, err := u.Upload(context.Background(), UploadOptions{Path: path, OnNotice: func(s string) { notices = append(notices, s) }})
	if err != nil {
		t.Fatal(err)
	}
	puts, _ := f.Counts()
	for n := 1; n <= 8; n++ {
		want := 1
		if before[n] > 0 {
			want = 0
		}
		if puts[n] != want {
			t.Errorf("part %d sent %d times on resume, want %d (stored before: %v)", n, puts[n], want, before)
		}
	}
	if f.Creates != 0 {
		t.Errorf("resume created a new session")
	}
	if len(f.URLRefreshes) != 1 || len(f.URLRefreshes[0]) != 8-len(before) {
		t.Errorf("URL refreshes %v", f.URLRefreshes)
	}
	if !bytes.Equal(f.CurrentData(res.Slug), data) {
		t.Error("bytes differ after resume")
	}
	if !strings.Contains(strings.Join(notices, "\n"), "Resuming the upload: 3 of 8 parts") {
		t.Errorf("notices %q", notices)
	}
	if len(stateFiles(t, u)) != 0 {
		t.Error("state left after success")
	}
}

func TestResumeAfterSessionExpiredStartsOver(t *testing.T) {
	f := newFake(t)
	u := newUploader(t, f, fakeapi.Token)
	u.Concurrency = 1
	path, data := writeFile(t, "a.pdf", 3*mib)
	ctx, cancel := context.WithCancel(context.Background())
	f.AfterStore = func(string, int) { cancel() }
	if _, err := u.Upload(ctx, UploadOptions{Path: path}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.Lock()
	f.AfterStore = nil
	f.Unlock()
	for _, id := range f.SessionIDs() {
		f.ExpireSession(id)
	}
	f.ResetCounts()
	res, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if f.Creates != 1 || f.TotalPuts() != 3 || !bytes.Equal(f.CurrentData(res.Slug), data) {
		t.Errorf("creates %d puts %d", f.Creates, f.TotalPuts())
	}
}

// Interrupted while the server verified: the re-run collects the result
// without sending anything again.
func TestResumeWhileVerifying(t *testing.T) {
	f := newFake(t)
	f.VerifyPolls = 1000
	u := newUploader(t, f, fakeapi.Token)
	path, _ := writeFile(t, "v.mp4", 2*mib)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := u.Upload(ctx, UploadOptions{Path: path}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected the poll to be cut short, got %v", err)
	}
	f.Lock()
	f.VerifyPolls = 0
	f.Unlock()
	f.ResetCounts()
	res, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err != nil || res.Slug != "v" {
		t.Fatalf("%+v %v", res, err)
	}
	if f.TotalPuts() != 0 || f.Creates != 0 || f.Completes != 0 {
		t.Errorf("re-sent: puts %d creates %d completes %d", f.TotalPuts(), f.Creates, f.Completes)
	}
}

func TestExpiredURLsAreRefreshed(t *testing.T) {
	f := newFake(t)
	u := newUploader(t, f, fakeapi.Token)
	u.Concurrency = 1
	var once sync.Once
	f.AfterStore = func(_ string, n int) {
		if n == 2 {
			once.Do(f.ExpireURLs) // every URL handed out so far stops working
		}
	}
	path, data := writeFile(t, "x.mp4", 5*mib)
	res, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	puts, stored := f.Counts()
	if puts[3] != 2 || stored[3] != 1 {
		t.Errorf("part 3: puts %d stored %d", puts[3], stored[3])
	}
	if len(f.URLRefreshes) != 1 || !slices.Equal(f.URLRefreshes[0], []int{3, 4, 5}) {
		t.Errorf("refreshes %v", f.URLRefreshes)
	}
	if !bytes.Equal(f.CurrentData(res.Slug), data) {
		t.Error("bytes differ")
	}
}

func TestOldURLsAreRefreshedBeforeUse(t *testing.T) {
	f := newFake(t)
	u := newUploader(t, f, fakeapi.Token)
	u.URLMaxAge = time.Nanosecond
	path, _ := writeFile(t, "x.mp4", 3*mib)
	if _, err := u.Upload(context.Background(), UploadOptions{Path: path}); err != nil {
		t.Fatal(err)
	}
	if len(f.URLRefreshes) == 0 || f.TotalPuts() != 3 {
		t.Errorf("refreshes %v puts %d", f.URLRefreshes, f.TotalPuts())
	}
}

func TestPartRetry(t *testing.T) {
	f := newFake(t)
	f.PartHook = func(_ string, n, attempt int) int {
		if n == 2 && attempt <= 2 {
			return 503
		}
		return 0
	}
	u := newUploader(t, f, fakeapi.Token)
	var notices []string
	var mu sync.Mutex
	path, data := writeFile(t, "r.mp4", 3*mib)
	res, err := u.Upload(context.Background(), UploadOptions{Path: path, OnNotice: func(s string) {
		mu.Lock()
		notices = append(notices, s)
		mu.Unlock()
	}})
	if err != nil {
		t.Fatal(err)
	}
	puts, stored := f.Counts()
	if puts[2] != 3 || stored[2] != 1 || puts[1] != 1 {
		t.Errorf("puts %v stored %v", puts, stored)
	}
	if !bytes.Equal(f.CurrentData(res.Slug), data) {
		t.Error("bytes differ")
	}
	if len(notices) != 2 || !strings.Contains(notices[0], "Part 2 failed") {
		t.Errorf("notices %q", notices)
	}
}

func TestPartGivesUpAndStaysResumable(t *testing.T) {
	f := newFake(t)
	f.PartHook = func(_ string, n, _ int) int {
		if n == 2 {
			return 500
		}
		return 0
	}
	u := newUploader(t, f, fakeapi.Token)
	u.PartAttempts = 3
	path, _ := writeFile(t, "r.mp4", 3*mib)
	_, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err == nil || !strings.Contains(err.Error(), "part 2 failed after 3 tries") {
		t.Fatalf("err %v", err)
	}
	puts, _ := f.Counts()
	if puts[2] != 3 {
		t.Errorf("part 2 tried %d times", puts[2])
	}
	if f.Completes != 0 || len(stateFiles(t, u)) != 1 {
		t.Errorf("completes %d, state %v", f.Completes, stateFiles(t, u))
	}
	// A storage 4xx other than "expired" is not retried.
	f.Lock()
	f.PartHook = func(_ string, n, _ int) int { return 400 }
	f.Unlock()
	f.ResetCounts()
	path2, _ := writeFile(t, "s.mp4", mib)
	_, err = u.Upload(context.Background(), UploadOptions{Path: path2})
	if err == nil || !strings.Contains(err.Error(), "rejected by the storage: HTTP 400") || f.TotalPuts() != 1 {
		t.Fatalf("err %v puts %d", err, f.TotalPuts())
	}
}

func TestShaMismatchChangesNothing(t *testing.T) {
	for _, polls := range []int{0, 2} {
		f := newFake(t)
		f.Corrupt = true
		f.VerifyPolls = polls
		f.AddDoc("clip", fakeapi.Token, "artifact", []byte("old"), "video/mp4")
		u := newUploader(t, f, fakeapi.Token)
		path, _ := writeFile(t, "n.mp4", mib+5)
		_, err := u.Upload(context.Background(), UploadOptions{Path: path, TargetSlug: "clip"})
		if !errors.Is(err, ErrVerification) || !strings.Contains(err.Error(), "sha256 mismatch") ||
			!strings.Contains(err.Error(), "Nothing was changed") {
			t.Fatalf("polls=%d: err %v", polls, err)
		}
		if d := f.Doc("clip"); len(d.Versions) != 1 || string(f.CurrentData("clip")) != "old" {
			t.Errorf("polls=%d: document changed", polls)
		}
		if len(stateFiles(t, u)) != 0 {
			t.Errorf("polls=%d: failed session still saved", polls)
		}
	}
}

func TestVerifyingIsPolled(t *testing.T) {
	f := newFake(t)
	f.VerifyPolls = 3
	u := newUploader(t, f, fakeapi.Token)
	path, _ := writeFile(t, "p.mp4", mib)
	res, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err != nil || res.Slug != "p" {
		t.Fatalf("%+v %v", res, err)
	}
	if f.StatusGets != 4 {
		t.Errorf("status polls %d, want 4", f.StatusGets)
	}
}

func TestAPIErrorsAreClear(t *testing.T) {
	f := newFake(t)
	f.AddDoc("theirs", fakeapi.OtherToken, "artifact", []byte("x"), "video/mp4")
	f.AddDoc("notes", fakeapi.Token, "markdown", []byte("# hi"), "text/markdown")
	path, _ := writeFile(t, "e.mp4", 1000)
	cases := []struct {
		token, target string
		want          []string
	}{
		{fakeapi.Token, "theirs", []string{"not allowed", "You don't own this document"}},
		{fakeapi.Token, "notes", []string{"notes is a markdown document; use update_document", "HTTP 409"}},
		{fakeapi.Token, "missing", []string{"not found"}},
		{"mdk_bogus", "", []string{"API token was rejected", TokensURL}},
		{"", "", []string{"MARKDROP_TOKEN", TokensURL}},
	}
	for _, c := range cases {
		u := newUploader(t, f, c.token)
		_, err := u.Upload(context.Background(), UploadOptions{Path: path, TargetSlug: c.target})
		if err == nil {
			t.Fatalf("%s/%s: no error", c.token, c.target)
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s/%s: %q lacks %q", c.token, c.target, err, w)
			}
		}
	}
	if f.TotalPuts() != 0 {
		t.Errorf("parts were sent despite the errors")
	}
	// Too large.
	f.MaxBytes = 10
	u := newUploader(t, f, fakeapi.Token)
	if _, err := u.Upload(context.Background(), UploadOptions{Path: path}); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("413: %v", err)
	}
	// Folders are refused locally.
	if _, err := u.Upload(context.Background(), UploadOptions{Path: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "is a folder") {
		t.Errorf("folder: %v", err)
	}
}

func TestEmptyFile(t *testing.T) {
	f := newFake(t)
	u := newUploader(t, f, fakeapi.Token)
	path, _ := writeFile(t, "empty.txt", 0)
	res, err := u.Upload(context.Background(), UploadOptions{Path: path})
	if err != nil || res.SizeBytes != 0 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestParseSlug(t *testing.T) {
	ok := map[string]string{
		"clip-x7":                               "clip-x7",
		"https://markdrop.in/clip-x7":           "clip-x7",
		"https://www.markdrop.in/clip-x7?x=1#k": "clip-x7",
		"http://localhost:3000/clip-x7":         "clip-x7",
		"markdrop.in/clip-x7":                   "clip-x7",
		"/clip-x7":                              "clip-x7",
		"https://docs.acme.com/reports/q3":      "q3",
	}
	for in, want := range ok {
		if got, err := ParseSlug(in); err != nil || got != want {
			t.Errorf("ParseSlug(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "https://markdrop.in/", "https://markdrop.in/share/abc123def0", "a b", "x!"} {
		if got, err := ParseSlug(bad); err == nil {
			t.Errorf("ParseSlug(%q) accepted: %q", bad, got)
		}
	}
	for in, want := range map[string]int{"3": 3, "v12": 12, " V2 ": 2} {
		if got, err := ParseVersion(in); err != nil || got != want {
			t.Errorf("ParseVersion(%q) = %d, %v", in, got, err)
		}
	}
	for _, bad := range []string{"0", "-1", "x", ""} {
		if _, err := ParseVersion(bad); err == nil {
			t.Errorf("ParseVersion(%q) accepted", bad)
		}
	}
}

func TestContentTypeFor(t *testing.T) {
	for name, want := range map[string]string{
		"a.MP4": "video/mp4", "b.mov": "video/quicktime", "c.pdf": "application/pdf", "d.unknownext": "application/octet-stream",
	} {
		if got := ContentTypeFor(name); got != want {
			t.Errorf("%s: %s", name, got)
		}
	}
}
