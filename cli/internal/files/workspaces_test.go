package files

import (
	"context"
	"strings"
	"testing"

	"github.com/markdrop/cli/internal/files/fakeapi"
)

func TestResolveWorkspace(t *testing.T) {
	f := newFake(t)
	f.AddAcme()
	c := &Client{Base: f.URL, Token: fakeapi.Token}
	ctx := context.Background()
	for _, ref := range []string{"ws_acme", "Acme", "acme", " ACME ", "docs.acme.test",
		"https://docs.acme.test/guides/x", "DOCS.ACME.TEST."} {
		ws, err := c.ResolveWorkspace(ctx, ref)
		if err != nil || ws.ID != "ws_acme" {
			t.Errorf("%q: %v %v", ref, ws, err)
		}
	}
	ws, err := c.ResolveWorkspace(ctx, "Side")
	if err != nil || ws.ID != "ws_side" || ws.Role != "owner" || len(ws.LiveDomains()) != 0 {
		t.Errorf("Side: %+v %v", ws, err)
	}
	acme, _ := c.ResolveWorkspace(ctx, "acme")
	if got := acme.LiveDomains(); len(got) != 1 || got[0] != "docs.acme.test" {
		t.Errorf("live document domains %v (the files-only host is not one)", got)
	}
	if _, err := c.ResolveWorkspace(ctx, "Nope"); err == nil || !strings.Contains(err.Error(), "Acme (ws_acme)") {
		t.Errorf("unknown workspace: %v", err)
	}
	f.AddWorkspace(fakeapi.Workspace{ID: "ws_acme2", Name: "acme", Members: map[string]string{fakeapi.Token: "admin"}})
	if _, err := c.ResolveWorkspace(ctx, "Acme"); err == nil || !strings.Contains(err.Error(), "more than one") {
		t.Errorf("ambiguous name: %v", err)
	}
	// Someone else sees only what they belong to.
	other := &Client{Base: f.URL, Token: fakeapi.OtherToken}
	all, err := other.Workspaces(ctx)
	if err != nil || len(all) != 1 || all[0].Role != "viewer" {
		t.Errorf("other's workspaces %+v %v", all, err)
	}
}

func TestTree(t *testing.T) {
	f := newFake(t)
	f.AddAcme()
	c := &Client{Base: f.URL, Token: fakeapi.Token}
	tree, err := c.Tree(context.Background(), "ws_acme")
	if err != nil {
		t.Fatal(err)
	}
	if tree.Workspace.Name != "Acme" || len(tree.Folders) != 2 || tree.Folders[1].Path != "guides/setup" ||
		tree.Folders[1].Depth != 2 {
		t.Errorf("tree %+v", tree)
	}
	if _, err := c.Tree(context.Background(), "ws_nope"); !IsStatus(err, 404) {
		t.Errorf("unknown workspace: %v", err)
	}
}

func TestUploadIntoWorkspaceFolderWithSlug(t *testing.T) {
	f := newFake(t)
	f.AddAcme()
	u := newUploader(t, f, fakeapi.Token)
	path, _ := writeFile(t, "Spec.pdf", 2000)
	res, err := u.Upload(context.Background(), UploadOptions{
		Path: path, Workspace: "ws_acme", Folder: "guides/setup", Slug: "q3-spec", Access: "workspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Slug != "q3-spec" || res.URL != "https://docs.acme.test/guides/setup/q3-spec" ||
		res.MarkdropURL != f.WebBase+"/q3-spec" || res.WorkspaceURL == nil || *res.WorkspaceURL != res.URL {
		t.Errorf("result %+v", res)
	}
	lc := f.LastCreate
	if lc["workspace"] != "ws_acme" || lc["folder"] != "guides/setup" || lc["slug"] != "q3-spec" {
		t.Errorf("create %v", lc)
	}
	// Taken now: refused before any part moves.
	f.ResetCounts()
	path2, _ := writeFile(t, "Other.pdf", 100)
	if _, err = u.Upload(context.Background(), UploadOptions{Path: path2, Slug: "q3-spec"}); !IsStatus(err, 409) ||
		f.TotalPuts() != 0 {
		t.Errorf("taken slug: %v (puts %d)", err, f.TotalPuts())
	}
	// No live domain: the markdrop.in link is the link.
	res, err = u.Upload(context.Background(), UploadOptions{Path: path2, Workspace: "ws_side"})
	if err != nil || res.URL != f.WebBase+"/other" || res.MarkdropURL != res.URL || res.WorkspaceURL != nil {
		t.Errorf("no domain: %+v %v", res, err)
	}
	// A replace never sends the new-upload fields.
	_, err = u.Upload(context.Background(), UploadOptions{Path: path2, TargetSlug: "q3-spec",
		Workspace: "ws_acme", Folder: "guides", Slug: "x-y-z"})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"workspace", "folder", "slug"} {
		if _, ok := f.LastCreate[k]; ok {
			t.Errorf("replace sent %s: %v", k, f.LastCreate)
		}
	}
}

func TestStateKeyKeepsOldKeys(t *testing.T) {
	base := CreateUploadRequest{FileName: "a", Title: "t"}
	k := stateKey("s", "/a", 1, 2, "h", base)
	if k != stateKey("s", "/a", 1, 2, "h", base) {
		t.Fatal("unstable")
	}
	withFolder, withSlug := base, base
	withFolder.Folder, withSlug.Slug = "x", "x"
	a, b := stateKey("s", "/a", 1, 2, "h", withFolder), stateKey("s", "/a", 1, 2, "h", withSlug)
	if a == k || b == k || a == b {
		t.Error("folder and slug must change the key, and differently")
	}
}
