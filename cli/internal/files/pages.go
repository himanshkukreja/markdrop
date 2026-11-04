package files

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Pages are documents (editor "blocks"): GET/PUT /api/v1/documents/{slug}
// read and write them, POST /api/v1/pages creates one. This file holds those
// calls and the other document-level ones the CLI uses (link, export, page
// history, trash, access requests).

// Document is GET /api/v1/documents/{slug} (and PUT's answer), the fields the
// CLI uses. Raw keeps the whole answer.
type Document struct {
	Slug          string                     `json:"slug"`
	URL           string                     `json:"url"`
	WorkspaceURL  *string                    `json:"workspace_url"`
	Title         *string                    `json:"title"`
	Content       string                     `json:"content"`
	Rev           int                        `json:"rev"`
	Kind          string                     `json:"kind"`
	Editor        *string                    `json:"editor"`
	Encrypted     bool                       `json:"encrypted"`
	AccessLevel   string                     `json:"access_level"`
	WorkspaceID   *string                    `json:"workspace_id"`
	FolderPath    []string                   `json:"folder_path"`
	Parent        *PageRef                   `json:"parent"`
	ChildrenCount int                        `json:"children_count"`
	TemplateID    *string                    `json:"template_id"`
	Page          map[string]any             `json:"page"`
	Assets        map[string]json.RawMessage `json:"assets"`
	CoverAuto     bool                       `json:"cover_auto"`
	CoverPending  bool                       `json:"cover_pending"`
	CreatedAt     string                     `json:"created_at"`
	UpdatedAt     string                     `json:"updated_at"`

	Raw json.RawMessage `json:"-"`
}

// PageRef is a page's parent or a sub-page.
type PageRef struct {
	Slug  string  `json:"slug"`
	Title *string `json:"title"`
}

// CanonicalURL is the workspace's custom-domain link when it has one, else markdrop.in.
func (d *Document) CanonicalURL() string {
	if d.WorkspaceURL != nil && *d.WorkspaceURL != "" {
		return *d.WorkspaceURL
	}
	return d.URL
}

// TitleText is the title, or "" when it has none.
func (d *Document) TitleText() string {
	if d.Title == nil {
		return ""
	}
	return *d.Title
}

// IsPage reports whether the document opens in the page (block) editor.
func (d *Document) IsPage() bool { return d.Editor != nil && *d.Editor == "blocks" }

func parseDocument(raw json.RawMessage) (*Document, error) {
	var d Document
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	d.Raw = append(json.RawMessage(nil), raw...)
	return &d, nil
}

// ErrNotAPage is returned for a page command on a file (an artifact).
var ErrNotAPage = errors.New("that is a file, not a page; files are changed with `markdrop replace`")

// ErrEncrypted is returned when a command would need to read an end-to-end encrypted document.
var ErrEncrypted = errors.New("that document is end-to-end encrypted: only a browser with its key can read or change it")

// GetDocument reads a document, following a renamed slug to its current one.
func (c *Client) GetDocument(ctx context.Context, slug string) (*Document, error) {
	for hop := 0; hop < 2; hop++ {
		var raw json.RawMessage
		if _, err := c.do(ctx, http.MethodGet, "/api/v1/documents/"+url.PathEscape(slug), nil, &raw,
			"read "+slug); err != nil {
			return nil, err
		}
		var moved struct {
			Moved bool   `json:"moved"`
			Slug  string `json:"slug"`
		}
		_ = json.Unmarshal(raw, &moved)
		if moved.Moved && moved.Slug != "" && moved.Slug != slug {
			slug = moved.Slug
			continue
		}
		return parseDocument(raw)
	}
	return nil, fmt.Errorf("could not read %s: it keeps moving", slug)
}

// GetPage reads a page (or a markdown document) the CLI may edit or print.
func (c *Client) GetPage(ctx context.Context, slug string) (*Document, error) {
	d, err := c.GetDocument(ctx, slug)
	if err != nil {
		return nil, err
	}
	if d.Kind == "artifact" {
		return nil, ErrNotAPage
	}
	if d.Encrypted {
		return nil, ErrEncrypted
	}
	return d, nil
}

