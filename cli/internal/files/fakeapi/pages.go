package fakeapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The documents side of the API, for the page, link, export, trash, access
// and search commands: just enough of the server's rules (who may read or
// edit, base_rev, the edit lock, the trash, old slugs) for the CLI's tests.
//
// Who may do what: a document's owner reads and edits it; a token in Editors
// edits it; anyone reads a document whose Access is "link".

// PageVersion is one saved version of a page.
type PageVersion struct {
	N            int
	TS           time.Time
	Title        string
	Markdown     string
	Author       string
	RestoredFrom int
}

// AccessRequest is a request for access to a document.
type AccessRequest struct {
	ID        string
	Slug      string
	Requester string // token
	Role      string // viewer or editor
	Message   string
	Status    string // pending, approved, declined
	Granted   string
	Created   time.Time
	Decided   *time.Time
}

// BuiltinTemplate is the fake's one built-in template.
const BuiltinTemplate = "meeting-notes"

// AddPage creates a page (editor "blocks") owned by owner.
func (s *Server) AddPage(slug, owner, title, content string) *Doc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addPageLocked(slug, owner, title, content)
}

func (s *Server) addPageLocked(slug, owner, title, content string) *Doc {
	now := time.Now().UTC().Add(-time.Hour)
	d := &Doc{Slug: slug, Owner: owner, Kind: "markdown", Title: title, Access: "link", Created: now, Updated: now,
		Content: content, Rev: 1, Editor: "blocks", Editors: map[string]bool{}, Assets: map[string]string{}}
	d.History = []*PageVersion{{N: 1, TS: now, Title: title, Markdown: content, Author: owner}}
	s.docs[slug] = d
	return d
}

// Page returns a copy of a document (nil if missing).
func (s *Server) Page(slug string) *Doc { return s.Doc(slug) }

// Requests returns copies of the access requests.
func (s *Server) Requests() []AccessRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AccessRequest, len(s.requests))
	for i, r := range s.requests {
		out[i] = *r
	}
	return out
}

// Edit changes a page as someone else's save would (rev+1, a version).
func (s *Server) Edit(slug, content string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	s.saveLocked(d, d.Title, content, OtherToken, 0)
}

func (s *Server) saveLocked(d *Doc, title, content, user string, restoredFrom int) {
	d.Title, d.Content = title, content
	d.Rev++
	d.Updated = time.Now().UTC()
	n := 0
	for _, v := range d.History {
		n = max(n, v.N)
	}
	d.History = append(d.History, &PageVersion{N: n + 1, TS: d.Updated, Title: title, Markdown: content, Author: user,
		RestoredFrom: restoredFrom})
}

var (
	reDoc        = regexp.MustCompile(`^/api/v1/documents/([A-Za-z0-9_-]+)$`)
	reDocSub     = regexp.MustCompile(`^/api/v1/documents/([A-Za-z0-9_-]+)/([a-z-]+)$`)
	reDocVersion = regexp.MustCompile(`^/api/v1/documents/([A-Za-z0-9_-]+)/versions/(\d+)(/restore)?$`)
	reCover      = regexp.MustCompile(`^/api/v1/pages/([A-Za-z0-9_-]+)/cover/suggest$`)
	reTrashKey   = regexp.MustCompile(`^/api/v1/trash/([A-Za-z0-9_-]+)(/restore)?$`)
	reRequest    = regexp.MustCompile(`^/api/v1/access-requests/([a-f0-9]+)(/decision)?$`)
)

