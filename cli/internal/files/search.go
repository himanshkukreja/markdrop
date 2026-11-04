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

// Search finds documents, pages, files, folders and workspaces the caller can
// open.
//
// Today it runs on GET /api/v1/search/quick (the app's ⌘K: titles, slugs and
// file names, never content; folders and workspaces by name). A full search
// API, GET /api/v1/search (content, snippets, filters, cursor), is being built
// on the server; when it ships, add a searchV1 adapter that fills the same
// SearchResults and point SearchBackend at it (or probe it and fall back to
// quick on a 404). Commands and the MCP layer only see SearchResults.

// SearchBackendQuick is GET /api/v1/search/quick.
const SearchBackendQuick = "quick"

// SearchBackend selects the API the search uses.
var SearchBackend = SearchBackendQuick

// SearchQuickMaxLimit is the most results per group /search/quick returns.
const SearchQuickMaxLimit = 20

// SearchOptions narrow a search.
type SearchOptions struct {
	Limit       int    // per group; default 8
	WorkspaceID string // only items in this workspace ("" = everywhere)
	Kind        string // page, document, file, folder or workspace ("" = all)
}

// SearchHit is one result.
type SearchHit struct {
	Kind        string           `json:"kind"` // page, document, file, folder or workspace
	Title       string           `json:"title"`
	Slug        string           `json:"slug,omitempty"`
	ID          string           `json:"id,omitempty"` // folders and workspaces
	URL         string           `json:"url,omitempty"`
	MarkdropURL string           `json:"markdrop_url,omitempty"`
	Workspace   *SearchWorkspace `json:"workspace,omitempty"`
	Path        string           `json:"path,omitempty"` // a folder's path
	UpdatedAt   string           `json:"updated_at,omitempty"`
	TypeLabel   *string          `json:"type_label,omitempty"` // a file's type ("PDF", "Video", …)
	Snippet     string           `json:"snippet,omitempty"`    // the full search API only
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
var SearchKinds = []string{"page", "document", "file", "folder", "workspace"}

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
	// The one place that picks the API (see the package comment above).
	return c.searchQuick(ctx, q, opts)
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