// PageCreate is POST /api/v1/pages.
type PageCreate struct {
	Title     string `json:"title"`
	Workspace string `json:"workspace,omitempty"` // a workspace id
	Folder    string `json:"folder,omitempty"`    // a folder id or path
	Parent    string `json:"parent,omitempty"`    // the slug of a page
	Template  string `json:"template,omitempty"`
	Content   string `json:"content,omitempty"`
	Slug      string `json:"slug,omitempty"`
	AutoCover *bool  `json:"auto_cover,omitempty"`
}

// PageCreated is POST /api/v1/pages' answer (its edit_secret is dropped: the
// creator is signed in and owns the page).
type PageCreated struct {
	Document       *Document
	WorkspaceError *string
}

// CreatePage creates a page. It is never retried after the request may have
// reached the server, so a page is never created twice.
func (c *Client) CreatePage(ctx context.Context, req PageCreate) (*PageCreated, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	var out struct {
		Document       json.RawMessage `json:"document"`
		WorkspaceError *string         `json:"workspace_error"`
	}
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost, path: "/api/v1/pages", payload: payload, out: &out,
		op: "create the page"}); err != nil {
		return nil, err
	}
	d, err := parseDocument(out.Document)
	if err != nil {
		return nil, err
	}
	return &PageCreated{Document: d, WorkspaceError: out.WorkspaceError}, nil
}

// StaleRevError is a save refused because the page changed since baseRev.
type StaleRevError struct {
	BaseRev, Current int
}

func (e *StaleRevError) Error() string {
	cur := "a newer one"
	if e.Current > 0 {
		cur = strconv.Itoa(e.Current)
	}
	return fmt.Sprintf("the page changed since revision %d (it is at revision %s); read it again and redo the change",
		e.BaseRev, cur)
}

// UpdateDocument replaces a document's content (PUT). title is always sent:
// the API clears a title that is left out. baseRev > 0 makes the save refuse
// (StaleRevError) when the page changed meanwhile.
func (c *Client) UpdateDocument(ctx context.Context, slug, title, content string, baseRev int) (*Document, error) {
	if content == "" {
		content = "\n"
	}
	body := map[string]any{"title": title, "content": content}
	if baseRev > 0 {
		body["base_rev"] = baseRev
	}
	payload, _ := json.Marshal(body)
	var raw json.RawMessage
	_, err := c.send(ctx, apiRequest{method: http.MethodPut, path: "/api/v1/documents/" + url.PathEscape(slug),
		payload: payload, out: &raw, op: "save " + slug, retry: true})
	if err != nil {
		var ae *APIError
		if baseRev > 0 && errors.As(err, &ae) && ae.Status == http.StatusConflict {
			cur, _ := strconv.Atoi(ae.Header.Get("X-Markdrop-Rev"))
			return nil, &StaleRevError{BaseRev: baseRev, Current: cur}
		}
		return nil, err
	}
	return parseDocument(raw)
}

// EditPage reads a page, lets edit change its Markdown, and saves it with the
// revision it read, again (up to 5 times) when someone saved in between.
// edit returns the new Markdown and the title to keep.
func (c *Client) EditPage(ctx context.Context, slug string, edit func(d *Document) (string, error)) (*Document, error) {
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		d, err := c.GetPage(ctx, slug)
		if err != nil {
			return nil, err
		}
		md, err := edit(d)
		if err != nil {
			return nil, err
		}
		after, err := c.UpdateDocument(ctx, d.Slug, d.TitleText(), md, max(d.Rev, 1))
		var stale *StaleRevError
		if errors.As(err, &stale) {
			lastErr = err
			continue
		}
		return after, err
	}
	return nil, fmt.Errorf("the page kept changing while saving; try again (%v)", lastErr)
}

// AppendToPage adds Markdown at the end of a page.
func (c *Client) AppendToPage(ctx context.Context, slug, markdown string) (*Document, error) {
	if strings.TrimSpace(markdown) == "" {
		return nil, errors.New("nothing to add")
	}
	return c.EditPage(ctx, slug, func(d *Document) (string, error) { return JoinBlocks(d.Content, markdown), nil })
}