// servePages handles the documents side; false = not one of its routes.
func (s *Server) servePages(w http.ResponseWriter, r *http.Request, user string) bool {
	p, m := r.URL.Path, r.Method
	switch {
	case m == http.MethodPost && p == "/api/v1/pages":
		s.createPage(w, r, user)
	case m == http.MethodGet && p == "/api/v1/page-templates/all":
		s.templates(w, r, user)
	case m == http.MethodGet && p == "/api/v1/trash":
		s.listTrash(w, user)
	case m == http.MethodGet && p == "/api/v1/me/access-requests":
		s.listRequests(w, r, user)
	case m == http.MethodGet && p == "/api/v1/search/quick":
		s.quickSearch(w, r, user)
	case reCover.MatchString(p) && m == http.MethodPost:
		s.withDoc(w, user, reCover.FindStringSubmatch(p)[1], true, func(d *Doc) {
			writeJSON(w, 200, map[string]any{"cover": "gallery:dusk", "how": "keywords"})
		})
	case reTrashKey.MatchString(p):
		mm := reTrashKey.FindStringSubmatch(p)
		if m == http.MethodPost && mm[2] != "" {
			s.restoreTrash(w, user, mm[1])
		} else if m == http.MethodDelete && mm[2] == "" {
			s.deleteForever(w, user, mm[1])
		} else {
			return false
		}
	case reRequest.MatchString(p):
		mm := reRequest.FindStringSubmatch(p)
		if m == http.MethodGet && mm[2] == "" {
			s.getRequest(w, user, mm[1])
		} else if m == http.MethodPost && mm[2] != "" {
			s.decide(w, r, user, mm[1])
		} else {
			return false
		}
	case reDocVersion.MatchString(p):
		mm := reDocVersion.FindStringSubmatch(p)
		n, _ := strconv.Atoi(mm[2])
		if m == http.MethodGet && mm[3] == "" {
			s.withDoc(w, user, mm[1], true, func(d *Doc) { s.getVersion(w, d, n) })
		} else if m == http.MethodPost && mm[3] != "" {
			s.withDoc(w, user, mm[1], true, func(d *Doc) { s.restoreVersion(w, d, n, user) })
		} else {
			return false
		}
	case reDoc.MatchString(p):
		slug := reDoc.FindStringSubmatch(p)[1]
		switch m {
		case http.MethodGet:
			s.getDocument(w, user, slug)
		case http.MethodPut:
			s.putDocument(w, r, user, slug)
		case http.MethodDelete:
			s.deleteDocument(w, r, user, slug)
		default:
			return false
		}
	case reDocSub.MatchString(p):
		mm := reDocSub.FindStringSubmatch(p)
		slug, sub := mm[1], mm[2]
		switch {
		case m == http.MethodGet && sub == "children":
			s.withDoc(w, user, slug, false, func(d *Doc) { writeJSON(w, 200, s.children(d, user)) })
		case m == http.MethodPatch && sub == "slug":
			s.changeSlug(w, r, user, slug)
		case m == http.MethodGet && sub == "slug-check":
			s.slugCheck(w, r, user, slug)
		case m == http.MethodPost && sub == "assets":
			s.withDoc(w, user, slug, true, func(d *Doc) { s.uploadAsset(w, r, d) })
		case m == http.MethodPatch && sub == "properties":
			s.withDoc(w, user, slug, true, func(d *Doc) { s.patchValues(w, r, d, user) })
		case m == http.MethodGet && sub == "export":
			s.withDoc(w, user, slug, false, func(d *Doc) { s.export(w, r, d, user) })
		case m == http.MethodGet && sub == "versions":
			s.withDoc(w, user, slug, true, func(d *Doc) { s.listVersions(w, r, d) })
		case m == http.MethodPost && sub == "access-requests":
			s.requestAccess(w, r, user, slug)
		default:
			return false
		}
	default:
		return false
	}
	return true
}

func (d *Doc) canEdit(user string) bool                                { return d.Owner == user || d.Editors[user] }
func (d *Doc) canRead(user string) bool                                { return d.canEdit(user) || d.Access == "link" }
func (d *Doc) isPage() bool                                            { return d.Kind != "artifact" }
func pageError(w http.ResponseWriter, status int, body map[string]any) { writeJSON(w, status, body) }

// withDoc runs fn under the lock for a live document the user may read (or
// edit), answering 404/403 otherwise.
func (s *Server) withDoc(w http.ResponseWriter, user, slug string, edit bool, fn func(d *Doc)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil || d.Trashed || !d.canRead(user) {
		detail(w, 404, "Document not found")
		return
	}
	if edit && !d.canEdit(user) {
		detail(w, 403, "You can read this page but not edit it.")
		return
	}
	fn(d)
}

var reFront = regexp.MustCompile(`^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$`)

// pageProps reads the front matter the way the server does (leniently).
func pageProps(content string) map[string]any {
	out := map[string]any{"icon": nil, "cover": nil, "cover_y": 50, "full_width": false, "small_text": false,
		"font": "default", "locked": false, "allow_export": true}
	if !strings.HasPrefix(content, "---\n") {
		return out
	}
	lines := strings.Split(content, "\n")
	for _, l := range lines[1:] {
		if l == "---" {
			break
		}
		m := reFront.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		v := strings.Trim(m[2], `"'`)
		switch m[1] {
		case "icon":
			out["icon"] = v
		case "cover":
			if strings.HasPrefix(v, "gallery:") || strings.HasPrefix(v, "asset:") || strings.HasPrefix(v, "https://") {
				out["cover"] = v
			}
		case "cover_y":
			if n, err := strconv.Atoi(v); err == nil {
				out["cover_y"] = n
			}
		case "font":
			out["font"] = v
		case "full_width", "small_text", "locked", "allow_export":
			out[m[1]] = v == "true"
		}
	}
	return out
}

