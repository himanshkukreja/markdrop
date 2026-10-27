// Package fakeapi is an in-memory stand-in for Markdrop's /api/v1/files API
// and for the storage's pre-signed part URLs, for tests. It follows the
// contract in section 1 of the file-versions spec and records what clients
// did so tests can assert on it (which parts were sent, how often, …).
package fakeapi

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Users' tokens.
const (
	Token      = "mdk_testowner"
	OtherToken = "mdk_someoneelse"
)

// Server is the fake. Configure the exported fields before the first request
// (or under Lock/Unlock).
type Server struct {
	*httptest.Server
	WebBase string // what result URLs start with

	PartSize    int64         // default 1 MiB
	URLTTL      time.Duration // pre-signed URL lifetime; default 1h
	MaxBytes    int64         // per-file ceiling; default 2 GiB
	VerifyPolls int           // complete answers 202 and GET says "verifying" this many times
	Corrupt     bool          // the server's sha256 never matches (simulates corruption in transit)
	// PartHook runs before a part is stored; a non-zero status fails the PUT.
	PartHook func(uploadID string, part, attempt int) int
	// AfterStore runs after a part is stored (outside the lock); it may block.
	AfterStore func(uploadID string, part int)

	mu       sync.Mutex
	gen      int // bumping it expires every URL issued so far
	sessions map[string]*session
	docs     map[string]*Doc

	// Counters and logs.
	PartPuts     map[int]int // PUT attempts per part number (any outcome)
	PartsStored  map[int]int // successful PUTs per part number
	Creates      int
	Completes    int
	URLRefreshes []([]int) // part_numbers of each /urls call (nil = all)
	StatusGets   int
	LastCreate   map[string]any
	AuthHeaders  []string
	maxInFlight  int
	inFlight     int
}

type session struct {
	ID        string
	Owner     string
	Req       map[string]any
	FileName  string
	Size      int64
	SHA       string
	CType     string
	Target    string
	PartSize  int64
	Parts     map[int][]byte
	ETags     map[int]string
	State     string
	Result    map[string]any
	Err       string
	ExpiresAt time.Time
	polls     int
}

// Version is one stored version of a document.
type Version struct {
	Version int
	Data    []byte
	SHA     *string
	CType   string
	Created time.Time
}

// Doc is a document the fake knows.
type Doc struct {
	Slug     string
	Owner    string
	Kind     string // "artifact" or "markdown"
	Title    string
	Access   string
	Views    int
	Versions []*Version // oldest first
	Current  int
	Created  time.Time
	Updated  time.Time
}

// New starts a fake. Close it with t.Cleanup(s.Close).
func New() *Server {
	s := &Server{
		PartSize: 1 << 20, URLTTL: time.Hour, MaxBytes: 2 << 30,
		sessions: map[string]*session{}, docs: map[string]*Doc{},
		PartPuts: map[int]int{}, PartsStored: map[int]int{},
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	s.WebBase = "http://localhost:3000"
	return s
}

// Lock / Unlock guard the exported fields while requests run.
func (s *Server) Lock()   { s.mu.Lock() }
func (s *Server) Unlock() { s.mu.Unlock() }

// AddDoc creates a document owned by owner (Token or OtherToken).
func (s *Server) AddDoc(slug, owner, kind string, data []byte, ctype string) *Doc {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC().Add(-time.Hour)
	sum := sha256.Sum256(data)
	h := hex.EncodeToString(sum[:])
	d := &Doc{Slug: slug, Owner: owner, Kind: kind, Title: slug, Access: "link", Views: 7, Created: now, Updated: now,
		Versions: []*Version{{Version: 1, Data: data, SHA: &h, CType: ctype, Created: now}}, Current: 1}
	s.docs[slug] = d
	return d
}

// Doc returns a copy of a document's current state (nil if missing).
func (s *Server) Doc(slug string) *Doc {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil {
		return nil
	}
	c := *d
	c.Versions = append([]*Version(nil), d.Versions...)
	return &c
}

// CurrentData is the bytes a document serves now.
func (s *Server) CurrentData(slug string) []byte {
	d := s.Doc(slug)
	if d == nil {
		return nil
	}
	return d.cur().Data
}

func (d *Doc) cur() *Version {
	for _, v := range d.Versions {
		if v.Version == d.Current {
			return v
		}
	}
	return nil
}

// ExpireURLs makes every pre-signed URL issued so far fail as expired.
func (s *Server) ExpireURLs() {
	s.mu.Lock()
	s.gen++
	s.mu.Unlock()
}

// ExpireSession drops an upload session, as the server's TTL would.
func (s *Server) ExpireSession(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// SessionIDs lists the upload sessions created so far.
func (s *Server) SessionIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []string
	for id := range s.sessions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// MaxInFlight is the most part PUTs that ran at once.
func (s *Server) MaxInFlight() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxInFlight
}

// TotalPuts sums PartPuts.
func (s *Server) TotalPuts() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, c := range s.PartPuts {
		n += c
	}
	return n
}

