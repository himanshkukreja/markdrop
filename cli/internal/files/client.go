// Package files uploads files to Markdrop and manages their versions through
// the /api/v1/files API: a file is published (or replaced behind the same
// link) by PUTting it in parts to pre-signed URLs the server hands out, then
// asking the server to assemble and verify it.
//
// It is shared by the CLI commands (upload, replace, versions, restore, info)
// and by the local MCP server's file tools.
package files

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// TokensURL is where a user creates an API token.
const TokensURL = "https://markdrop.in/settings/tokens"

// ErrNoToken is returned when no API token is configured.
var ErrNoToken = errors.New("no Markdrop API token: set MARKDROP_TOKEN (or run `markdrop login`); " +
	"create one at " + TokensURL)

// Client talks to the Markdrop API.
type Client struct {
	Base      string       // API base URL, e.g. https://api.markdrop.in
	Token     string       // API token (mdk_…) or session JWT, sent as a Bearer token
	UserAgent string       // e.g. markdrop-cli/0.4.0
	HTTP      *http.Client // for API calls; nil = a client with a 2-minute timeout

	// Retry tuning for transient API failures (tests shorten it).
	Attempts int           // default 4
	Backoff  time.Duration // first delay, doubled each time; default 1s
}

// APIError is a non-2xx answer from the API.
type APIError struct {
	Status int
	Detail string // the server's "detail", or the body
	Op     string // what we were doing, e.g. "start the upload"
}

func (e *APIError) Error() string {
	detail := e.Detail
	if detail == "" {
		detail = http.StatusText(e.Status)
	}
	switch e.Status {
	case http.StatusUnauthorized:
		return fmt.Sprintf("the API token was rejected (%s); create a new one at %s", detail, TokensURL)
	case http.StatusForbidden:
		return fmt.Sprintf("not allowed to %s: %s", e.Op, detail)
	case http.StatusNotFound:
		return fmt.Sprintf("could not %s: not found (%s)", e.Op, detail)
	case http.StatusRequestEntityTooLarge:
		return fmt.Sprintf("could not %s: file too large (%s)", e.Op, detail)
	case http.StatusInsufficientStorage:
		return fmt.Sprintf("could not %s: storage quota exceeded (%s)", e.Op, detail)
	case http.StatusTooManyRequests:
		return fmt.Sprintf("could not %s: rate limited, try again in a minute (%s)", e.Op, detail)
	}
	return fmt.Sprintf("could not %s: %s (HTTP %d)", e.Op, detail, e.Status)
}

// IsStatus reports whether err is an APIError with one of the given statuses.
func IsStatus(err error, statuses ...int) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	for _, s := range statuses {
		if ae.Status == s {
			return true
		}
	}
	return false
}

// ── API shapes (section 1 of the contract) ──────────────────────────────────

// CreateUploadRequest is POST /api/v1/files/uploads.
type CreateUploadRequest struct {
	FileName    string `json:"file_name"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
	SHA256      string `json:"sha256"`
	TargetSlug  string `json:"target_slug,omitempty"`
	Title       string `json:"title,omitempty"`
	Access      string `json:"access,omitempty"`
	Password    string `json:"password,omitempty"`
	Workspace   string `json:"workspace,omitempty"`
}

// PartURL is a pre-signed URL for one part.
type PartURL struct {
	PartNumber int    `json:"part_number"`
	URL        string `json:"url"`
}

// CreateUploadResponse is the answer to CreateUploadRequest.
type CreateUploadResponse struct {
	UploadID  string    `json:"upload_id"`
	PartSize  int64     `json:"part_size"`
	Parts     []PartURL `json:"parts"`
	ExpiresAt string    `json:"expires_at"`
}

// UploadedPart is one part R2 already holds.
type UploadedPart struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
	Size       int64  `json:"size,omitempty"`
}

// UploadStatus is GET /api/v1/files/uploads/{id}.
type UploadStatus struct {
	State         string          `json:"state"`
	SizeBytes     int64           `json:"size_bytes"`
	PartSize      int64           `json:"part_size"`
	PartsUploaded []UploadedPart  `json:"parts_uploaded"`
	TargetSlug    *string         `json:"target_slug"`
	ExpiresAt     string          `json:"expires_at"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         json.RawMessage `json:"error,omitempty"`
}