func stripFront(content string) string {
	if !strings.HasPrefix(content, "---\n") {
		return content
	}
	if i := strings.Index(content[4:], "\n---\n"); i >= 0 {
		return content[4+i+5:]
	}
	return content
}

var reAssetUse = regexp.MustCompile(`asset:([A-Za-z0-9_-]{8,64})`)

func (s *Server) docURLs(d *Doc) (string, any) {
	markdropURL := s.WebBase + "/" + d.Slug
	var wsURL any
	if wsp := s.workspace(d.Workspace); wsp != nil && wsp.liveHost() != "" {
		u := "https://" + wsp.liveHost() + "/"
		if d.FolderPath != "" {
			u += d.FolderPath + "/"
		}
		wsURL = u + d.Slug
	}
	return markdropURL, wsURL
}

func (s *Server) docBody(d *Doc) map[string]any {
	markdropURL, wsURL := s.docURLs(d)
	var editor, parent, ws, tmpl any
	if d.Editor != "" {
		editor = d.Editor
	}
	if p := s.docs[d.Parent]; d.Parent != "" && p != nil {
		parent = map[string]any{"slug": p.Slug, "title": p.Title}
	}
	if d.Workspace != "" {
		ws = d.Workspace
	}
	if d.TemplateID != "" {
		tmpl = d.TemplateID
	}
	kids := 0
	for _, c := range s.docs {
		if c.Parent == d.Slug && !c.Trashed {
			kids++
		}
	}
	assets := map[string]any{}
	for _, m := range reAssetUse.FindAllStringSubmatch(d.Content, -1) {
		if _, ok := d.Assets[m[1]]; ok {
			assets[m[1]] = map[string]any{"url": s.WebBase + "/img/" + m[1], "expires_at": nil}
		}
	}
	var props any
	if d.Schema != nil {
		props = map[string]any{"values": d.Values}
	}
	var title any
	if d.Title != "" {
		title = d.Title
	}
	var page any
	if d.isPage() {
		page = pageProps(d.Content)
	}
	folderPath := []string{}
	if d.FolderPath != "" {
		folderPath = strings.Split(d.FolderPath, "/")
	}
	return map[string]any{
		"slug": d.Slug, "url": markdropURL, "workspace_url": wsURL, "folder_path": folderPath, "title": title,
		"content": d.Content, "created_at": iso(d.Created), "updated_at": iso(d.Updated), "rev": d.Rev,
		"kind": d.Kind, "editor": editor, "encrypted": d.Encrypted, "access_level": d.Access, "workspace_id": ws,
		"parent": parent, "children_count": kids, "template_id": tmpl, "page": page, "page_properties": props,
		"assets": assets, "cover_auto": false, "cover_pending": false, "read_ticket": "t", "views": d.Views,
	}
}

func (s *Server) getDocument(w http.ResponseWriter, user, slug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil {
		for _, o := range s.docs {
			for _, old := range o.OldSlugs {
				if old == slug && !o.Trashed && o.canRead(user) {
					w.Header().Set("X-Markdrop-Moved", o.Slug)
					writeJSON(w, 200, map[string]any{"moved": true, "slug": o.Slug, "url": s.WebBase + "/" + o.Slug})
					return
				}
			}
		}
	}
	if d == nil || d.Trashed || !d.canRead(user) {
		detail(w, 404, "Document not found")
		return
	}
	writeJSON(w, 200, s.docBody(d))
}

func (s *Server) putDocument(w http.ResponseWriter, r *http.Request, user, slug string) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		detail(w, 422, "invalid JSON")
		return
	}
	s.mu.Lock()
	hook := s.BeforePut
	s.mu.Unlock()
	if hook != nil {
		hook(slug)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.PagePuts++
	s.LastPut = body
	d := s.docs[slug]
	if d == nil || d.Trashed || !d.canRead(user) {
		detail(w, 404, "Document not found")
		return
	}
	if !d.canEdit(user) {
		detail(w, 403, "You can read this page but not edit it.")
		return
	}
	if d.EditingBy != "" && d.EditingBy != user {
		pageError(w, 423, map[string]any{"detail": "Someone is editing this page. Try again in a minute.", "code": "page_lock"})
		return
	}
	content, _ := body["content"].(string)
	if content == "" {
		detail(w, 422, "content: Field required")
		return
	}
	if br, ok := body["base_rev"].(float64); ok && int(br) != d.Rev {
		w.Header().Set("X-Markdrop-Rev", strconv.Itoa(d.Rev))
		detail(w, 409, "This document changed since you opened it.")
		return
	}
	title, _ := body["title"].(string) // left out: cleared, like the server
	s.saveLocked(d, title, content, user, 0)
	writeJSON(w, 200, s.docBody(d))
}