// Counts returns copies of PartPuts and PartsStored.
func (s *Server) Counts() (puts, stored map[int]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	puts, stored = map[int]int{}, map[int]int{}
	for k, v := range s.PartPuts {
		puts[k] = v
	}
	for k, v := range s.PartsStored {
		stored[k] = v
	}
	return
}

// ResetCounts zeroes the counters.
func (s *Server) ResetCounts() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.PartPuts, s.PartsStored = map[int]int{}, map[int]int{}
	s.Creates, s.Completes, s.StatusGets = 0, 0, 0
	s.URLRefreshes = nil
	s.maxInFlight = 0
}

// ── HTTP ────────────────────────────────────────────────────────────────────

var (
	reUploads  = regexp.MustCompile(`^/api/v1/files/uploads$`)
	reUpload   = regexp.MustCompile(`^/api/v1/files/uploads/([^/]+)$`)
	reURLs     = regexp.MustCompile(`^/api/v1/files/uploads/([^/]+)/urls$`)
	reComplete = regexp.MustCompile(`^/api/v1/files/uploads/([^/]+)/complete$`)
	reInfo     = regexp.MustCompile(`^/api/v1/files/([A-Za-z0-9_-]+)$`)
	reVersions = regexp.MustCompile(`^/api/v1/files/([A-Za-z0-9_-]+)/versions$`)
	reRestore  = regexp.MustCompile(`^/api/v1/files/([A-Za-z0-9_-]+)/versions/(\d+)/restore$`)
	rePart     = regexp.MustCompile(`^/r2/([^/]+)/(\d+)$`)
	hex64      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if m := rePart.FindStringSubmatch(p); m != nil && r.Method == http.MethodPut {
		n, _ := strconv.Atoi(m[2])
		s.putPart(w, r, m[1], n)
		return
	}
	user, ok := s.auth(r)
	if !ok {
		detail(w, 401, "Invalid API token")
		return
	}
	switch {
	case r.Method == http.MethodGet && p == "/api/v1/auth/me":
		writeJSON(w, 200, map[string]any{"id": user, "email": strings.TrimPrefix(user, "mdk_") + "@example.com"})
	case r.Method == http.MethodPost && reUploads.MatchString(p):
		s.create(w, r, user)
	case r.Method == http.MethodPost && reURLs.MatchString(p):
		s.urls(w, r, user, reURLs.FindStringSubmatch(p)[1])
	case r.Method == http.MethodPost && reComplete.MatchString(p):
		s.complete(w, r, user, reComplete.FindStringSubmatch(p)[1])
	case r.Method == http.MethodGet && reUpload.MatchString(p):
		s.status(w, user, reUpload.FindStringSubmatch(p)[1])
	case r.Method == http.MethodPost && reRestore.MatchString(p):
		m := reRestore.FindStringSubmatch(p)
		n, _ := strconv.Atoi(m[2])
		s.restore(w, user, m[1], n)
	case r.Method == http.MethodGet && reVersions.MatchString(p):
		s.versions(w, user, reVersions.FindStringSubmatch(p)[1])
	case r.Method == http.MethodGet && reInfo.MatchString(p):
		s.info(w, user, reInfo.FindStringSubmatch(p)[1])
	default:
		detail(w, 404, "Not Found")
	}
}

func (s *Server) auth(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	s.mu.Lock()
	s.AuthHeaders = append(s.AuthHeaders, h)
	s.mu.Unlock()
	tok, ok := strings.CutPrefix(h, "Bearer ")
	if !ok || (tok != Token && tok != OtherToken) {
		return "", false
	}
	return tok, true
}

func detail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"detail": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func (s *Server) partURL(id string, n int) string {
	exp := time.Now().Add(s.URLTTL).UnixNano()
	return fmt.Sprintf("%s/r2/%s/%d?exp=%d&gen=%d&sig=fake", s.URL, id, n, exp, s.gen)
}

func (s *Server) nParts(ses *session) int {
	n := int((ses.Size + ses.PartSize - 1) / ses.PartSize)
	if n < 1 {
		n = 1
	}
	return n
}