// SetPageProps writes the page's own properties (icon, cover, …) into its
// front matter; a nil value clears one.
func (c *Client) SetPageProps(ctx context.Context, slug string, changes map[string]any) (*Document, error) {
	if _, err := ValidatePageProps(changes); err != nil {
		return nil, err
	}
	return c.EditPage(ctx, slug, func(d *Document) (string, error) { return ApplyPageProps(d.Content, changes) })
}

// SetPageValues sets typed properties of a page filed in a folder that has a
// property schema (PATCH /documents/{slug}/properties); nil clears one.
func (c *Client) SetPageValues(ctx context.Context, slug string, values map[string]any) (json.RawMessage, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodPatch, "/api/v1/documents/"+url.PathEscape(slug)+"/properties",
		map[string]any{"values": values}, &raw, "set the properties of "+slug); err != nil {
		return nil, err
	}
	return raw, nil
}

// SuggestCover asks for a built-in cover for a page, picked like an auto
// cover (POST /pages/{slug}/cover/suggest); it is not written.
func (c *Client) SuggestCover(ctx context.Context, slug string) (string, error) {
	var out struct {
		Cover string `json:"cover"`
	}
	if _, err := c.do(ctx, http.MethodPost, "/api/v1/pages/"+url.PathEscape(slug)+"/cover/suggest",
		map[string]any{}, &out, "pick a cover for "+slug); err != nil {
		return "", err
	}
	if out.Cover == "" {
		return "", errors.New("the server suggested no cover")
	}
	return out.Cover, nil
}

// Children lists a page's sub-pages the caller can read.
func (c *Client) Children(ctx context.Context, slug string) ([]PageRef, error) {
	var out []PageRef
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/documents/"+url.PathEscape(slug)+"/children", nil, &out,
		"list the sub-pages of "+slug); err != nil {
		return nil, err
	}
	if out == nil {
		out = []PageRef{}
	}
	return out, nil
}

// Template is one page template.
type Template struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Category    string  `json:"category,omitempty"`
	Scope       string  `json:"scope"` // builtin, workspace or personal
	WorkspaceID *string `json:"workspace_id,omitempty"`
	Slug        string  `json:"slug,omitempty"`
	Subpages    int     `json:"subpages,omitempty"`
}

// Templates lists the page templates the caller can start a page from: the
// built-in ones, their personal ones and, with workspaceID, that workspace's.
func (c *Client) Templates(ctx context.Context, workspaceID string) ([]Template, error) {
	p := "/api/v1/page-templates/all"
	if workspaceID != "" {
		p += "?workspace=" + url.QueryEscape(workspaceID)
	}
	var out struct {
		Builtin   []Template `json:"builtin"`
		Workspace []Template `json:"workspace"`
		Personal  []Template `json:"personal"`
	}
	if _, err := c.do(ctx, http.MethodGet, p, nil, &out, "list the page templates"); err != nil {
		return nil, err
	}
	all := []Template{}
	for _, t := range out.Builtin {
		t.Scope = "builtin"
		all = append(all, t)
	}
	for _, t := range out.Workspace {
		t.Scope = "workspace"
		all = append(all, t)
	}
	for _, t := range out.Personal {
		t.Scope = "personal"
		all = append(all, t)
	}
	return all, nil
}

// PageImageMaxBytes is the largest image one upload takes.
const PageImageMaxBytes = 10 << 20

// PageImage is an image uploaded to a page.
type PageImage struct {
	ID     string `json:"id"`
	Asset  string `json:"asset"` // asset:<id>, for icon/cover
	Mime   string `json:"mime"`
	Size   int64  `json:"size"`
	Width  *int   `json:"width"`
	Height *int   `json:"height"`
	// Markdown is ![alt](asset:<id>), to put in the page.
	Markdown string `json:"markdown"`
	Slug     string `json:"slug"`
}