func (s *Server) createPage(w http.ResponseWriter, r *http.Request, user string) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		detail(w, 422, "invalid JSON")
		return
	}
	str := func(k string) string { v, _ := req[k].(string); return v }
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastPageCreate = req
	if strings.TrimSpace(str("title")) == "" {
		detail(w, 422, "title: Field required")
		return
	}
	ws, folder := str("workspace"), str("folder")
	if p := str("parent"); p != "" {
		if ws != "" || folder != "" {
			detail(w, 422, "A sub-page lives in its parent's workspace and folder.")
			return
		}
		pd := s.docs[p]
		if pd == nil || pd.Trashed || !pd.canEdit(user) {
			detail(w, 404, "Parent page not found")
			return
		}
		ws, folder = pd.Workspace, pd.FolderPath
	} else if ws != "" {
		wsp := s.workspace(ws)
		if wsp == nil || wsp.Members[user] == "" {
			detail(w, 404, "Workspace not found")
			return
		}
		if wsp.Members[user] == "viewer" {
			detail(w, 403, "This action requires the member role or higher.")
			return
		}
		if folder != "" {
			f := wsp.folder(folder)
			if f == nil {
				detail(w, 404, "Folder not found")
				return
			}
			folder = f.Path
		}
	}
	slug := str("slug")
	if slug != "" {
		if !customSlug.MatchString(slug) {
			detail(w, 422, "slug: String should match pattern '^[a-zA-Z0-9_-]+$'")
			return
		}
		if s.docs[slug] != nil || s.oldSlugTaken(slug) {
			detail(w, 409, fmt.Sprintf("The address %s is already taken. Choose another.", slug))
			return
		}
	} else {
		slug = s.slugFor(str("title"))
	}
	content := str("content")
	tmpl := ""
	if t := str("template"); t != "" {
		if t != BuiltinTemplate && t != "tpl_acme" {
			detail(w, 404, "Template not found")
			return
		}
		tmpl = t
		content = "# " + str("title") + "\n\n## Agenda\n\n## Notes\n"
	}
	if content == "" {
		content = "\n"
	}
	d := s.addPageLocked(slug, user, str("title"), content)
	d.Rev = 1
	d.Workspace, d.FolderPath, d.Parent, d.TemplateID = ws, folder, str("parent"), tmpl
	if ws != "" {
		d.Access = "workspace"
	}
	if folder == "guides" && ws == "ws_acme" {
		d.Schema = []string{"Status", "Points"}
		d.Values = map[string]any{}
	}
	writeJSON(w, 201, map[string]any{"document": s.docBody(d), "edit_secret": "es_secret", "workspace_error": nil})
}

func (s *Server) oldSlugTaken(slug string) bool {
	for _, d := range s.docs {
		for _, o := range d.OldSlugs {
			if o == slug {
				return true
			}
		}
	}
	return false
}

func (s *Server) children(d *Doc, user string) []map[string]any {
	out := []map[string]any{}
	var kids []*Doc
	for _, c := range s.docs {
		if c.Parent == d.Slug && !c.Trashed && c.canRead(user) {
			kids = append(kids, c)
		}
	}
	sort.Slice(kids, func(i, j int) bool { return kids[i].Slug < kids[j].Slug })
	for _, c := range kids {
		out = append(out, map[string]any{"slug": c.Slug, "title": c.Title, "editor": c.Editor,
			"updated_at": iso(c.Updated), "has_children": false, "access_inherit": true})
	}
	return out
}

