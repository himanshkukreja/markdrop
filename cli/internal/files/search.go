package files

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Search finds documents, pages, files, folders, workspaces and Guides pages
// the caller can open.
//
// It runs on GET /api/v1/search, the app's global search: fuzzy (typos,
// partial words, any order) over titles, headings, text and file contents,
// with a snippet per hit. A server from before that API answers 404; the
// search then falls back to GET /api/v1/search/quick (titles, slugs and file
// names only). Commands and the MCP layer only see SearchResults.

// SearchBackendV1 is GET /api/v1/search.
const SearchBackendV1 = "search"

// SearchBackendQuick is GET /api/v1/search/quick.
const SearchBackendQuick = "quick"

// SearchBackend selects the API the search uses (tests set it to quick).
var SearchBackend = SearchBackendV1

// SearchMaxLimit is the most results /search returns in one answer.
const SearchMaxLimit = 50

// SearchQuickMaxLimit is the most results per group /search/quick returns.
const SearchQuickMaxLimit = 20

// SearchOptions narrow a search.
type SearchOptions struct {
	Limit       int    // results; default 20, at most 50 (the quick fallback: per kind, default 8, at most 20)
	WorkspaceID string // only items in this workspace ("" = everywhere)
	Kind        string // page, document, file, folder, workspace or guide ("" = all)
}

// SearchHit is one result.
type SearchHit struct {
	Kind        string           `json:"kind"` // page, document, file, folder, workspace or guide
	Title       string           `json:"title"`
	Slug        string           `json:"slug,omitempty"`
	ID          string           `json:"id,omitempty"` // folders, workspaces and Guides pages
	URL         string           `json:"url,omitempty"`
	MarkdropURL string           `json:"markdrop_url,omitempty"`
	Workspace   *SearchWorkspace `json:"workspace,omitempty"`
	Path        string           `json:"path,omitempty"` // a folder's path; a result's folder; a Guides page's guide and path
	UpdatedAt   string           `json:"updated_at,omitempty"`
	TypeLabel   *string          `json:"type_label,omitempty"` // a file's type ("PDF", "Video", …)
	Snippet     string           `json:"snippet,omitempty"`    // the matching text (not from the quick fallback)
	Match       string           `json:"match,omitempty"`      // where it matched: title, heading or body
	Role        *string          `json:"role,omitempty"`
}

// SearchWorkspace names a result's workspace.
type SearchWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SearchResults is a search's answer, in the CLI's own shape.
type SearchResults struct {
	Query   string      `json:"query"`
	Backend string      `json:"backend"`
	Results []SearchHit `json:"results"`
}

// SearchKinds are the values SearchOptions.Kind takes.
var SearchKinds = []string{"page", "document", "file", "folder", "workspace", "guide"}

// Search runs a search with the selected backend.
func (c *Client) Search(ctx context.Context, q string, opts SearchOptions) (*SearchResults, error) {
	q = strings.TrimSpace(q)
	if len([]rune(q)) < 2 {
		return nil, fmt.Errorf("search for at least 2 characters")
	}
	if opts.Kind != "" {
		ok := false
		for _, k := range SearchKinds {
			ok = ok || k == opts.Kind
		}
		if !ok {
			return nil, fmt.Errorf("kind must be one of %s (got %q)", strings.Join(SearchKinds, ", "), opts.Kind)
		}
	}
	// The one place that picks the API (see the comment above Search).
	if SearchBackend == SearchBackendQuick {
		return c.searchQuick(ctx, q, opts)
	}
	res, err := c.searchV1(ctx, q, opts)
	if IsStatus(err, http.StatusNotFound) || IsStatus(err, http.StatusMethodNotAllowed) {
		return c.searchQuick(ctx, q, opts) // a server from before GET /api/v1/search
	}
	return res, err
}

// v1Hit is one result of GET /api/v1/search.
type v1Hit struct {
	Kind      string           `json:"kind"` // page, doc, file, folder, workspace, guide
	Slug      string           `json:"slug"`
	ID        string           `json:"id"`
	Title     *string          `json:"title"`
	URL       string           `json:"url"`
	WebURL    string           `json:"web_url"`
	Workspace *SearchWorkspace `json:"workspace"`
	Folder    *struct {
		Path []string `json:"path"` // a result's folder: from the root to it; a folder: its parents
	} `json:"folder"`
	Guide *struct {
		Name string `json:"name"`
	} `json:"guide"`
	Path      string  `json:"path"` // a Guides page's path
	UpdatedAt *string `json:"updated_at"`
	TypeLabel *string `json:"type_label"`
	Role      *string `json:"role"`
	Match     string  `json:"match"`
	Snippet   *struct {
		Text string `json:"text"`
	} `json:"snippet"`
}

