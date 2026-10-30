package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Phase is what an upload is doing.
type Phase string

const (
	PhaseHashing   Phase = "hashing"   // computing the local sha256
	PhaseUploading Phase = "uploading" // sending parts
	PhaseVerifying Phase = "verifying" // the server assembles and checks the file
)

// Progress is reported while an upload runs. Done never decreases within a
// phase. Callbacks come from one goroutine at a time.
type Progress struct {
	Phase    Phase
	Done     int64
	Total    int64
	FileName string
}

// UploadOptions describes one upload or replace.
type UploadOptions struct {
	Path        string // local file
	TargetSlug  string // replace this document's file; "" publishes a new one
	Title       string
	Access      string // link | private | password | workspace (new uploads)
	Password    string
	Workspace   string // workspace id to file a new upload in
	Folder      string // folder of that workspace (id or path); needs Workspace
	Slug        string // custom address for a new upload; "" = from the file name
	ContentType string // "" = from the file name

	OnProgress func(Progress) // optional
	OnNotice   func(string)   // optional: "resuming…", "retrying part 3…"
}

// Uploader runs uploads. The zero value (plus Client) works; tests shorten
// the timings.
type Uploader struct {
	Client   *Client
	PartHTTP *http.Client // for the pre-signed PUTs; nil = a tuned client with no overall timeout
	StateDir string       // where resumable sessions are remembered; "" = no resume

	Concurrency  int           // parts in flight; default 4
	PartAttempts int           // tries per part; default 6
	Backoff      time.Duration // first retry delay, doubled each time; default 1s
	PollInterval time.Duration // while the server verifies; default 2s
	URLMaxAge    time.Duration // refresh URLs older than this before using them; default 50m
	StallTimeout time.Duration // abort a PUT that moved no bytes for this long; default 2m
	ProgressTick time.Duration // how often progress is reported; default 200ms
}

// ErrVerification is wrapped by errors from a failed server-side check.
var ErrVerification = errors.New("verification failed")

func (u *Uploader) concurrency() int { return defInt(u.Concurrency, 4) }
func (u *Uploader) attempts() int    { return defInt(u.PartAttempts, 6) }
func (u *Uploader) backoff() time.Duration {
	return defDur(u.Backoff, time.Second)
}
func (u *Uploader) poll() time.Duration      { return defDur(u.PollInterval, 2*time.Second) }
func (u *Uploader) urlMaxAge() time.Duration { return defDur(u.URLMaxAge, 50*time.Minute) }
func (u *Uploader) stall() time.Duration     { return defDur(u.StallTimeout, 2*time.Minute) }
func (u *Uploader) tick() time.Duration      { return defDur(u.ProgressTick, 200*time.Millisecond) }

func defInt(v, d int) int {
	if v > 0 {
		return v
	}
	return d
}

func defDur(v, d time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return d
}