func (s *Server) changeSlug(w http.ResponseWriter, r *http.Request, user, slug string) {
	var body struct {
		NewSlug string `json:"new_slug"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil || d.Trashed || !d.canRead(user) {
		detail(w, 404, "Document not found")
		return
	}
	if d.Owner != user {
		detail(w, 403, "Only its owner can change its link.")
		return
	}
	if !customSlug.MatchString(body.NewSlug) {
		detail(w, 422, "new_slug: String should match pattern '^[a-zA-Z0-9_-]+$'")
		return
	}
	if s.docs[body.NewSlug] != nil || s.oldSlugTaken(body.NewSlug) {
		detail(w, 409, fmt.Sprintf("The address %s is already taken.", body.NewSlug))
		return
	}
	delete(s.docs, slug)
	d.OldSlugs = append(d.OldSlugs, slug)
	d.Slug = body.NewSlug
	s.docs[d.Slug] = d
	for _, c := range s.docs {
		if c.Parent == slug {
			c.Parent = d.Slug
		}
	}
	writeJSON(w, 200, s.docBody(d))
}

func (s *Server) slugCheck(w http.ResponseWriter, r *http.Request, user, slug string) {
	ns := r.URL.Query().Get("new_slug")
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil || d.Trashed || d.Owner != user {
		detail(w, 404, "Document not found")
		return
	}
	var code, det any
	available := true
	switch {
	case ns == slug:
		code, available = "same", false
	case !customSlug.MatchString(ns):
		code, det, available = "invalid", "3-50 letters, digits, - or _", false
	case s.docs[ns] != nil || s.oldSlugTaken(ns):
		code, det, available = "taken", "That address is taken.", false
	}
	writeJSON(w, 200, map[string]any{"slug": ns, "current": slug, "available": available, "code": code, "detail": det,
		"url": s.WebBase + "/" + ns, "markdrop_url": s.WebBase + "/" + ns, "workspace_url": nil,
		"redirects_from": d.OldSlugs})
}

// imageMime sniffs PNG, JPEG, GIF and WebP like the server.
func imageMime(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return "image/gif"
	case len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request, d *Doc) {
	if !d.isPage() {
		detail(w, 422, "Images can be added to Markdown documents only.")
		return
	}
	if d.EditingBy != "" && d.EditingBy != d.Owner {
		pageError(w, 423, map[string]any{"detail": "Someone is editing this page."})
		return
	}
	f, _, err := r.FormFile("file")
	if err != nil {
		detail(w, 422, "file: Field required")
		return
	}
	data, _ := io.ReadAll(io.LimitReader(f, 10<<20+1))
	if len(data) > 10<<20 {
		detail(w, 413, "Images in a page can be up to 10 MB.")
		return
	}
	mime := imageMime(data)
	if mime == "" {
		detail(w, 422, "That isn't a PNG, JPEG, GIF or WebP image.")
		return
	}
	id := randomID()
	if d.Assets == nil {
		d.Assets = map[string]string{}
	}
	d.Assets[id] = mime
	writeJSON(w, 201, map[string]any{"id": id, "mime": mime, "size": len(data), "width": 1, "height": 1})
}

func (s *Server) patchValues(w http.ResponseWriter, r *http.Request, d *Doc, user string) {
	var body struct {
		Values map[string]any `json:"values"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if d.Schema == nil {
		detail(w, 422, "This page isn't in a folder with properties.")
		return
	}
	for k, v := range body.Values {
		ok := false
		for _, sk := range d.Schema {
			ok = ok || sk == k
		}
		if !ok {
			detail(w, 422, fmt.Sprintf("Unknown property %q.", k))
			return
		}
		if v == nil {
			delete(d.Values, k)
		} else {
			d.Values[k] = v
		}
	}
	d.Rev++
	writeJSON(w, 200, map[string]any{"slug": d.Slug, "rev": d.Rev, "values": d.Values,
		"page_properties": map[string]any{"values": d.Values}})
}

func (s *Server) export(w http.ResponseWriter, r *http.Request, d *Doc, user string) {
	q := r.URL.Query()
	format := q.Get("format")
	if format == "" {
		format = "md"
	}
	if format != "md" && format != "html" && format != "zip" {
		detail(w, 422, "format: md, html or zip")
		return
	}
	if d.Encrypted {
		pageError(w, 422, map[string]any{"detail": "This document is end-to-end encrypted; export it from its page.", "code": "encrypted"})
		return
	}
	if !d.canEdit(user) && pageProps(d.Content)["allow_export"] == false {
		detail(w, 403, "Its owner turned export off for readers.")
		return
	}
	md := "# " + d.Title + "\n\n" + strings.TrimLeft(stripFront(d.Content), "\n")
	sub := q.Get("subpages") == "true" || q.Get("subpages") == "1"
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if format == "zip" || sub {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		f, _ := zw.Create(d.Slug + "/page.md")
		_, _ = io.WriteString(f, md)
		if sub {
			for _, c := range s.docs {
				if c.Parent == d.Slug && !c.Trashed && c.canRead(user) {
					f, _ := zw.Create(d.Slug + "/" + c.Slug + "/page.md")
					_, _ = io.WriteString(f, "# "+c.Title+"\n\n"+stripFront(c.Content))
				}
			}
		}
		_ = zw.Close()
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, d.Slug))
		w.Header().Set("X-Markdrop-Export-Notes", "1")
		w.WriteHeader(200)
		_, _ = w.Write(buf.Bytes())
		return
	}
	if format == "html" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.html"`, d.Slug))
		w.WriteHeader(200)
		_, _ = fmt.Fprintf(w, "<!doctype html><title>%s</title><pre>%s</pre>", d.Title, md)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.md"`, d.Slug))
	w.WriteHeader(200)
	_, _ = io.WriteString(w, md)
}