func (c *Client) searchV1(ctx context.Context, q string, opts SearchOptions) (*SearchResults, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	limit = min(limit, SearchMaxLimit)
	v := url.Values{"q": {q}, "limit": {strconv.Itoa(limit)}, "trash": {"false"}}
	if opts.WorkspaceID != "" {
		v.Set("scope", "workspace:"+opts.WorkspaceID)
	}
	switch opts.Kind {
	case "":
	case "document":
		v.Set("kind", "doc")
	default:
		v.Set("kind", opts.Kind)
	}
	var out struct {
		Items []v1Hit `json:"items"`
	}
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/search?"+v.Encode(), nil, &out, "search"); err != nil {
		return nil, err
	}
	res := &SearchResults{Query: q, Backend: SearchBackendV1, Results: []SearchHit{}}
	for _, it := range out.Items {
		h := SearchHit{Kind: it.Kind, Slug: it.Slug, URL: it.WebURL, Workspace: it.Workspace,
			TypeLabel: it.TypeLabel, Role: it.Role, Match: it.Match}
		if h.URL == "" {
			h.URL = it.URL
		}
		if it.Title != nil {
			h.Title = *it.Title
		}
		if h.Title == "" {
			h.Title = it.Slug
		}
		if h.Title == "" {
			h.Title = "Untitled"
		}
		if it.UpdatedAt != nil {
			h.UpdatedAt = *it.UpdatedAt
		}
		if it.Snippet != nil {
			h.Snippet = strings.TrimSpace(it.Snippet.Text)
		}
		var folder []string
		if it.Folder != nil {
			folder = it.Folder.Path
		}
		switch it.Kind {
		case "doc":
			h.Kind = "document"
			h.Path = strings.Join(folder, "/")
		case "page", "file":
			h.Path = strings.Join(folder, "/")
		case "folder":
			h.ID = it.ID
			h.Path = strings.Join(append(append([]string{}, folder...), h.Title), "/")
		case "workspace":
			h.ID = it.ID
			h.Workspace = nil
		case "guide":
			h.ID = it.ID
			if it.Guide != nil {
				h.Path = strings.TrimSuffix(it.Guide.Name+it.Path, "/")
			}
		}
		res.Results = append(res.Results, h)
	}
	return res, nil
}

type quickFile struct {
	Slug        string           `json:"slug"`
	Title       *string          `json:"title"`
	Kind        string           `json:"kind"`
	Editor      *string          `json:"editor"`
	URL         string           `json:"url"`
	MarkdropURL string           `json:"markdrop_url"`
	TypeLabel   *string          `json:"type_label"`
	UpdatedAt   string           `json:"updated_at"`
	Workspace   *SearchWorkspace `json:"workspace"`
	Role        *string          `json:"role"`
	Redacted    bool             `json:"redacted"`
}

func (c *Client) searchQuick(ctx context.Context, q string, opts SearchOptions) (*SearchResults, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 8
	}
	limit = min(limit, SearchQuickMaxLimit)
	fetch := limit
	if opts.WorkspaceID != "" || opts.Kind != "" {
		fetch = SearchQuickMaxLimit // filtered here: ask for more
	}
	var out struct {
		Files   []quickFile `json:"files"`
		Folders []struct {
			ID        string           `json:"id"`
			Name      string           `json:"name"`
			Path      string           `json:"path"`
			Workspace *SearchWorkspace `json:"workspace"`
		} `json:"folders"`
		Workspaces []struct {
			ID   string  `json:"id"`
			Name string  `json:"name"`
			Role *string `json:"role"`
		} `json:"workspaces"`
	}
	p := "/api/v1/search/quick?q=" + url.QueryEscape(q) + "&limit=" + strconv.Itoa(fetch)
	if _, err := c.do(ctx, http.MethodGet, p, nil, &out, "search"); err != nil {
		return nil, err
	}
	res := &SearchResults{Query: q, Backend: SearchBackendQuick, Results: []SearchHit{}}
	want := func(kind string, ws *SearchWorkspace) bool {
		if opts.Kind != "" && opts.Kind != kind {
			return false
		}
		if opts.WorkspaceID != "" && (ws == nil || ws.ID != opts.WorkspaceID) {
			return false
		}
		return true
	}
	n := 0
	for _, f := range out.Files {
		if f.Redacted || f.Slug == "" {
			continue
		}
		kind := "document"
		switch {
		case f.Kind == "artifact":
			kind = "file"
		case f.Editor != nil && *f.Editor == "blocks":
			kind = "page"
		}
		if !want(kind, f.Workspace) || n >= limit {
			continue
		}
		n++
		title := f.Slug
		if f.Title != nil && *f.Title != "" {
			title = *f.Title
		}
		res.Results = append(res.Results, SearchHit{Kind: kind, Title: title, Slug: f.Slug, URL: f.URL,
			MarkdropURL: f.MarkdropURL, Workspace: f.Workspace, UpdatedAt: f.UpdatedAt, TypeLabel: f.TypeLabel,
			Role: f.Role})
	}
	n = 0
	for _, f := range out.Folders {
		if !want("folder", f.Workspace) || n >= limit {
			continue
		}
		n++
		res.Results = append(res.Results, SearchHit{Kind: "folder", Title: f.Name, ID: f.ID, Path: f.Path,
			Workspace: f.Workspace})
	}
	n = 0
	for _, w := range out.Workspaces {
		ws := &SearchWorkspace{ID: w.ID, Name: w.Name}
		if !want("workspace", ws) || n >= limit {
			continue
		}
		n++
		res.Results = append(res.Results, SearchHit{Kind: "workspace", Title: w.Name, ID: w.ID, Role: w.Role})
	}
	return res, nil
}

// MarshalJSON keeps Results a list when empty.
func (r *SearchResults) MarshalJSON() ([]byte, error) {
	type alias SearchResults
	a := alias(*r)
	if a.Results == nil {
		a.Results = []SearchHit{}
	}
	return json.Marshal(a)
}