// Upload publishes (or, with TargetSlug, replaces) a file and returns the
// server's result. Re-running the same upload after an interruption resumes
// it: only the parts the server doesn't have are sent.
func (u *Uploader) Upload(ctx context.Context, opts UploadOptions) (*Result, error) {
	if u.Client == nil {
		return nil, errors.New("files: Uploader.Client is nil")
	}
	if strings.TrimSpace(u.Client.Token) == "" {
		return nil, ErrNoToken
	}
	abs, err := filepath.Abs(opts.Path)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", opts.Path, unwrapPath(err))
	}
	if fi.IsDir() {
		return nil, fmt.Errorf("%s is a folder; files are published one at a time. To publish a website (a zipped folder), use markdrop.in/upload; to send a folder peer to peer, use markdrop send", abs)
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", abs)
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", abs, unwrapPath(err))
	}
	defer f.Close()

	name := filepath.Base(abs)
	size := fi.Size()
	report := opts.OnProgress
	if report == nil {
		report = func(Progress) {}
	}
	notice := opts.OnNotice
	if notice == nil {
		notice = func(string) {}
	}

	sum, err := hashFile(ctx, f, size, u.tick(), func(done int64) {
		report(Progress{Phase: PhaseHashing, Done: done, Total: size, FileName: name})
	})
	if err != nil {
		return nil, err
	}
	// The file must not change while it uploads: the server checks the hash.
	if fi2, err := os.Stat(abs); err != nil || fi2.Size() != size || !fi2.ModTime().Equal(fi.ModTime()) {
		return nil, fmt.Errorf("%s changed while it was being read; try again when it is complete", abs)
	}

	ctype := opts.ContentType
	if ctype == "" {
		ctype = ContentTypeFor(name)
	}
	access, password, workspace, folder, slug := opts.Access, opts.Password, opts.Workspace, opts.Folder, opts.Slug
	if opts.TargetSlug != "" {
		// A replace keeps the document's link, access and place.
		access, password, workspace, folder, slug = "", "", "", "", ""
	}
	req := CreateUploadRequest{
		FileName: name, SizeBytes: size, ContentType: ctype, SHA256: sum, TargetSlug: opts.TargetSlug,
		Title: opts.Title, Access: access, Password: password, Workspace: workspace, Folder: folder, Slug: slug,
	}
	st := newStateStore(u.StateDir)
	key := stateKey(u.Client.Base, abs, size, fi.ModTime().UnixNano(), sum, req)

	job := &job{u: u, f: f, size: size, name: name, sha: sum, report: report, notice: notice, st: st, key: key}

	// Resume a session this exact upload started before, if it is still alive.
	if saved := st.load(key); saved != nil {
		res, resumed, err := job.resume(ctx, saved)
		if err != nil || res != nil {
			return res, err
		}
		if !resumed {
			st.remove(key)
		}
	}
	if job.uploadID == "" {
		if err := job.create(ctx, req, abs, fi.ModTime().UnixNano()); err != nil {
			return nil, err
		}
	}
	return job.run(ctx)
}

// job is one upload in flight.
type job struct {
	u      *Uploader
	f      *os.File
	size   int64
	name   string
	sha    string
	report func(Progress)
	notice func(string)
	st     *stateStore
	key    string

	uploadID string
	partSize int64
	nParts   int

	mu       sync.Mutex
	done     map[int]UploadedPart // parts the server holds
	urls     map[int]string
	urlsAt   time.Time
	inflight map[int]*atomic.Int64
	refresh  sync.Mutex // one URL refresh at a time
}

func (j *job) setGeometry(partSize int64) error {
	if partSize <= 0 {
		return fmt.Errorf("the server gave an invalid part size (%d)", partSize)
	}
	j.partSize = partSize
	n := (j.size + partSize - 1) / partSize
	if n < 1 {
		n = 1
	}
	if n > 10_000 {
		return fmt.Errorf("the server's part size (%d bytes) would need %d parts (max 10000)", partSize, n)
	}
	j.nParts = int(n)
	return nil
}

func (j *job) partLen(n int) int64 {
	off := int64(n-1) * j.partSize
	return min(j.partSize, j.size-off)
}

