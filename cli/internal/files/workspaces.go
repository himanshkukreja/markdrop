package files

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// WorkspaceDomain is one domain of a workspace in GET /api/v1/workspaces.
type WorkspaceDomain struct {
	Host     string `json:"host"`
	Kind     string `json:"kind,omitempty"`
	Status   string `json:"status,omitempty"`
	Verified bool   `json:"verified"`
	Primary  bool   `json:"primary"`
	Live     bool   `json:"live"`
}

// Workspace is one row of GET /api/v1/workspaces.
type Workspace struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Role          string            `json:"role"`
	PrimaryHost   *string           `json:"primary_host"`
	DefaultAccess string            `json:"default_access,omitempty"`
	Domains       []WorkspaceDomain `json:"domains"`
}

// Folder is one folder of GET /api/v1/workspaces/{id}/tree.
type Folder struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Slug       string  `json:"slug"`
	ParentID   *string `json:"parent_id"`
	Path       string  `json:"path"`
	Depth      int     `json:"depth"`
	ItemCount  int     `json:"item_count"`
	TotalCount int     `json:"total_count"`
}

// Tree is GET /api/v1/workspaces/{id}/tree: the folders the caller can see.
type Tree struct {
	Workspace struct {
		ID          string  `json:"id"`
		Name        string  `json:"name"`
		Role        string  `json:"role"`
		PrimaryHost *string `json:"primary_host"`
	} `json:"workspace"`
	Folders      []Folder `json:"folders"`
	UnfiledCount int      `json:"unfiled_count"`
}

// Workspaces lists the workspaces the token's owner belongs to.
func (c *Client) Workspaces(ctx context.Context) ([]Workspace, error) {
	var out struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/workspaces", nil, &out, "list your workspaces"); err != nil {
		return nil, err
	}
	if out.Workspaces == nil {
		out.Workspaces = []Workspace{}
	}
	return out.Workspaces, nil
}

// Tree reads a workspace's folders.
func (c *Client) Tree(ctx context.Context, workspaceID string) (*Tree, error) {
	var raw json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/api/v1/workspaces/"+url.PathEscape(workspaceID)+"/tree", nil, &raw,
		"list the folders of that workspace"); err != nil {
		return nil, err
	}
	var t Tree
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("unexpected answer from the server: %w", err)
	}
	if t.Folders == nil {
		t.Folders = []Folder{}
	}
	return &t, nil
}

// ResolveWorkspace finds one of the caller's workspaces by its id, its name
// (case-insensitive) or one of its domains (docs.acme.com, with or without
// https://). The API itself takes ids only.
func (c *Client) ResolveWorkspace(ctx context.Context, ref string) (*Workspace, error) {
	want := strings.TrimSpace(ref)
	if want == "" {
		return nil, fmt.Errorf("give a workspace id, name or domain")
	}
	all, err := c.Workspaces(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == want {
			return &all[i], nil
		}
	}
	var named []*Workspace
	for i := range all {
		if strings.EqualFold(strings.TrimSpace(all[i].Name), want) {
			named = append(named, &all[i])
		}
	}
	switch len(named) {
	case 1:
		return named[0], nil
	case 0:
	default:
		ids := make([]string, len(named))
		for i, w := range named {
			ids[i] = w.ID
		}
		return nil, fmt.Errorf("more than one of your workspaces is called %q; use its id (%s)", want,
			strings.Join(ids, ", "))
	}
	host := hostOf(want)
	for i := range all {
		for _, d := range all[i].Domains {
			if host != "" && strings.EqualFold(d.Host, host) {
				return &all[i], nil
			}
		}
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("you have no workspace %q: you aren't a member of any workspace", want)
	}
	names := make([]string, len(all))
	for i, w := range all {
		names[i] = fmt.Sprintf("%s (%s)", w.Name, w.ID)
	}
	return nil, fmt.Errorf("you have no workspace %q; yours are: %s", want, strings.Join(names, ", "))
}

func hostOf(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSuffix(s, ".")
}

// LiveDomains are the hosts of a workspace's document domains that serve now.
func (w *Workspace) LiveDomains() []string {
	var out []string
	for _, d := range w.Domains {
		if d.Live && (d.Kind == "" || d.Kind == "app") {
			out = append(out, d.Host)
		}
	}
	return out
}