func (s *Server) create(w http.ResponseWriter, r *http.Request, user string) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		detail(w, 422, "invalid JSON")
		return
	}
	str := func(k string) string { v, _ := req[k].(string); return v }
	size, _ := req["size_bytes"].(float64)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Creates++
	s.LastCreate = req
	if str("file_name") == "" || !hex64.MatchString(str("sha256")) || size < 0 {
		detail(w, 422, "file_name, size_bytes and sha256 (64 hex) are required")
		return
	}
	if int64(size) > s.MaxBytes {
		detail(w, 413, fmt.Sprintf("This file is too large (max %d bytes)", s.MaxBytes))
		return
	}
	if t := str("target_slug"); t != "" {
		d := s.docs[t]
		if d == nil {
			detail(w, 404, "Document not found")
			return
		}
		if d.Owner != user {
			detail(w, 403, "You don't own this document")
			return
		}
		if d.Kind != "artifact" {
			detail(w, 409, fmt.Sprintf("%s is a markdown document; use update_document", t))
			return
		}
	}
	ses := &session{
		ID: randomID(), Owner: user, Req: req, FileName: str("file_name"), Size: int64(size), SHA: str("sha256"),
		CType: str("content_type"), Target: str("target_slug"), PartSize: s.PartSize,
		Parts: map[int][]byte{}, ETags: map[int]string{}, State: "uploading",
		ExpiresAt: time.Now().Add(48 * time.Hour),
	}
	s.sessions[ses.ID] = ses
	var parts []map[string]any
	for n := 1; n <= s.nParts(ses); n++ {
		parts = append(parts, map[string]any{"part_number": n, "url": s.partURL(ses.ID, n)})
	}
	writeJSON(w, 200, map[string]any{
		"upload_id": ses.ID, "part_size": ses.PartSize, "parts": parts,
		"expires_at": iso(time.Now().Add(s.URLTTL)),
	})
}

// session looks up an upload the caller owns (404 otherwise).
func (s *Server) session(w http.ResponseWriter, user, id string) *session {
	ses := s.sessions[id]
	if ses == nil || ses.Owner != user {
		detail(w, 404, "Upload not found or expired")
		return nil
	}
	return ses
}