// resume picks up a saved session. It returns a result if the session had
// already finished, resumed=true if the job can continue it, or neither if
// the session is gone and a new one must be started.
func (j *job) resume(ctx context.Context, saved *savedState) (*Result, bool, error) {
	c := j.u.Client
	status, err := c.UploadStatus(ctx, saved.UploadID)
	if err != nil {
		if IsStatus(err, http.StatusNotFound, http.StatusGone, http.StatusForbidden) {
			j.notice("The previous upload session has expired; starting over.")
			return nil, false, nil
		}
		return nil, false, err
	}
	j.uploadID = saved.UploadID
	switch status.State {
	case "done":
		j.notice("This upload had already finished.")
		res, err := ParseResult(status.Result)
		if err == nil {
			j.st.remove(j.key)
		}
		return res, false, err
	case "verifying", "completing":
		j.notice("The server is still verifying the previous upload…")
		res, err := j.waitVerified(ctx)
		return res, false, err
	case "failed", "expired", "aborted", "cancelled", "canceled":
		j.uploadID = ""
		j.notice("The previous upload session " + status.State + "; starting over.")
		return nil, false, nil
	}
	if exp, ok := parseTime(status.ExpiresAt); ok && time.Now().After(exp) {
		j.uploadID = ""
		j.notice("The previous upload session has expired; starting over.")
		return nil, false, nil
	}
	if status.SizeBytes != 0 && status.SizeBytes != j.size {
		j.uploadID = ""
		return nil, false, nil
	}
	ps := status.PartSize
	if ps <= 0 {
		ps = saved.PartSize
	}
	if err := j.setGeometry(ps); err != nil {
		return nil, false, err
	}
	j.done = map[int]UploadedPart{}
	for _, p := range status.PartsUploaded {
		if p.PartNumber < 1 || p.PartNumber > j.nParts || p.ETag == "" {
			continue
		}
		if p.Size != 0 && p.Size != j.partLen(p.PartNumber) {
			continue // a short or stale part: send it again
		}
		j.done[p.PartNumber] = p
	}
	missing := j.missing()
	if len(missing) > 0 {
		urls, err := c.RefreshURLs(ctx, j.uploadID, missing)
		if err != nil {
			if IsStatus(err, http.StatusNotFound, http.StatusGone, http.StatusConflict) {
				j.uploadID = ""
				j.notice("The previous upload session can't be continued; starting over.")
				return nil, false, nil
			}
			return nil, false, err
		}
		j.setURLs(urls)
	}
	j.notice(fmt.Sprintf("Resuming the upload: %d of %d parts already on the server.", len(j.done), j.nParts))
	return nil, true, nil
}

func (j *job) create(ctx context.Context, req CreateUploadRequest, abs string, mtime int64) error {
	resp, err := j.u.Client.CreateUpload(ctx, req)
	if err != nil {
		return err
	}
	if err := j.setGeometry(resp.PartSize); err != nil {
		return err
	}
	j.uploadID = resp.UploadID
	j.done = map[int]UploadedPart{}
	j.setURLs(resp.Parts)
	for n := 1; n <= j.nParts; n++ {
		if j.urls[n] == "" {
			return fmt.Errorf("the server's upload session has no URL for part %d of %d", n, j.nParts)
		}
	}
	j.st.save(j.key, &savedState{
		UploadID: resp.UploadID, PartSize: resp.PartSize, Server: j.u.Client.Base, Path: abs, Size: j.size,
		MtimeNS: mtime, SHA256: j.sha, TargetSlug: req.TargetSlug, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		ExpiresAt: resp.ExpiresAt,
	})
	return nil
}

func (j *job) setURLs(parts []PartURL) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.urls == nil {
		j.urls = map[int]string{}
	}
	for _, p := range parts {
		if p.PartNumber >= 1 && p.PartNumber <= j.nParts && p.URL != "" {
			j.urls[p.PartNumber] = p.URL
		}
	}
	j.urlsAt = time.Now()
}

func (j *job) missing() []int {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []int
	for n := 1; n <= j.nParts; n++ {
		if _, ok := j.done[n]; !ok {
			out = append(out, n)
		}
	}
	return out
}

func (j *job) doneBytes() int64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	var b int64
	for n := range j.done {
		b += j.partLen(n)
	}
	for _, c := range j.inflight {
		b += c.Load()
	}
	return b
}