// ErrorText renders the session's error (a string or an object).
func (s *UploadStatus) ErrorText() string {
	return rawText(s.Error)
}

// Result is the outcome of a completed upload.
type Result struct {
	URL         string `json:"url"`
	Slug        string `json:"slug"`
	Version     int    `json:"version"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
	SHA256      string `json:"sha256"`

	// Raw is the API's JSON exactly as received (what --json prints).
	Raw json.RawMessage `json:"-"`
}

// Media is what the server learned about an audio/video file.
type Media struct {
	DurationS  *float64 `json:"duration_s,omitempty" jsonschema:"Duration in seconds"`
	Width      *int     `json:"width,omitempty"`
	Height     *int     `json:"height,omitempty"`
	VideoCodec *string  `json:"video_codec,omitempty"`
	AudioCodec *string  `json:"audio_codec,omitempty"`
}

// FileInfo is GET /api/v1/files/{slug} (and the answer to a restore).
type FileInfo struct {
	Slug        string  `json:"slug"`
	URL         string  `json:"url"`
	ContentType string  `json:"content_type"`
	SizeBytes   int64   `json:"size_bytes"`
	SHA256      *string `json:"sha256"`
	Version     int     `json:"version"`
	UpdatedAt   string  `json:"updated_at"`
	CreatedAt   string  `json:"created_at"`
	Media       *Media  `json:"media"`
	PosterURL   *string `json:"poster_url"`

	Raw json.RawMessage `json:"-"`
}

// Version is one row of GET /api/v1/files/{slug}/versions.
type Version struct {
	Version     int     `json:"version"`
	SizeBytes   int64   `json:"size_bytes"`
	SHA256      *string `json:"sha256"`
	ContentType string  `json:"content_type"`
	CreatedAt   string  `json:"created_at"`
	Current     bool    `json:"current"`
	Media       *Media  `json:"media,omitempty"`
}

// Versions is GET /api/v1/files/{slug}/versions.
type Versions struct {
	Versions []Version `json:"versions"`

	Raw json.RawMessage `json:"-"`
}

// ── Calls ───────────────────────────────────────────────────────────────────

// CreateUpload starts an upload session.
func (c *Client) CreateUpload(ctx context.Context, req CreateUploadRequest) (*CreateUploadResponse, error) {
	var out CreateUploadResponse
	if _, err := c.do(ctx, http.MethodPost, "/api/v1/files/uploads", req, &out, "start the upload"); err != nil {
		return nil, err
	}
	if out.UploadID == "" || out.PartSize <= 0 {
		return nil, fmt.Errorf("the server's upload session is missing upload_id or part_size")
	}
	return &out, nil
}

// RefreshURLs asks for fresh pre-signed URLs; nil parts = every part not yet uploaded.
func (c *Client) RefreshURLs(ctx context.Context, uploadID string, parts []int) ([]PartURL, error) {
	body := map[string]any{}
	if parts != nil {
		body["part_numbers"] = parts
	}
	var out struct {
		Parts []PartURL `json:"parts"`
	}
	if _, err := c.do(ctx, http.MethodPost, "/api/v1/files/uploads/"+url.PathEscape(uploadID)+"/urls",
		body, &out, "refresh the upload URLs"); err != nil {
		return nil, err
	}
	return out.Parts, nil
}

// UploadStatus reads an upload session.
func (c *Client) UploadStatus(ctx context.Context, uploadID string) (*UploadStatus, error) {
	var out UploadStatus
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/files/uploads/"+url.PathEscape(uploadID),
		nil, &out, "read the upload session"); err != nil {
		return nil, err
	}
	return &out, nil
}

// Complete asks the server to assemble the parts. It returns either the
// final result, or (verifying=true) nil while the server is still checking
// the file's sha256; poll UploadStatus then.
func (c *Client) Complete(ctx context.Context, uploadID string, parts []UploadedPart) (res *Result, verifying bool, err error) {
	type part struct {
		PartNumber int    `json:"part_number"`
		ETag       string `json:"etag"`
	}
	body := struct {
		Parts []part `json:"parts"`
	}{Parts: make([]part, len(parts))}
	for i, p := range parts {
		body.Parts[i] = part{p.PartNumber, p.ETag}
	}
	var raw json.RawMessage
	status, err := c.do(ctx, http.MethodPost, "/api/v1/files/uploads/"+url.PathEscape(uploadID)+"/complete",
		body, &raw, "finish the upload")
	if err != nil {
		return nil, false, err
	}
	if status == http.StatusAccepted {
		return nil, true, nil
	}
	// A 200 can in principle still carry {state:"verifying"}: treat it the same.
	var probe struct {
		State string `json:"state"`
		URL   string `json:"url"`
	}
	_ = json.Unmarshal(raw, &probe)
	if probe.URL == "" && probe.State != "" && probe.State != "done" {
		return nil, true, nil
	}
	r, err := ParseResult(raw)
	return r, false, err
}

// ParseResult decodes an upload result, keeping the raw JSON.
func ParseResult(raw json.RawMessage) (*Result, error) {
	var r Result
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if r.URL == "" || r.Slug == "" {
		return nil, fmt.Errorf("unexpected answer from the server (no url/slug): %s", truncate(string(raw), 200))
	}
	r.Raw = append(json.RawMessage(nil), raw...)
	return &r, nil
}

// FileInfo reads a file's current state.
func (c *Client) FileInfo(ctx context.Context, slug string) (*FileInfo, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/files/"+url.PathEscape(slug), nil, &raw,
		"read "+slug); err != nil {
		return nil, err
	}
	return parseInfo(raw)
}

// Versions lists a file's versions, newest first.
func (c *Client) Versions(ctx context.Context, slug string) (*Versions, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/files/"+url.PathEscape(slug)+"/versions", nil, &raw,
		"list the versions of "+slug); err != nil {
		return nil, err
	}
	var v Versions
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if v.Versions == nil {
		v.Versions = []Version{}
	}
	v.Raw = raw
	return &v, nil
}

// Restore makes an old version current again (as a new version).
func (c *Client) Restore(ctx context.Context, slug string, version int) (*FileInfo, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodPost,
		fmt.Sprintf("/api/v1/files/%s/versions/%d/restore", url.PathEscape(slug), version), map[string]any{}, &raw,
		fmt.Sprintf("restore version %d of %s", version, slug)); err != nil {
		return nil, err
	}
	return parseInfo(raw)
}

// Me returns the token owner's e-mail address (GET /api/v1/auth/me).
func (c *Client) Me(ctx context.Context) (string, error) {
	var out struct {
		Email string `json:"email"`
	}
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/auth/me", nil, &out, "check the token"); err != nil {
		return "", err
	}
	return out.Email, nil
}

func parseInfo(raw json.RawMessage) (*FileInfo, error) {
	var fi FileInfo
	if err := json.Unmarshal(raw, &fi); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	fi.Raw = raw
	return &fi, nil
}

// do sends one API request, retrying transient failures (network errors,
// 429, 502, 503, 504) with backoff. It returns the HTTP status.
func (c *Client) do(ctx context.Context, method, path string, body, out any, op string) (int, error) {
	if strings.TrimSpace(c.Token) == "" {
		return 0, ErrNoToken
	}
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return 0, err
		}
	}
	attempts := c.Attempts
	if attempts <= 0 {
		attempts = 4
	}
	backoff := c.Backoff
	if backoff <= 0 {
		backoff = time.Second
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			delay := backoffDelay(backoff, attempt-1, 20*time.Second)
			var ae *APIError
			if errors.As(lastErr, &ae) && ae.Status == http.StatusTooManyRequests {
				delay = max(delay, 5*time.Second)
			}
			if err := sleepCtx(ctx, delay); err != nil {
				return 0, err
			}
		}
		status, err := c.once(ctx, method, path, payload, out, op)
		if err == nil {
			return status, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		if !retryableAPI(err) {
			return status, err
		}
	}
	return 0, lastErr
}

func (c *Client) once(ctx context.Context, method, path string, payload []byte, out any, op string) (int, error) {
	var rd io.Reader
	if payload != nil {
		rd = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Base, "/")+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.Token))
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	hc := c.HTTP
	if hc == nil {
		hc = defaultAPIClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, &netError{op: op, err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return resp.StatusCode, &netError{op: op, err: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return resp.StatusCode, &APIError{Status: resp.StatusCode, Detail: detailOf(data), Op: op}
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if raw, ok := out.(*json.RawMessage); ok {
			*raw = append((*raw)[:0], data...)
		} else if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("could not %s: unexpected answer from the server: %w", op, err)
		}
	}
	return resp.StatusCode, nil
}

var defaultAPIClient = &http.Client{Timeout: 2 * time.Minute}

type netError struct {
	op  string
	err error
}

func (e *netError) Error() string { return fmt.Sprintf("could not %s: %v", e.op, e.err) }
func (e *netError) Unwrap() error { return e.err }

func retryableAPI(err error) bool {
	var ne *netError
	if errors.As(err, &ne) {
		return !errors.Is(err, context.Canceled)
	}
	return IsStatus(err, http.StatusTooManyRequests, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout)
}

// detailOf extracts FastAPI's {"detail": "..."} (or a validation error list).
func detailOf(body []byte) string {
	var env struct {
		Detail json.RawMessage `json:"detail"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil {
		if t := rawText(env.Detail); t != "" {
			return t
		}
		if t := rawText(env.Error); t != "" {
			return t
		}
	}
	return truncate(strings.TrimSpace(string(body)), 300)
}