func (s *Server) urls(w http.ResponseWriter, r *http.Request, user, id string) {
	var body struct {
		PartNumbers []int `json:"part_numbers"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.URLRefreshes = append(s.URLRefreshes, body.PartNumbers)
	ses := s.session(w, user, id)
	if ses == nil {
		return
	}
	if ses.State != "uploading" {
		detail(w, 409, "This upload is "+ses.State)
		return
	}
	want := body.PartNumbers
	if want == nil {
		for n := 1; n <= s.nParts(ses); n++ {
			if _, ok := ses.Parts[n]; !ok {
				want = append(want, n)
			}
		}
	}
	parts := []map[string]any{}
	for _, n := range want {
		if n < 1 || n > s.nParts(ses) {
			detail(w, 422, fmt.Sprintf("part %d is out of range", n))
			return
		}
		parts = append(parts, map[string]any{"part_number": n, "url": s.partURL(ses.ID, n)})
	}
	writeJSON(w, 200, map[string]any{"upload_id": id, "parts": parts, "expires_at": iso(time.Now().Add(s.URLTTL))})
}

func (s *Server) statusBody(ses *session) map[string]any {
	uploaded := []map[string]any{}
	var nums []int
	for n := range ses.Parts {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	for _, n := range nums {
		uploaded = append(uploaded, map[string]any{"part_number": n, "etag": ses.ETags[n], "size": len(ses.Parts[n])})
	}
	var target any
	if ses.Target != "" {
		target = ses.Target
	}
	out := map[string]any{
		"state": ses.State, "size_bytes": ses.Size, "part_size": ses.PartSize, "parts_uploaded": uploaded,
		"target_slug": target, "expires_at": iso(ses.ExpiresAt),
	}
	if ses.State == "done" {
		out["result"] = ses.Result
	}
	if ses.State == "failed" {
		out["error"] = ses.Err
	}
	return out
}

func (s *Server) status(w http.ResponseWriter, user, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.StatusGets++
	ses := s.session(w, user, id)
	if ses == nil {
		return
	}
	if ses.State == "verifying" {
		ses.polls++
		if ses.polls > s.VerifyPolls {
			s.finish(ses)
		}
	}
	writeJSON(w, 200, s.statusBody(ses))
}

func (s *Server) putPart(w http.ResponseWriter, r *http.Request, id string, n int) {
	q := r.URL.Query()
	exp, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
	gen, _ := strconv.Atoi(q.Get("gen"))

	s.mu.Lock()
	s.PartPuts[n]++
	attempt := s.PartPuts[n]
	hook := s.PartHook
	expired := time.Now().UnixNano() > exp || gen != s.gen
	ses := s.sessions[id]
	s.inFlight++
	if s.inFlight > s.maxInFlight {
		s.maxInFlight = s.inFlight
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()
	}()

	if expired {
		w.WriteHeader(403)
		_, _ = io.WriteString(w, `<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>`)
		return
	}
	if ses == nil {
		w.WriteHeader(404)
		_, _ = io.WriteString(w, `<Error><Code>NoSuchUpload</Code><Message>The specified upload does not exist</Message></Error>`)
		return
	}
	if r.ContentLength < 0 || len(r.TransferEncoding) > 0 {
		w.WriteHeader(411)
		_, _ = io.WriteString(w, `<Error><Code>MissingContentLength</Code><Message>You must provide the Content-Length HTTP header.</Message></Error>`)
		return
	}
	if hook != nil {
		if code := hook(id, n, attempt); code != 0 {
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(code)
			_, _ = io.WriteString(w, `<Error><Code>InternalError</Code><Message>injected failure</Message></Error>`)
			return
		}
	}
	data, err := io.ReadAll(r.Body)
	if err != nil || int64(len(data)) != r.ContentLength {
		return // the client went away mid-part: nothing stored
	}
	sum := md5.Sum(data)
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	s.mu.Lock()
	ses.Parts[n] = data
	ses.ETags[n] = etag
	s.PartsStored[n]++
	after := s.AfterStore
	s.mu.Unlock()
	if after != nil {
		after(id, n)
	}
	w.Header().Set("ETag", etag)
	w.WriteHeader(200)
}

func (s *Server) complete(w http.ResponseWriter, r *http.Request, user, id string) {
	var body struct {
		Parts []struct {
			PartNumber int    `json:"part_number"`
			ETag       string `json:"etag"`
		} `json:"parts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		detail(w, 422, "invalid JSON")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Completes++
	ses := s.session(w, user, id)
	if ses == nil {
		return
	}
	switch ses.State {
	case "done":
		writeJSON(w, 200, ses.Result)
		return
	case "verifying":
		writeJSON(w, 202, map[string]any{"state": "verifying", "upload_id": id})
		return
	case "failed":
		detail(w, 422, ses.Err)
		return
	}
	if len(body.Parts) != s.nParts(ses) {
		detail(w, 400, fmt.Sprintf("expected %d parts, got %d", s.nParts(ses), len(body.Parts)))
		return
	}
	var buf bytes.Buffer
	for i, p := range body.Parts {
		if p.PartNumber != i+1 {
			detail(w, 400, "parts must be in order")
			return
		}
		if ses.ETags[p.PartNumber] == "" || ses.ETags[p.PartNumber] != p.ETag {
			detail(w, 400, fmt.Sprintf("part %d is missing or its etag does not match", p.PartNumber))
			return
		}
		buf.Write(ses.Parts[p.PartNumber])
	}
	if int64(buf.Len()) != ses.Size {
		ses.State, ses.Err = "failed", fmt.Sprintf("size mismatch: got %d bytes, declared %d", buf.Len(), ses.Size)
		detail(w, 422, ses.Err)
		return
	}
	sum := sha256.Sum256(buf.Bytes())
	got := hex.EncodeToString(sum[:])
	if s.Corrupt {
		got = strings.Repeat("0", 64)
	}
	if got != ses.SHA {
		ses.State = "failed"
		ses.Err = fmt.Sprintf("sha256 mismatch: the uploaded file hashes to %s, not the declared %s; nothing was changed", got[:12], ses.SHA[:12])
		if s.VerifyPolls > 0 {
			writeJSON(w, 202, map[string]any{"state": "verifying", "upload_id": id})
			return
		}
		detail(w, 422, ses.Err)
		return
	}
	ses.Parts = map[int][]byte{1: buf.Bytes()} // assembled
	if s.VerifyPolls > 0 {
		ses.State = "verifying"
		writeJSON(w, 202, map[string]any{"state": "verifying", "upload_id": id})
		return
	}
	s.finish(ses)
	writeJSON(w, 200, ses.Result)
}

// finish swaps the blob in (or creates the document). Caller holds mu.
func (s *Server) finish(ses *session) {
	data := ses.Parts[1]
	sha := ses.SHA
	now := time.Now().UTC()
	var d *Doc
	if ses.Target != "" {
		d = s.docs[ses.Target]
		next := 0
		for _, v := range d.Versions {
			next = max(next, v.Version)
		}
		next++
		d.Versions = append(d.Versions, &Version{Version: next, Data: data, SHA: &sha, CType: ses.CType, Created: now})
		d.Current = next
		d.Updated = now
		if t, _ := ses.Req["title"].(string); t != "" {
			d.Title = t
		}
		s.prune(d)
	} else {
		slug := s.slugFor(ses.FileName)
		title, _ := ses.Req["title"].(string)
		access, _ := ses.Req["access"].(string)
		if access == "" {
			access = "link"
		}
		d = &Doc{Slug: slug, Owner: ses.Owner, Kind: "artifact", Title: title, Access: access, Created: now, Updated: now,
			Versions: []*Version{{Version: 1, Data: data, SHA: &sha, CType: ses.CType, Created: now}}, Current: 1}
		s.docs[slug] = d
	}
	ses.State = "done"
	ses.Result = map[string]any{
		"url": s.WebBase + "/" + d.Slug, "slug": d.Slug, "version": d.Current, "size_bytes": len(data),
		"content_type": ses.CType, "sha256": sha,
	}
}

func (s *Server) prune(d *Doc) {
	for len(d.Versions) > 5 {
		for i, v := range d.Versions {
			if v.Version != d.Current {
				d.Versions = append(d.Versions[:i], d.Versions[i+1:]...)
				break
			}
		}
	}
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func (s *Server) slugFor(name string) string {
	base := strings.TrimSuffix(name, path.Ext(name))
	slug := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(base), "-"), "-")
	if slug == "" {
		slug = "file"
	}
	cand := slug
	for i := 2; s.docs[cand] != nil; i++ {
		cand = fmt.Sprintf("%s-%d", slug, i)
	}
	return cand
}