// run uploads the missing parts, completes the upload and waits for the
// server's verdict.
func (j *job) run(ctx context.Context) (*Result, error) {
	missing := j.missing()
	if len(missing) > 0 {
		if err := j.uploadParts(ctx, missing); err != nil {
			return nil, err
		}
	}
	j.report(Progress{Phase: PhaseVerifying, Done: j.size, Total: j.size, FileName: j.name})

	parts := make([]UploadedPart, 0, len(j.done))
	for _, p := range j.done {
		parts = append(parts, UploadedPart{PartNumber: p.PartNumber, ETag: p.ETag})
	}
	sort.Slice(parts, func(a, b int) bool { return parts[a].PartNumber < parts[b].PartNumber })

	res, verifying, err := j.u.Client.Complete(ctx, j.uploadID, parts)
	if err != nil {
		if IsStatus(err, http.StatusUnprocessableEntity, http.StatusBadRequest, http.StatusConflict,
			http.StatusNotFound, http.StatusGone) {
			// The session failed or is gone: a re-run must start a new one.
			j.st.remove(j.key)
		}
		if IsStatus(err, http.StatusUnprocessableEntity) {
			return nil, fmt.Errorf("%w: %v. Nothing was changed on Markdrop", ErrVerification, err)
		}
		return nil, err
	}
	if verifying {
		return j.waitVerified(ctx)
	}
	j.st.remove(j.key)
	return res, nil
}

// waitVerified polls the session until the server has checked the file.
func (j *job) waitVerified(ctx context.Context) (*Result, error) {
	j.report(Progress{Phase: PhaseVerifying, Done: j.size, Total: j.size, FileName: j.name})
	for {
		if err := sleepCtx(ctx, j.u.poll()); err != nil {
			return nil, err
		}
		status, err := j.u.Client.UploadStatus(ctx, j.uploadID)
		if err != nil {
			if IsStatus(err, http.StatusNotFound, http.StatusGone) {
				j.st.remove(j.key)
			}
			return nil, err
		}
		switch status.State {
		case "done":
			res, err := ParseResult(status.Result)
			if err == nil {
				j.st.remove(j.key)
			}
			return res, err
		case "failed", "expired", "aborted", "cancelled", "canceled":
			j.st.remove(j.key)
			why := status.ErrorText()
			if why == "" {
				why = "the upload " + status.State
			}
			return nil, fmt.Errorf("%w: %s. Nothing was changed on Markdrop", ErrVerification, why)
		}
	}
}

// uploadParts sends parts with Concurrency workers. The first failure stops
// the others; parts already sent stay on the server for a later resume.
func (j *job) uploadParts(ctx context.Context, parts []int) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	j.mu.Lock()
	j.inflight = map[int]*atomic.Int64{}
	j.mu.Unlock()

	// Progress reporter: one goroutine, monotonic.
	stopReport := make(chan struct{})
	reported := make(chan struct{})
	go func() {
		defer close(reported)
		var last int64 = -1
		emit := func() {
			d := j.doneBytes()
			if d > last {
				last = d
				j.report(Progress{Phase: PhaseUploading, Done: d, Total: j.size, FileName: j.name})
			}
		}
		emit()
		t := time.NewTicker(j.u.tick())
		defer t.Stop()
		for {
			select {
			case <-stopReport:
				emit()
				return
			case <-t.C:
				emit()
			}
		}
	}()
	defer func() { close(stopReport); <-reported }()

	queue := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < min(j.u.concurrency(), len(parts)); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := range queue {
				if err := j.uploadPart(ctx, n); err != nil {
					cancel(err)
					return
				}
			}
		}()
	}
feed:
	for _, n := range parts {
		select {
		case queue <- n:
		case <-ctx.Done():
			break feed
		}
	}
	close(queue)
	wg.Wait()
	if err := context.Cause(ctx); err != nil {
		return err
	}
	return nil
}

// errExpired marks a PUT the storage refused because its URL expired.
var errExpired = errors.New("upload URL expired")