// ImageAlt is the alt text for a file: its name without the extension.
func ImageAlt(name, alt string) string {
	text := strings.TrimSpace(alt)
	if text == "" {
		base := filepath.Base(strings.ReplaceAll(name, `\`, "/"))
		text = strings.TrimSuffix(base, filepath.Ext(base))
	}
	text = strings.Join(strings.Fields(strings.NewReplacer("[", " ", "]", " ").Replace(text)), " ")
	if len(text) > 200 {
		text = text[:200]
	}
	if text == "" {
		return "image"
	}
	return text
}

// UploadPageImage uploads an image file (PNG, JPEG, GIF or WebP, up to
// 10 MB) to a page (POST /documents/{slug}/assets).
func (c *Client) UploadPageImage(ctx context.Context, slug, path, alt string) (*PageImage, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, unwrapPath(err))
	}
	if fi.IsDir() {
		return nil, fmt.Errorf("%s is a folder; give an image file", path)
	}
	if fi.Size() == 0 {
		return nil, fmt.Errorf("%s is empty", path)
	}
	if fi.Size() > PageImageMaxBytes {
		return nil, fmt.Errorf("%s is %s; images in a page can be up to 10 MB", path, humanSize(fi.Size()))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filepath.Base(path)))
	h.Set("Content-Type", ContentTypeFor(path))
	part, err := mw.CreatePart(h)
	if err != nil {
		return nil, err
	}
	_, _ = part.Write(data)
	_ = mw.Close()
	var out PageImage
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost,
		path: "/api/v1/documents/" + url.PathEscape(slug) + "/assets", payload: buf.Bytes(),
		contentType: mw.FormDataContentType(), out: &out, op: "add the image to " + slug}); err != nil {
		return nil, err
	}
	if out.ID == "" {
		return nil, errors.New("the server's answer has no image id")
	}
	out.Asset = "asset:" + out.ID
	out.Markdown = fmt.Sprintf("![%s](%s)", ImageAlt(path, alt), out.Asset)
	out.Slug = slug
	return &out, nil
}

func humanSize(b int64) string {
	switch {
	case b < 1<<10:
		return fmt.Sprintf("%d B", b)
	case b < 1<<20:
		return fmt.Sprintf("%.1f KB", float64(b)/(1<<10))
	case b < 1<<30:
		return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
	}
	return fmt.Sprintf("%.2f GB", float64(b)/(1<<30))
}

// ── Link ────────────────────────────────────────────────────────────────────

// SlugCheck is GET /documents/{slug}/slug-check.
type SlugCheck struct {
	Slug          string   `json:"slug"`
	Current       string   `json:"current"`
	Available     bool     `json:"available"`
	Code          *string  `json:"code"`
	Detail        *string  `json:"detail"`
	URL           *string  `json:"url"`
	MarkdropURL   *string  `json:"markdrop_url"`
	WorkspaceURL  *string  `json:"workspace_url"`
	RedirectsFrom []string `json:"redirects_from"`

	Raw json.RawMessage `json:"-"`
}

// CheckSlug asks whether the document at slug could move to newSlug.
func (c *Client) CheckSlug(ctx context.Context, slug, newSlug string) (*SlugCheck, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/documents/"+url.PathEscape(slug)+"/slug-check?new_slug="+
		url.QueryEscape(newSlug), nil, &raw, "check the link "+newSlug); err != nil {
		return nil, err
	}
	var sc SlugCheck
	if err := json.Unmarshal(raw, &sc); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	sc.Raw = raw
	return &sc, nil
}

// ChangeSlug gives a document a new link; the old one keeps redirecting.
func (c *Client) ChangeSlug(ctx context.Context, slug, newSlug string) (*Document, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodPatch, "/api/v1/documents/"+url.PathEscape(slug)+"/slug",
		map[string]any{"new_slug": newSlug}, &raw, "change the link of "+slug+" to "+newSlug); err != nil {
		return nil, err
	}
	return parseDocument(raw)
}

// ── Export ──────────────────────────────────────────────────────────────────

// ExportResult describes a finished export.
type ExportResult struct {
	Slug     string `json:"slug"`
	Format   string `json:"format"`
	Subpages bool   `json:"subpages"`
	FileName string `json:"filename" jsonschema:"The name the server gave the export"`
	Path     string `json:"path,omitempty" jsonschema:"Where it was saved (empty when written to stdout)"`
	Bytes    int64  `json:"bytes"`
	Notes    int    `json:"notes,omitempty" jsonschema:"How many things the export left out or changed (see the file)"`
}

// downloadClient has no overall timeout: a big zip may take a while.
var downloadClient = &http.Client{}

// Export streams a page's export (format md, html or zip; subpages adds the
// sub-pages, as a zip) into w. It returns the server's file name.
func (c *Client) Export(ctx context.Context, slug, format string, subpages bool, w io.Writer) (*ExportResult, error) {
	if strings.TrimSpace(c.Token) == "" {
		return nil, ErrNoToken
	}
	q := url.Values{"format": {format}}
	if subpages {
		q.Set("subpages", "true")
	}
	op := "export " + slug
	var resp *http.Response
	for attempt := 0; ; attempt++ {
		req, err := c.newRequest(ctx, http.MethodGet, "/api/v1/documents/"+url.PathEscape(slug)+"/export?"+q.Encode(), nil)
		if err != nil {
			return nil, err
		}
		hc := c.HTTP
		if hc == nil {
			hc = downloadClient
		}
		resp, err = hc.Do(req)
		if err != nil {
			err = &netError{op: op, err: err}
		} else if resp.StatusCode < 200 || resp.StatusCode > 299 {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			err = &APIError{Status: resp.StatusCode, Detail: detailOf(data), Op: op, Code: codeOf(data),
				Header: resp.Header}
		}
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		attempts := c.Attempts
		if attempts <= 0 {
			attempts = 4
		}
		if !retryableAPI(err) || attempt+1 >= attempts {
			if IsStatus(err, http.StatusUnprocessableEntity) && strings.Contains(err.Error(), "encrypted") {
				return nil, ErrEncrypted
			}
			return nil, err
		}
		backoff := c.Backoff
		if backoff <= 0 {
			backoff = time.Second
		}
		if err := sleepCtx(ctx, backoffDelay(backoff, attempt, 20*time.Second)); err != nil {
			return nil, err
		}
	}
	defer resp.Body.Close()
	n, err := io.Copy(w, resp.Body)
	if err != nil {
		return nil, &netError{op: op, err: err}
	}
	res := &ExportResult{Slug: slug, Format: format, Subpages: subpages, Bytes: n,
		FileName: dispositionName(resp.Header.Get("Content-Disposition"))}
	if res.FileName == "" {
		ext := map[string]string{"md": ".md", "html": ".html", "zip": ".zip"}[format]
		if subpages {
			ext = ".zip"
		}
		res.FileName = slug + ext
	}
	res.Notes, _ = strconv.Atoi(resp.Header.Get("X-Markdrop-Export-Notes"))
	return res, nil
}

// dispositionName is the file name of a Content-Disposition header, reduced
// to a plain base name.
func dispositionName(h string) string {
	if h == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(h)
	if err != nil {
		return ""
	}
	name := params["filename"]
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	if name == "." || name == "/" || strings.HasPrefix(name, ".") {
		return ""
	}
	return name
}

// ── Page history ────────────────────────────────────────────────────────────

// PageVersion is one row of GET /documents/{slug}/versions.
type PageVersion struct {
	N            int     `json:"n"`
	TS           string  `json:"ts"`
	Title        *string `json:"title"`
	Bytes        int64   `json:"bytes"`
	RestoredFrom *int    `json:"restored_from"`
	Current      bool    `json:"current"`
	Author       *struct {
		Kind  string  `json:"kind"`
		Name  *string `json:"name"`
		Label *string `json:"label"`
	} `json:"author"`
}

// AuthorName is who saved the version, as the app names them.
func (v *PageVersion) AuthorName() string {
	if v.Author == nil {
		return ""
	}
	if v.Author.Name != nil && *v.Author.Name != "" {
		return *v.Author.Name
	}
	if v.Author.Label != nil {
		return *v.Author.Label
	}
	return v.Author.Kind
}

// PageVersions is GET /documents/{slug}/versions.
type PageVersions struct {
	Versions   []PageVersion `json:"versions"`
	NextCursor *int          `json:"next_cursor"`
	Available  bool          `json:"available"`
	Reason     *string       `json:"reason"`

	Raw json.RawMessage `json:"-"`
}

// ListPageVersions lists a page's saved versions, newest first (cursor 0 = the newest).
func (c *Client) ListPageVersions(ctx context.Context, slug string, cursor, limit int) (*PageVersions, error) {
	q := url.Values{}
	if cursor > 0 {
		q.Set("cursor", strconv.Itoa(cursor))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	p := "/api/v1/documents/" + url.PathEscape(slug) + "/versions"
	if len(q) > 0 {
		p += "?" + q.Encode()
	}
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, p, nil, &raw, "list the versions of "+slug); err != nil {
		return nil, err
	}
	var v PageVersions
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if v.Versions == nil {
		v.Versions = []PageVersion{}
	}
	v.Raw = raw
	return &v, nil
}

// GetPageVersion reads one saved version (its Markdown is "markdown").
func (c *Client) GetPageVersion(ctx context.Context, slug string, n int) (json.RawMessage, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/v1/documents/%s/versions/%d", url.PathEscape(slug), n),
		nil, &raw, fmt.Sprintf("read version %d of %s", n, slug)); err != nil {
		return nil, err
	}
	return raw, nil
}

// RestorePageVersion makes version n the page again (as a new version).
func (c *Client) RestorePageVersion(ctx context.Context, slug string, n int) (*Document, int, error) {
	var out struct {
		Document json.RawMessage `json:"document"`
		Version  *int            `json:"version"`
	}
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost,
		path: fmt.Sprintf("/api/v1/documents/%s/versions/%d/restore", url.PathEscape(slug), n), payload: []byte("{}"),
		out: &out, op: fmt.Sprintf("restore version %d of %s", n, slug)}); err != nil {
		return nil, 0, err
	}
	d, err := parseDocument(out.Document)
	if err != nil {
		return nil, 0, err
	}
	v := 0
	if out.Version != nil {
		v = *out.Version
	}
	return d, v, nil
}

// ── Trash ───────────────────────────────────────────────────────────────────

// TrashItem is one row of GET /api/v1/trash.
type TrashItem struct {
	Key          string  `json:"key"`
	Slug         *string `json:"slug"`
	Title        *string `json:"title"`
	Kind         string  `json:"kind"`
	URL          *string `json:"url"`
	DeletedAt    string  `json:"deleted_at"`
	RestoreUntil string  `json:"restore_until"`
	DaysLeft     int     `json:"days_left"`
	SubPages     int     `json:"sub_pages"`
	Where        *struct {
		Workspace *struct {
			Name *string `json:"name"`
		} `json:"workspace"`
		Folder *struct {
			Name *string `json:"name"`
		} `json:"folder"`
	} `json:"where"`
	DeletedBy *struct {
		Name  *string `json:"name"`
		IsYou bool    `json:"is_you"`
	} `json:"deleted_by"`
}

// Trash is GET /api/v1/trash.
type Trash struct {
	Items []TrashItem `json:"items"`
	Days  int         `json:"days"`

	Raw json.RawMessage `json:"-"`
}

// ListTrash lists what the caller may restore (one workspace's, with workspaceID).
func (c *Client) ListTrash(ctx context.Context, workspaceID string) (*Trash, error) {
	p := "/api/v1/trash"
	if workspaceID != "" {
		p += "?workspace=" + url.QueryEscape(workspaceID)
	}
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, p, nil, &raw, "list the trash"); err != nil {
		return nil, err
	}
	var t Trash
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if t.Items == nil {
		t.Items = []TrashItem{}
	}
	t.Raw = raw
	return &t, nil
}

// RestoreFromTrash brings an item (a document's slug or a folder's id) back.
func (c *Client) RestoreFromTrash(ctx context.Context, key string) (json.RawMessage, error) {
	var raw json.RawMessage
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost, path: "/api/v1/trash/" + url.PathEscape(key) + "/restore",
		payload: []byte("{}"), out: &raw, op: "restore " + key + " from the trash"}); err != nil {
		return nil, err
	}
	return raw, nil
}

// DeleteForever deletes an item in the trash (and its batch) for good.
func (c *Client) DeleteForever(ctx context.Context, key string) (json.RawMessage, error) {
	var raw json.RawMessage
	if _, err := c.send(ctx, apiRequest{method: http.MethodDelete, path: "/api/v1/trash/" + url.PathEscape(key),
		out: &raw, op: "delete " + key + " forever"}); err != nil {
		return nil, err
	}
	return raw, nil
}

// MoveToTrash deletes a document (it goes to the trash). children is "" (a
// page with sub-pages is then refused), "delete" or "lift".
func (c *Client) MoveToTrash(ctx context.Context, slug, children string) error {
	p := "/api/v1/documents/" + url.PathEscape(slug)
	if children != "" {
		p += "?children=" + url.QueryEscape(children)
	}
	_, err := c.send(ctx, apiRequest{method: http.MethodDelete, path: p, op: "delete " + slug})
	return err
}

// ── Access requests ─────────────────────────────────────────────────────────

// AccessRequest is one request, as the owner's list shows it.
type AccessRequest struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	RoleRequested string  `json:"role_requested"`
	RoleGranted   *string `json:"role_granted"`
	AsAdmin       bool    `json:"as_admin"`
	Message       *string `json:"message"`
	CreatedAt     string  `json:"created_at"`
	DecidedAt     *string `json:"decided_at"`
	Requester     struct {
		Email *string `json:"email"`
		Name  *string `json:"name"`
	} `json:"requester"`
	Document struct {
		Slug  string  `json:"slug"`
		Title *string `json:"title"`
		URL   *string `json:"url"`
	} `json:"document"`
}

// AccessRequests is GET /api/v1/me/access-requests.
type AccessRequests struct {
	Requests     []AccessRequest `json:"requests"`
	PendingCount int             `json:"pending_count"`

	Raw json.RawMessage `json:"-"`
}

// RequestAccess asks for access to a document: role "editor" (Request edit
// access, for something the caller can open) or "viewer".
func (c *Client) RequestAccess(ctx context.Context, slug, role, message string) (json.RawMessage, error) {
	body := map[string]any{"role": role}
	if strings.TrimSpace(message) != "" {
		body["message"] = message
	}
	payload, _ := json.Marshal(body)
	var raw json.RawMessage
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost,
		path: "/api/v1/documents/" + url.PathEscape(slug) + "/access-requests", payload: payload, out: &raw,
		op: "ask for access to " + slug}); err != nil {
		return nil, err
	}
	return raw, nil
}

// ListAccessRequests lists requests on the caller's documents (status
// pending, approved, declined or all).
func (c *Client) ListAccessRequests(ctx context.Context, status string) (*AccessRequests, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/me/access-requests?status="+url.QueryEscape(status), nil, &raw,
		"list access requests"); err != nil {
		return nil, err
	}
	var out AccessRequests
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if out.Requests == nil {
		out.Requests = []AccessRequest{}
	}
	out.Raw = raw
	return &out, nil
}

// GetAccessRequest reads one request on the caller's documents.
func (c *Client) GetAccessRequest(ctx context.Context, id string) (*AccessRequest, error) {
	var r AccessRequest
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/access-requests/"+url.PathEscape(id), nil, &r,
		"read access request "+id); err != nil {
		return nil, err
	}
	return &r, nil
}

// DecideAccessRequest approves (decision "view" or "edit") or declines one.
func (c *Client) DecideAccessRequest(ctx context.Context, id, decision string) (json.RawMessage, error) {
	payload, _ := json.Marshal(map[string]any{"decision": decision})
	var raw json.RawMessage
	if _, err := c.send(ctx, apiRequest{method: http.MethodPost,
		path: "/api/v1/access-requests/" + url.PathEscape(id) + "/decision", payload: payload, out: &raw,
		op: "decide access request " + id, retry: true}); err != nil {
		return nil, err
	}
	return raw, nil
}