func (s *Server) versionView(d *Doc, v *PageVersion, current bool) map[string]any {
	var rf any
	if v.RestoredFrom > 0 {
		rf = v.RestoredFrom
	}
	name := strings.TrimPrefix(v.Author, "mdk_")
	return map[string]any{"n": v.N, "ts": iso(v.TS), "title": v.Title, "icon": nil, "bytes": len(v.Markdown),
		"restored_from": rf, "current": current,
		"author": map[string]any{"kind": "user", "id": v.Author, "name": name, "label": nil}}
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request, d *Doc) {
	cursor, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 30
	}
	out := []map[string]any{}
	var next any
	for i := len(d.History) - 1; i >= 0; i-- {
		v := d.History[i]
		if cursor > 0 && v.N >= cursor {
			continue
		}
		if len(out) == limit {
			next = d.History[i+1].N
			break
		}
		out = append(out, s.versionView(d, v, i == len(d.History)-1 && cursor == 0))
	}
	writeJSON(w, 200, map[string]any{"versions": out, "next_cursor": next, "available": true, "reason": nil})
}

func (d *Doc) version(n int) *PageVersion {
	for _, v := range d.History {
		if v.N == n {
			return v
		}
	}
	return nil
}

func (s *Server) getVersion(w http.ResponseWriter, d *Doc, n int) {
	v := d.version(n)
	if v == nil {
		detail(w, 404, "That version doesn't exist (any more).")
		return
	}
	out := s.versionView(d, v, v == d.History[len(d.History)-1])
	out["markdown"] = v.Markdown
	out["assets"] = map[string]any{}
	out["current_doc"] = map[string]any{"title": d.Title, "markdown": d.Content, "rev": d.Rev}
	writeJSON(w, 200, out)
}

func (s *Server) restoreVersion(w http.ResponseWriter, d *Doc, n int, user string) {
	v := d.version(n)
	if v == nil {
		detail(w, 404, "That version doesn't exist (any more).")
		return
	}
	s.saveLocked(d, v.Title, v.Markdown, user, n)
	writeJSON(w, 200, map[string]any{"document": s.docBody(d), "version": d.History[len(d.History)-1].N,
		"restored_from": n})
}

func (s *Server) deleteDocument(w http.ResponseWriter, r *http.Request, user, slug string) {
	children := r.URL.Query().Get("children")
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil || d.Trashed || !d.canRead(user) {
		detail(w, 404, "Document not found")
		return
	}
	if d.Owner != user {
		detail(w, 403, "Only its owner can delete it.")
		return
	}
	var kids []*Doc
	for _, c := range s.docs {
		if c.Parent == slug && !c.Trashed {
			kids = append(kids, c)
		}
	}
	if len(kids) > 0 && children != "delete" && children != "lift" {
		pageError(w, 409, map[string]any{"detail": "This page has pages inside it. Choose whether to delete them too " +
			"(children=delete) or move them up a level (children=lift).", "code": "has_children", "count": len(kids)})
		return
	}
	for _, c := range kids {
		if children == "delete" {
			c.Trashed = true
		} else {
			c.Parent = ""
		}
	}
	d.Trashed = true
	d.Updated = time.Now().UTC()
	w.WriteHeader(204)
}

func (s *Server) listTrash(w http.ResponseWriter, user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	var slugs []string
	for slug, d := range s.docs {
		if pd := s.docs[d.Parent]; d.Trashed && d.Owner == user && (pd == nil || !pd.Trashed) {
			slugs = append(slugs, slug)
		}
	}
	sort.Strings(slugs)
	for _, slug := range slugs {
		d := s.docs[slug]
		kind := "document"
		if d.Kind == "artifact" {
			kind = "file"
		} else if d.Editor == "blocks" {
			kind = "page"
		}
		items = append(items, map[string]any{"key": slug, "id": slug, "slug": slug, "title": d.Title, "kind": kind,
			"url": s.WebBase + "/" + slug, "deleted_at": iso(d.Updated), "restore_until": iso(d.Updated.Add(30 * 24 * time.Hour)),
			"days_left": 30, "sub_pages": 0, "where": map[string]any{"workspace": nil, "folder": nil, "parent": nil},
			"deleted_by": map[string]any{"id": user, "name": "Owner", "is_you": true}})
	}
	writeJSON(w, 200, map[string]any{"items": items, "days": 30})
}