// rawText renders a JSON string, a list of {msg} objects, or any JSON.
func rawText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var list []struct {
		Msg string `json:"msg"`
		Loc []any  `json:"loc"`
	}
	if json.Unmarshal(raw, &list) == nil && len(list) > 0 && list[0].Msg != "" {
		msgs := make([]string, 0, len(list))
		for _, l := range list {
			if len(l.Loc) > 0 {
				msgs = append(msgs, fmt.Sprintf("%v: %s", l.Loc[len(l.Loc)-1], l.Msg))
			} else {
				msgs = append(msgs, l.Msg)
			}
		}
		return strings.Join(msgs, "; ")
	}
	var obj struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if obj.Message != "" {
			return obj.Message
		}
		if obj.Detail != "" {
			return obj.Detail
		}
	}
	return truncate(string(raw), 300)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// backoffDelay is base·2^n, capped, with ±25 % jitter.
func backoffDelay(base time.Duration, n int, maxDelay time.Duration) time.Duration {
	d := base << min(n, 16)
	if d > maxDelay || d <= 0 {
		d = maxDelay
	}
	jitter := time.Duration(rand.Int64N(int64(d)/2+1)) - d/4
	return d + jitter
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ── Slugs ───────────────────────────────────────────────────────────────────

var slugRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ParseSlug accepts a slug, "/slug", "markdrop.in/slug" or a full link
// (https://markdrop.in/<slug>, www., localhost, a workspace address) and
// returns the slug: the link's last path segment. Query strings and
// fragments are dropped.
func ParseSlug(value string) (string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", errors.New("give a document slug or its Markdrop link")
	}
	candidate := text
	if strings.ContainsAny(text, "/.") {
		raw := text
		switch {
		case strings.Contains(text, "://"):
		case strings.HasPrefix(text, "/"):
			raw = "https://markdrop.in" + text
		default:
			raw = "https://" + text
		}
		u, err := url.Parse(raw)
		if err != nil {
			return "", fmt.Errorf("%q doesn't look like a Markdrop link or slug", value)
		}
		var segs []string
		for _, s := range strings.Split(u.Path, "/") {
			if s != "" {
				segs = append(segs, s)
			}
		}
		if len(segs) >= 2 && segs[len(segs)-2] == "share" {
			return "", fmt.Errorf("%q is a peer-to-peer share link, not a published file", value)
		}
		candidate = ""
		if len(segs) > 0 {
			candidate = segs[len(segs)-1]
		}
	}
	if !slugRE.MatchString(candidate) {
		return "", fmt.Errorf("%q doesn't look like a Markdrop link or slug", value)
	}
	return candidate, nil
}

// ParseVersion accepts "3" or "v3".
func ParseVersion(s string) (int, error) {
	t := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "v")
	n, err := strconv.Atoi(t)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%q is not a version number (1, 2, 3, …)", s)
	}
	return n, nil
}