// uploadPart PUTs one part, retrying with backoff and refreshing its URL
// when it has expired.
func (j *job) uploadPart(ctx context.Context, n int) error {
	counter := &atomic.Int64{}
	j.mu.Lock()
	j.inflight[n] = counter
	j.mu.Unlock()
	defer func() {
		j.mu.Lock()
		delete(j.inflight, n)
		j.mu.Unlock()
	}()

	var lastErr error
	refreshes := 0
	for attempt := 0; attempt < j.u.attempts(); attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, backoffDelay(j.u.backoff(), attempt-1, 30*time.Second)); err != nil {
				return err
			}
		}
		url, err := j.partURL(ctx, n, errors.Is(lastErr, errExpired))
		if err != nil {
			return err
		}
		counter.Store(0)
		etag, err := j.put(ctx, n, url, counter)
		if err == nil {
			j.mu.Lock()
			j.done[n] = UploadedPart{PartNumber: n, ETag: etag, Size: j.partLen(n)}
			j.mu.Unlock()
			counter.Store(0)
			return nil
		}
		counter.Store(0)
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		var perm *permanentError
		if errors.As(err, &perm) {
			return err
		}
		if errors.Is(err, errExpired) {
			refreshes++
			if refreshes > 3 {
				return fmt.Errorf("part %d: the storage keeps refusing fresh upload URLs: %w", n, err)
			}
			attempt-- // an expired URL isn't a failed try; get a new one right away
			lastErr = err
			continue
		}
		lastErr = err
		if attempt+1 < j.u.attempts() {
			j.notice(fmt.Sprintf("Part %d failed (%v); retrying.", n, err))
		}
	}
	return fmt.Errorf("part %d failed after %d tries: %w", n, j.u.attempts(), lastErr)
}

// partURL returns the URL for part n. URLs older than URLMaxAge, or one the
// storage refused as expired (force), are replaced by asking the server for
// fresh URLs for every part still to send, once for all workers.
func (j *job) partURL(ctx context.Context, n int, force bool) (string, error) {
	j.mu.Lock()
	url, issued := j.urls[n], j.urlsAt
	j.mu.Unlock()
	if url != "" && !force && time.Since(issued) < j.u.urlMaxAge() {
		return url, nil
	}
	j.refresh.Lock()
	defer j.refresh.Unlock()
	// Another worker may have refreshed while we waited for the lock.
	j.mu.Lock()
	url2, issued2 := j.urls[n], j.urlsAt
	j.mu.Unlock()
	if url2 != "" && issued2.After(issued) && time.Since(issued2) < j.u.urlMaxAge() {
		return url2, nil
	}
	parts, err := j.u.Client.RefreshURLs(ctx, j.uploadID, j.missing())
	if err != nil {
		return "", err
	}
	j.setURLs(parts)
	j.mu.Lock()
	url = j.urls[n]
	j.mu.Unlock()
	if url == "" {
		return "", fmt.Errorf("the server gave no upload URL for part %d", n)
	}
	return url, nil
}

type permanentError struct{ err error }

func (e *permanentError) Error() string { return e.err.Error() }
func (e *permanentError) Unwrap() error { return e.err }