func (s *Server) trashed(w http.ResponseWriter, user, key string) *Doc {
	d := s.docs[key]
	if d == nil || !d.Trashed || d.Owner != user {
		detail(w, 404, "That isn't in your trash.")
		return nil
	}
	return d
}

func (s *Server) restoreTrash(w http.ResponseWriter, user, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.trashed(w, user, key)
	if d == nil {
		return
	}
	items := []map[string]any{{"slug": d.Slug, "title": d.Title, "kind": "page"}}
	d.Trashed = false
	for _, c := range s.docs {
		if c.Parent == key && c.Trashed {
			c.Trashed = false
			items = append(items, map[string]any{"slug": c.Slug, "title": c.Title, "kind": "page"})
		}
	}
	writeJSON(w, 200, map[string]any{"restored": true, "key": key, "slug": key, "kind": "page", "title": d.Title,
		"url": s.WebBase + "/" + key, "items": items, "folders": 0, "notes": []string{}})
}

func (s *Server) deleteForever(w http.ResponseWriter, user, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.trashed(w, user, key)
	if d == nil {
		return
	}
	items := []map[string]any{}
	for slug, c := range s.docs {
		if c.Parent == key && c.Trashed {
			delete(s.docs, slug)
			items = append(items, map[string]any{"slug": slug, "title": c.Title, "kind": "page"})
		}
	}
	delete(s.docs, key)
	items = append(items, map[string]any{"slug": key, "title": d.Title, "kind": "page"})
	writeJSON(w, 200, map[string]any{"deleted": true, "items": items})
}

func (s *Server) templates(w http.ResponseWriter, r *http.Request, user string) {
	ws := r.URL.Query().Get("workspace")
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{
		"builtin": []map[string]any{{"id": BuiltinTemplate, "name": "Meeting notes", "description": "Agenda, notes and action items",
			"icon": "📝", "category": "Work", "content": "# {{title}}"}},
		"workspace": []map[string]any{}, "personal": []map[string]any{},
	}
	if wsp := s.workspace(ws); ws != "" && wsp != nil && wsp.Members[user] != "" && wsp.Members[user] != "viewer" {
		out["workspace"] = []map[string]any{{"id": "tpl_acme", "slug": "acme-spec", "name": "Acme spec",
			"description": "", "scope": "workspace", "workspace_id": ws, "subpages": 0}}
	}
	writeJSON(w, 200, out)
}

// ── Access requests ─────────────────────────────────────────────────────────