// owned returns the caller's document, writing 404/403/409 otherwise.
func (s *Server) owned(w http.ResponseWriter, user, slug string) *Doc {
	d := s.docs[slug]
	if d == nil {
		detail(w, 404, "Document not found")
		return nil
	}
	if d.Owner != user {
		detail(w, 403, "You don't own this document")
		return nil
	}
	if d.Kind != "artifact" {
		detail(w, 409, slug+" is a markdown document; use get_document")
		return nil
	}
	return d
}

func (s *Server) infoBody(d *Doc) map[string]any {
	v := d.cur()
	var media, poster any
	if strings.HasPrefix(v.CType, "video/") {
		media = map[string]any{"duration_s": 2.0, "width": 640, "height": 360, "video_codec": "h264", "audio_codec": nil}
		poster = s.WebBase + "/poster/" + d.Slug + ".jpg"
	}
	var sha any
	if v.SHA != nil {
		sha = *v.SHA
	}
	return map[string]any{
		"slug": d.Slug, "url": s.WebBase + "/" + d.Slug, "content_type": v.CType, "size_bytes": len(v.Data),
		"sha256": sha, "version": d.Current, "updated_at": iso(d.Updated), "created_at": iso(d.Created),
		"media": media, "poster_url": poster,
	}
}

func (s *Server) info(w http.ResponseWriter, user, slug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d := s.owned(w, user, slug); d != nil {
		writeJSON(w, 200, s.infoBody(d))
	}
}

func (s *Server) versions(w http.ResponseWriter, user, slug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.owned(w, user, slug)
	if d == nil {
		return
	}
	out := []map[string]any{}
	for i := len(d.Versions) - 1; i >= 0; i-- {
		v := d.Versions[i]
		var sha any
		if v.SHA != nil {
			sha = *v.SHA
		}
		out = append(out, map[string]any{
			"version": v.Version, "size_bytes": len(v.Data), "sha256": sha, "content_type": v.CType,
			"created_at": iso(v.Created), "current": v.Version == d.Current,
		})
	}
	writeJSON(w, 200, map[string]any{"versions": out})
}

func (s *Server) restore(w http.ResponseWriter, user, slug string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.owned(w, user, slug)
	if d == nil {
		return
	}
	var src *Version
	next := 0
	for _, v := range d.Versions {
		if v.Version == n {
			src = v
		}
		next = max(next, v.Version)
	}
	if src == nil {
		detail(w, 404, fmt.Sprintf("Version %d not found", n))
		return
	}
	now := time.Now().UTC()
	d.Versions = append(d.Versions, &Version{Version: next + 1, Data: src.Data, SHA: src.SHA, CType: src.CType, Created: now})
	d.Current = next + 1
	d.Updated = now
	s.prune(d)
	writeJSON(w, 200, s.infoBody(d))
}