// put sends one part and returns its ETag.
func (j *job) put(ctx context.Context, n int, url string, counter *atomic.Int64) (string, error) {
	length := j.partLen(n)
	off := int64(n-1) * j.partSize

	pctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	var body io.Reader = http.NoBody
	if length > 0 {
		body = &countingReader{r: io.NewSectionReader(j.f, off, length), n: counter}
	}
	req, err := http.NewRequestWithContext(pctx, http.MethodPut, url, body)
	if err != nil {
		return "", &permanentError{fmt.Errorf("part %d: bad upload URL: %w", n, err)}
	}
	// A known length: R2 needs Content-Length (no chunked encoding).
	req.ContentLength = length
	if length > 0 {
		req.GetBody = func() (io.ReadCloser, error) {
			counter.Store(0)
			return io.NopCloser(&countingReader{r: io.NewSectionReader(j.f, off, length), n: counter}), nil
		}
	}

	// Stall watchdog: abort a PUT whose bytes stop moving (a dead connection
	// can otherwise hang for a very long time). The transfer itself has no
	// deadline.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		stall := j.u.stall()
		t := time.NewTicker(max(min(stall/4, 5*time.Second), 10*time.Millisecond))
		defer t.Stop()
		last, since := counter.Load(), time.Now()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if c := counter.Load(); c != last {
					last, since = c, time.Now()
				} else if time.Since(since) > stall && last < length {
					cancel(fmt.Errorf("no progress for %s", stall))
					return
				}
			}
		}
	}()

	hc := j.u.PartHTTP
	if hc == nil {
		hc = defaultPartClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		if cause := context.Cause(pctx); cause != nil && ctx.Err() == nil {
			return "", cause
		}
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		etag := resp.Header.Get("ETag")
		if etag == "" {
			return "", fmt.Errorf("the storage accepted part %d but returned no ETag", n)
		}
		return etag, nil
	}
	msg := storageMessage(data)
	switch {
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized ||
		(resp.StatusCode == http.StatusBadRequest && strings.Contains(strings.ToLower(msg), "expired")):
		return "", fmt.Errorf("%w (HTTP %d: %s)", errExpired, resp.StatusCode, msg)
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout ||
		resp.StatusCode == http.StatusTooManyRequests:
		return "", fmt.Errorf("HTTP %d from storage: %s", resp.StatusCode, msg)
	}
	return "", &permanentError{fmt.Errorf("part %d was rejected by the storage: HTTP %d: %s", n, resp.StatusCode, msg)}
}

// storageMessage pulls <Message> out of an S3-style XML error.
func storageMessage(body []byte) string {
	s := string(body)
	if i := strings.Index(s, "<Message>"); i >= 0 {
		if k := strings.Index(s[i:], "</Message>"); k > 0 {
			return s[i+len("<Message>") : i+k]
		}
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "no details"
	}
	return truncate(s, 200)
}

type countingReader struct {
	r io.Reader
	n *atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n.Add(int64(k))
	return k, err
}

var defaultPartClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 5 * time.Minute, // after the body is sent: the storage acknowledges quickly
		ExpectContinueTimeout: time.Second,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		// One TCP connection per part in flight (HTTP/1.1) moves bulk data
		// faster than multiplexing every part over one HTTP/2 connection.
		ForceAttemptHTTP2: false,
	},
}

// hashFile computes the sha256 of f (from the start), reporting progress.
func hashFile(ctx context.Context, f *os.File, size int64, every time.Duration, report func(int64)) (string, error) {
	h := sha256.New()
	buf := make([]byte, 1<<20)
	var done int64
	last := time.Now()
	report(0)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		k, err := f.ReadAt(buf, done)
		if k > 0 {
			h.Write(buf[:k])
			done += int64(k)
			if time.Since(last) >= every {
				report(min(done, size))
				last = time.Now()
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("cannot read %s: %w", f.Name(), err)
		}
	}
	if done != size {
		return "", fmt.Errorf("%s changed while it was being read (%d bytes, expected %d)", f.Name(), done, size)
	}
	report(done)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SHA256File hashes a file (used by tests and callers that want the digest).
func SHA256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	return hashFile(context.Background(), f, fi.Size(), time.Hour, func(int64) {})
}

// Content types the Markdrop registry knows, by extension. The server also
// resolves the type from the file name, so this only needs to be a good hint.
var contentTypes = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mkv": "video/x-matroska", ".ogv": "video/ogg",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif",
	".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
	".txt": "text/plain", ".md": "text/markdown", ".zip": "application/zip",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls":  "application/vnd.ms-excel",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

// ContentTypeFor guesses a file's MIME type from its name.
func ContentTypeFor(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := contentTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return strings.TrimSpace(strings.Split(t, ";")[0])
	}
	return "application/octet-stream"
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func unwrapPath(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