func (s *Server) requestAccess(w http.ResponseWriter, r *http.Request, user, slug string) {
	var body struct {
		Role    string `json:"role"`
		Message string `json:"message"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Role == "" {
		body.Role = "viewer"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.docs[slug]
	if d == nil || d.Trashed {
		detail(w, 404, "Document not found")
		return
	}
	if body.Role == "editor" {
		if !d.canRead(user) {
			detail(w, 404, "Document not found")
			return
		}
		if d.canEdit(user) {
			detail(w, 409, "You can already edit this.")
			return
		}
	}
	for _, q := range s.requests {
		if q.Slug == slug && q.Requester == user && q.Status == "pending" {
			detail(w, 409, "You already asked; the owner hasn't decided yet.")
			return
		}
	}
	q := &AccessRequest{ID: randomID(), Slug: slug, Requester: user, Role: body.Role, Message: body.Message,
		Status: "pending", Created: time.Now().UTC()}
	s.requests = append(s.requests, q)
	writeJSON(w, 201, map[string]any{"id": q.ID, "status": q.Status})
}

func (s *Server) requestBody(q *AccessRequest) map[string]any {
	d := s.docs[q.Slug]
	var msg, granted, decided any
	if q.Message != "" {
		msg = q.Message
	}
	if q.Granted != "" {
		granted = q.Granted
	}
	if q.Decided != nil {
		decided = iso(*q.Decided)
	}
	return map[string]any{"id": q.ID, "status": q.Status, "role_requested": q.Role, "as_admin": false,
		"message": msg, "created_at": iso(q.Created), "decided_at": decided, "role_granted": granted,
		"requester": map[string]any{"email": strings.TrimPrefix(q.Requester, "mdk_") + "@example.com",
			"name": strings.TrimPrefix(q.Requester, "mdk_")},
		"document": map[string]any{"slug": d.Slug, "title": d.Title, "kind": d.Kind, "encrypted": false,
			"access": d.Access, "url": s.WebBase + "/" + d.Slug}}
}

func (s *Server) listRequests(w http.ResponseWriter, r *http.Request, user string) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	pending := 0
	for i := len(s.requests) - 1; i >= 0; i-- {
		q := s.requests[i]
		if d := s.docs[q.Slug]; d == nil || d.Owner != user {
			continue
		}
		if q.Status == "pending" {
			pending++
		}
		if status == "all" || q.Status == status {
			out = append(out, s.requestBody(q))
		}
	}
	writeJSON(w, 200, map[string]any{"requests": out, "pending_count": pending})
}

func (s *Server) ownRequest(w http.ResponseWriter, user, id string) *AccessRequest {
	for _, q := range s.requests {
		if q.ID == id {
			if d := s.docs[q.Slug]; d != nil && d.Owner == user {
				return q
			}
		}
	}
	detail(w, 404, "Request not found")
	return nil
}

func (s *Server) getRequest(w http.ResponseWriter, user, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if q := s.ownRequest(w, user, id); q != nil {
		writeJSON(w, 200, s.requestBody(q))
	}
}

func (s *Server) decide(w http.ResponseWriter, r *http.Request, user, id string) {
	var body struct {
		Decision string `json:"decision"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.ownRequest(w, user, id)
	if q == nil {
		return
	}
	if q.Role == "editor" && body.Decision == "view" {
		detail(w, 422, "They can already view it. Let them edit, or decline.")
		return
	}
	if q.Status != "pending" {
		detail(w, 409, "This request was already "+q.Status+".")
		return
	}
	now := time.Now().UTC()
	q.Decided = &now
	switch body.Decision {
	case "decline":
		q.Status = "declined"
	case "view", "edit":
		q.Status = "approved"
		q.Granted = map[string]string{"view": "viewer", "edit": "editor"}[body.Decision]
		if d := s.docs[q.Slug]; body.Decision == "edit" {
			if d.Editors == nil {
				d.Editors = map[string]bool{}
			}
			d.Editors[q.Requester] = true
		}
	default:
		detail(w, 422, "decision: view, edit or decline")
		return
	}
	var granted any
	if q.Granted != "" {
		granted = q.Granted
	}
	writeJSON(w, 200, map[string]any{"id": q.ID, "status": q.Status, "role_granted": granted, "decided_at": iso(now)})
}

// ── Search ──────────────────────────────────────────────────────────────────

func (s *Server) quickSearch(w http.ResponseWriter, r *http.Request, user string) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		detail(w, 422, "limit: Input should be less than or equal to 20")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{"files": []map[string]any{}, "folders": []map[string]any{}, "workspaces": []map[string]any{}}
	if len(q) < 2 {
		writeJSON(w, 200, out)
		return
	}
	var slugs []string
	for slug, d := range s.docs {
		if !d.Trashed && d.canRead(user) && (strings.Contains(strings.ToLower(d.Title), q) || strings.Contains(slug, q)) {
			slugs = append(slugs, slug)
		}
	}
	sort.Strings(slugs)
	files := []map[string]any{}
	for _, slug := range slugs {
		if len(files) == limit {
			break
		}
		d := s.docs[slug]
		markdropURL, wsURL := s.docURLs(d)
		url := markdropURL
		if wsURL != nil {
			url = wsURL.(string)
		}
		var editor, ws, label any
		if d.Editor != "" {
			editor = d.Editor
		}
		if wsp := s.workspace(d.Workspace); wsp != nil {
			ws = map[string]any{"id": wsp.ID, "name": wsp.Name}
		}
		if d.Kind == "artifact" {
			label = "File"
		}
		files = append(files, map[string]any{"slug": slug, "title": d.Title, "kind": d.Kind, "editor": editor,
			"url": url, "markdrop_url": markdropURL, "type_label": label, "updated_at": iso(d.Updated),
			"workspace": ws, "role": "owner", "redacted": false})
	}
	out["files"] = files
	folders := []map[string]any{}
	wss := []map[string]any{}
	for _, wsp := range s.workspaces {
		if wsp.Members[user] == "" {
			continue
		}
		for _, f := range wsp.Folders {
			if strings.Contains(strings.ToLower(f.Name), q) && len(folders) < limit {
				folders = append(folders, map[string]any{"id": f.ID, "name": f.Name, "path": f.Path,
					"workspace": map[string]any{"id": wsp.ID, "name": wsp.Name}})
			}
		}
		if strings.Contains(strings.ToLower(wsp.Name), q) && len(wss) < limit {
			wss = append(wss, map[string]any{"id": wsp.ID, "name": wsp.Name, "role": wsp.Members[user]})
		}
	}
	out["folders"], out["workspaces"] = folders, wss
	writeJSON(w, 200, out)
}
