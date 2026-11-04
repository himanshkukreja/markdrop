package cmd

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/markdrop/cli/internal/files/fakeapi"
	"github.com/spf13/cobra"
)

// runIn is run with stdin.
func (e *cliEnv) runIn(stdin string, args ...string) (stdout, stderr string, err error) {
	root := &cobra.Command{Use: "markdrop", SilenceUsage: true, SilenceErrors: true}
	old := flagServer
	defer func() { flagServer = old }()
	root.PersistentFlags().StringVar(&flagServer, "server", defaultServer, "")
	addFileCommands(root)
	var out, errb bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errb)
	root.SetIn(strings.NewReader(stdin))
	root.SetArgs(withServer(args, e.fake.URL))
	err = root.ExecuteContext(context.Background())
	return out.String(), errb.String(), err
}

// withServer adds --server before a "--" (after it, it would be an argument).
func withServer(args []string, url string) []string {
	for i, a := range args {
		if a == "--" {
			return append(append(append([]string{}, args[:i]...), "--server", url), args[i:]...)
		}
	}
	return append(args, "--server", url)
}

func writeTemp(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func mustErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("error %v, want one containing %q", err, want)
	}
}

func TestPageNewInWorkspaceJSON(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	md := writeTemp(t, "setup.md", "# Setup\r\n\r\nInstall it.\r\n")
	stdout, stderr, err := e.run("page", "new", "Setup guide", "--workspace", "docs.acme.test", "--folder", "/guides/",
		"--slug", "setup-guide", "--from-file", md, "--icon", "🚀", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj := oneJSONObject(t, stdout)
	if obj["url"] != "https://docs.acme.test/guides/setup-guide" || obj["markdrop_url"] != e.fake.WebBase+"/setup-guide" ||
		obj["slug"] != "setup-guide" || obj["title"] != "Setup guide" || obj["rev"] != 1.0 {
		t.Errorf("result %v", obj)
	}
	if strings.Contains(stdout, "es_secret") || strings.Contains(stdout, "edit_secret") {
		t.Errorf("the edit secret was printed: %s", stdout)
	}
	c := e.fake.LastPageCreate
	if c["workspace"] != "ws_acme" || c["folder"] != "guides" || c["content"] != "---\nicon: 🚀\n---\n# Setup\n\nInstall it.\n" ||
		c["template"] != nil || c["auto_cover"] != nil {
		t.Errorf("create %v", c)
	}
}

func TestPageNewTemplateCoverAndStdout(t *testing.T) {
	e := setup(t)
	stdout, stderr, err := e.run("page", "new", "Standup", "--template", fakeapi.BuiltinTemplate, "--cover",
		"gallery:dusk", "--no-auto-cover")
	if err != nil {
		t.Fatal(err, stderr)
	}
	if stdout != e.fake.WebBase+"/standup\n" {
		t.Errorf("stdout %q", stdout)
	}
	if !strings.Contains(stderr, `Created the page "Standup"`) {
		t.Errorf("stderr %q", stderr)
	}
	p := e.fake.Page("standup")
	if !strings.HasPrefix(p.Content, "---\ncover: gallery:dusk\n---\n# Standup") || p.Title != "Standup" ||
		p.TemplateID != fakeapi.BuiltinTemplate {
		t.Errorf("page %+v", p)
	}
	if e.fake.LastPageCreate["auto_cover"] != false {
		t.Errorf("auto_cover %v", e.fake.LastPageCreate["auto_cover"])
	}
}

func TestPageNewStdinParentAndRefusals(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("guide", fakeapi.Token, "Guide", "# Guide\n")
	stdout, stderr, err := e.runIn("Step one.\n", "page", "new", "Step 1", "--parent", "https://markdrop.in/guide",
		"--from-file", "-")
	if err != nil {
		t.Fatal(err, stderr)
	}
	p := e.fake.Page("step-1")
	if p == nil || p.Parent != "guide" || p.Content != "Step one.\n" || stdout != e.fake.WebBase+"/step-1\n" {
		t.Fatalf("page %+v stdout %q", p, stdout)
	}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"page", "new", "X", "--parent", "guide", "--workspace", "Acme"}, "--parent alone"},
		{[]string{"page", "new", "X", "--folder", "guides"}, "--folder needs --workspace"},
		{[]string{"page", "new", "X", "--template", "t", "--from-file", "f"}, "not both"},
		{[]string{"page", "new", "X", "--cover", "asset:abcdefgh1234"}, "no images yet"},
		{[]string{"page", "new", "X", "--font", "comic"}, "unknown flag"},
		{[]string{"page", "new", "X", "--cover", "gallery:BAD!"}, "cover must be"},
		{[]string{"page", "new", "X", "--slug", "guide"}, "already taken"},
		{[]string{"page", "new", "X", "--slug", "a b"}, "--slug must be"},
		{[]string{"page", "new", "X", "--workspace", "Nope"}, "no workspace"},
	} {
		_, _, err := e.run(c.args...)
		mustErr(t, err, c.want)
	}
}

func TestPageGet(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("handbook", fakeapi.Token, "Handbook", "---\nicon: 📘\n---\n# Handbook\n\nWelcome.")
	e.fake.AddPage("handbook-ch1", fakeapi.Token, "Chapter 1", "# One\n")
	e.fake.SetParent("handbook-ch1", "handbook")

	stdout, _, err := e.run("page", "get", "handbook")
	if err != nil || stdout != "---\nicon: 📘\n---\n# Handbook\n\nWelcome.\n" {
		t.Fatalf("get %q %v", stdout, err)
	}
	stdout, _, _ = e.run("page", "get", "handbook", "--body")
	if stdout != "# Handbook\n\nWelcome.\n" {
		t.Errorf("--body %q", stdout)
	}
	stdout, _, _ = e.run("page", "get", "handbook", "--info")
	for _, want := range []string{e.fake.WebBase + "/handbook", "title      Handbook", "revision   1", "icon       📘",
		"sub-page   Chapter 1 (handbook-ch1)"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("--info lacks %q:\n%s", want, stdout)
		}
	}
	stdout, _, _ = e.run("page", "get", "handbook", "--json")
	obj := oneJSONObject(t, stdout)
	props, _ := obj["properties"].(map[string]any)
	kids, _ := obj["children"].([]any)
	if obj["markdown"] != "---\nicon: 📘\n---\n# Handbook\n\nWelcome." || obj["editor"] != "blocks" || obj["rev"] != 1.0 ||
		props["icon"] != "📘" || len(kids) != 1 {
		t.Errorf("--json %v", obj)
	}
	e.fake.AddDoc("clip", fakeapi.Token, "artifact", []byte("x"), "video/mp4")
	_, _, err = e.run("page", "get", "clip")
	mustErr(t, err, "is a file, not a page")
	_, _, err = e.run("page", "get", "missing")
	mustErr(t, err, "not found")
}

func TestPageUpdate(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("notes", fakeapi.Token, "Notes", "old\n")
	md := writeTemp(t, "n.md", "new text\n")
	stdout, stderr, err := e.run("page", "update", "notes", "--from-file", md)
	if err != nil {
		t.Fatal(err, stderr)
	}
	p := e.fake.Page("notes")
	if p.Content != "new text\n" || p.Title != "Notes" || p.Rev != 2 || stdout != e.fake.WebBase+"/notes\n" {
		t.Errorf("page %+v stdout %q", p, stdout)
	}
	if e.fake.LastPut["title"] != "Notes" || e.fake.LastPut["base_rev"] != 1.0 {
		t.Errorf("put %v (the title must be resent: the API clears a missing one)", e.fake.LastPut)
	}
	if _, _, err := e.run("page", "update", "notes", "--title", "Notes (final)"); err != nil {
		t.Fatal(err)
	}
	if p := e.fake.Page("notes"); p.Title != "Notes (final)" || p.Content != "new text\n" {
		t.Errorf("title only: %+v", p)
	}
	_, _, err = e.run("page", "update", "notes", "--from-file", md, "--base-rev", "1")
	mustErr(t, err, "changed since revision 1 (it is at revision 3)")
	_, _, err = e.run("page", "update", "notes")
	mustErr(t, err, "--from-file")
	empty := writeTemp(t, "e.md", " \n")
	_, _, err = e.run("page", "update", "notes", "--from-file", empty)
	mustErr(t, err, "empty")
	_, _, err = e.run("page", "update", "notes", "--from-file", md, "--token", fakeapi.OtherToken)
	mustErr(t, err, "not allowed")
}

func TestPageAppendMergesAConcurrentSave(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("log", fakeapi.Token, "Log", "# Log\n")
	once := false
	e.fake.BeforePut = func(slug string) {
		if !once {
			once = true
			e.fake.Edit(slug, "# Log\n\n- theirs\n")
		}
	}
	stdout, stderr, err := e.run("page", "append", "log", "-", "mine", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj := oneJSONObject(t, stdout)
	if p := e.fake.Page("log"); p.Content != "# Log\n\n- theirs\n\n- mine\n" || obj["rev"] != float64(p.Rev) {
		t.Errorf("content %q rev %v obj %v", p.Content, p.Rev, obj)
	}
	if e.fake.PagePuts != 2 {
		t.Errorf("puts %d (one refused as stale, one saved)", e.fake.PagePuts)
	}
	e.fake.BeforePut = nil

	// From stdin, and refused while someone else holds the editor.
	if _, _, err := e.runIn("line from stdin\n", "page", "append", "log", "--from-file", "-"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(e.fake.Page("log").Content, "- mine\n\nline from stdin\n") {
		t.Errorf("stdin append %q", e.fake.Page("log").Content)
	}
	e.fake.SetEditing("log", fakeapi.OtherToken)
	_, _, err = e.run("page", "append", "log", "x")
	mustErr(t, err, "editing this page")
	_, _, err = e.run("page", "append", "log")
	mustErr(t, err, "nothing to add")
	_, _, err = e.run("page", "append", "log", "- a list item")
	mustErr(t, err, "goes after --")
	e.fake.SetEditing("log", "")
	if _, _, err := e.run("page", "append", "log", "--", "- a list item"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(e.fake.Page("log").Content, "\n\n- a list item\n") {
		t.Errorf("-- append %q", e.fake.Page("log").Content)
	}
}

func TestPageProps(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	e.fake.AddPage("spec", fakeapi.Token, "Spec", "---\ntags: x\nicon: 📝\n---\n# Spec\n")
	stdout, stderr, err := e.run("page", "props", "spec", "--icon", "🚀", "--cover", "gallery:dusk", "--full-width",
		"--font", "serif", "--cover-y", "20", "--allow-export=false")
	if err != nil {
		t.Fatal(err, stderr)
	}
	want := "---\ntags: x\nicon: 🚀\ncover: gallery:dusk\ncover_y: 20\nfull_width: true\nfont: serif\nallow_export: false\n---\n# Spec\n"
	if got := e.fake.Page("spec").Content; got != want {
		t.Errorf("content\n got %q\nwant %q", got, want)
	}
	for _, w := range []string{"icon          🚀", "cover         gallery:dusk", "full_width    true", "font          serif"} {
		if !strings.Contains(stdout, w) {
			t.Errorf("table lacks %q:\n%s", w, stdout)
		}
	}
	if _, _, err := e.run("page", "props", "spec", "--clear", "icon", "--clear", "full-width", "--cover", "auto"); err != nil {
		t.Fatal(err)
	}
	if got := e.fake.Page("spec").Content; got !=
		"---\ntags: x\ncover: gallery:dusk\ncover_y: 20\nfont: serif\nallow_export: false\n---\n# Spec\n" {
		t.Errorf("after clear %q", got)
	}
	stdout, _, _ = e.run("page", "props", "spec", "--json")
	obj := oneJSONObject(t, stdout)
	props, _ := obj["properties"].(map[string]any)
	if props["cover"] != "gallery:dusk" || props["icon"] != nil || obj["slug"] != "spec" {
		t.Errorf("--json %v", obj)
	}

	// Typed properties of a folder with a schema.
	if _, _, err := e.run("page", "new", "Task", "--workspace", "Acme", "--folder", "guides", "--slug", "task-1"); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, err = e.run("page", "props", "task-1", "--set", "Status=Done", "--set", "Points=3", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj = oneJSONObject(t, stdout)
	vals, _ := obj["values"].(map[string]any)
	if vals["Status"] != "Done" || vals["Points"] != 3.0 {
		t.Errorf("values %v", obj)
	}
	_, _, err = e.run("page", "props", "task-1", "--set", "Nope=1")
	mustErr(t, err, "Unknown property")
	_, _, err = e.run("page", "props", "spec", "--set", "x")
	mustErr(t, err, "key=value")
	_, _, err = e.run("page", "props", "spec", "--font", "comic")
	mustErr(t, err, "font must be")
	_, _, err = e.run("page", "props", "spec", "--clear", "colour")
	mustErr(t, err, "--clear takes")
}

func TestPageTemplates(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	stdout, _, err := e.run("page", "templates")
	if err != nil || !strings.Contains(stdout, fakeapi.BuiltinTemplate) || strings.Contains(stdout, "tpl_acme") {
		t.Fatalf("templates %q %v", stdout, err)
	}
	stdout, _, err = e.run("page", "templates", "--workspace", "Acme", "--json")
	if err != nil {
		t.Fatal(err)
	}
	obj := oneJSONObject(t, stdout)
	ts, _ := obj["templates"].([]any)
	if len(ts) != 2 || ts[1].(map[string]any)["scope"] != "workspace" || ts[0].(map[string]any)["scope"] != "builtin" {
		t.Errorf("templates %v", obj)
	}
}

var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 64)...)

func TestPageImageAdd(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("launch", fakeapi.Token, "Launch", "# Launch\n")
	img := filepath.Join(t.TempDir(), "Hero [v2].png")
	_ = os.WriteFile(img, pngBytes, 0o644)

	stdout, stderr, err := e.run("page", "image", "add", "launch", img)
	if err != nil {
		t.Fatal(err, stderr)
	}
	if !strings.HasPrefix(stdout, "![Hero v2 ](asset:") && !strings.HasPrefix(stdout, "![Hero v2](asset:") {
		t.Errorf("markdown %q", stdout)
	}
	if e.fake.Page("launch").Content != "# Launch\n" {
		t.Error("a plain add changed the page")
	}
	stdout, stderr, err = e.run("page", "image", "add", "launch", img, "--cover", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj := oneJSONObject(t, stdout)
	asset, _ := obj["asset"].(string)
	if !strings.HasPrefix(asset, "asset:") || obj["mime"] != "image/png" || obj["cover"] != true {
		t.Errorf("--json %v", obj)
	}
	if got := e.fake.Page("launch").Content; got != "---\ncover: "+asset+"\n---\n# Launch\n" {
		t.Errorf("cover not set: %q", got)
	}
	if _, _, err := e.run("page", "image", "add", "launch", img, "--append", "--alt", "Signups"); err != nil {
		t.Fatal(err)
	}
	if got := e.fake.Page("launch").Content; !strings.Contains(got, "# Launch\n\n![Signups](asset:") {
		t.Errorf("append %q", got)
	}
	txt := writeTemp(t, "notes.txt", "not an image")
	_, _, err = e.run("page", "image", "add", "launch", txt)
	mustErr(t, err, "isn't a PNG")
	big := filepath.Join(t.TempDir(), "big.png")
	_ = os.WriteFile(big, make([]byte, 10<<20+1), 0o644)
	_, _, err = e.run("page", "image", "add", "launch", big)
	mustErr(t, err, "up to 10 MB")
	_, _, err = e.run("page", "image", "add", "launch", img, "--cover", "--icon")
	mustErr(t, err, "not both")
}

func TestPageVersionsVersionRestore(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("plan", fakeapi.Token, "Plan", "v1\n")
	e.fake.Edit("plan", "v2\n")
	e.fake.Edit("plan", "v3\n")
	stdout, _, err := e.run("page", "versions", "plan")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[1], "* 3") || !strings.HasPrefix(lines[3], "  1") ||
		!strings.Contains(lines[1], "someoneelse") {
		t.Errorf("versions:\n%s", stdout)
	}
	_, stderr, _ := e.run("page", "versions", "plan", "--limit", "2")
	if !strings.Contains(stderr, "--cursor 2") {
		t.Errorf("more hint %q", stderr)
	}
	stdout, _, _ = e.run("page", "version", "plan", "v1")
	if stdout != "v1\n" {
		t.Errorf("version 1 %q", stdout)
	}
	stdout, stderr, err = e.run("page", "restore", "plan", "1", "--json")
	if err != nil {
		t.Fatal(err, stderr)
	}
	obj := oneJSONObject(t, stdout)
	if obj["version"] != 4.0 || obj["restored_from"] != 1.0 || e.fake.Page("plan").Content != "v1\n" {
		t.Errorf("restore %v", obj)
	}
	_, _, err = e.run("page", "version", "plan", "9")
	mustErr(t, err, "doesn't exist")
}

func TestLinkSet(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("x7k2p9", fakeapi.Token, "Roadmap", "# R\n")
	e.fake.AddPage("taken", fakeapi.Token, "Other", "o\n")
	stdout, stderr, err := e.run("link", "set", "https://markdrop.in/x7k2p9", "roadmap")
	if err != nil {
		t.Fatal(err, stderr)
	}
	if stdout != e.fake.WebBase+"/roadmap\n" || !strings.Contains(stderr, "/x7k2p9, redirects there") {
		t.Errorf("stdout %q stderr %q", stdout, stderr)
	}
	// The old link still finds it.
	stdout, _, err = e.run("page", "get", "x7k2p9", "--body")
	if err != nil || stdout != "# R\n" {
		t.Errorf("old slug: %q %v", stdout, err)
	}
	stdout, _, err = e.run("link", "set", "x7k2p9", "roadmap-2026", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if obj := oneJSONObject(t, stdout); obj["slug"] != "roadmap-2026" || obj["previous_slug"] != "roadmap" {
		t.Errorf("--json %v", obj)
	}
	_, _, err = e.run("link", "set", "roadmap-2026", "taken")
	mustErr(t, err, "taken")
	_, _, err = e.run("link", "set", "roadmap-2026", "taken", "--check")
	mustErr(t, err, "can't be the new link")
	stdout, _, err = e.run("link", "set", "roadmap-2026", "free-one", "--check")
	if err != nil || stdout != e.fake.WebBase+"/free-one\n" || e.fake.Page("roadmap-2026") == nil {
		t.Errorf("check %q %v (and nothing changes)", stdout, err)
	}
	_, _, err = e.run("link", "set", "roadmap-2026", "no")
	mustErr(t, err, "3-50")
	_, _, err = e.run("link", "set", "roadmap-2026", "theirs-now", "--token", fakeapi.OtherToken)
	mustErr(t, err, "not allowed")
}

func TestExport(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("guide", fakeapi.Token, "Guide", "---\nicon: x\n---\nBody\n")
	e.fake.AddPage("guide-1", fakeapi.Token, "Part 1", "One\n")
	e.fake.SetParent("guide-1", "guide")
	dir := t.TempDir()
	stdout, stderr, err := e.run("export", "guide", "-o", dir)
	if err != nil {
		t.Fatal(err, stderr)
	}
	want := filepath.Join(dir, "guide.md")
	if strings.TrimSpace(stdout) != want {
		t.Errorf("stdout %q", stdout)
	}
	if b, _ := os.ReadFile(want); string(b) != "# Guide\n\nBody\n" {
		t.Errorf("export %q", b)
	}
	_, _, err = e.run("export", "guide", "-o", dir)
	mustErr(t, err, "already exists")
	if _, _, err := e.run("export", "guide", "-o", dir, "--force"); err != nil {
		t.Fatal(err)
	}
	// No temporary files are left behind.
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Errorf("dir has %d entries", len(ents))
	}
	stdout, _, err = e.run("export", "guide", "-o", "-", "--format", "html")
	if err != nil || !strings.HasPrefix(stdout, "<!doctype html>") {
		t.Errorf("-o - %q %v", stdout, err)
	}
	named := filepath.Join(dir, "sub", "all.zip")
	stdout, _, err = e.run("export", "guide", "--subpages", "-o", named, "--json")
	if err != nil {
		t.Fatal(err)
	}
	obj := oneJSONObject(t, stdout)
	if obj["path"] != named || obj["filename"] != "guide.zip" || obj["subpages"] != true || obj["notes"] != 1.0 {
		t.Errorf("--json %v", obj)
	}
	zr, err := zip.OpenReader(named)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if strings.Join(names, ",") != "guide/page.md,guide/guide-1/page.md" {
		t.Errorf("zip %v", names)
	}
	_, _, err = e.run("export", "guide", "--format", "pdf")
	mustErr(t, err, "--format must be")
	_, _, err = e.run("export", "guide", "-o", "-", "--json")
	mustErr(t, err, "can't go with --json")
	e.fake.AddDoc("secret", fakeapi.Token, "markdown", nil, "")
	e.fake.SetEncrypted("secret")
	_, _, err = e.run("export", "secret", "-o", "-")
	mustErr(t, err, "end-to-end encrypted")
}

func TestTrash(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("book", fakeapi.Token, "Book", "b\n")
	e.fake.AddPage("book-1", fakeapi.Token, "Ch 1", "c\n")
	e.fake.SetParent("book-1", "book")

	_, _, err := e.run("trash", "rm", "book")
	mustErr(t, err, "--children delete")
	if _, stderr, err := e.run("trash", "rm", "https://markdrop.in/book", "--children", "delete"); err != nil ||
		!strings.Contains(stderr, "markdrop trash restore book") {
		t.Fatal(err, stderr)
	}
	stdout, _, _ := e.run("trash", "ls")
	if !strings.Contains(stdout, "book") || !strings.Contains(stdout, "page") || strings.Contains(stdout, "book-1") {
		t.Errorf("ls:\n%s", stdout)
	}
	stdout, _, _ = e.run("trash", "ls", "--json")
	if obj := oneJSONObject(t, stdout); len(obj["items"].([]any)) != 1 || obj["days"] != 30.0 {
		t.Errorf("ls --json %v", obj)
	}
	stdout, stderr, err := e.run("trash", "restore", "book")
	if err != nil || stdout != e.fake.WebBase+"/book\n" || !strings.Contains(stderr, "2 item(s)") {
		t.Fatalf("restore %q %q %v", stdout, stderr, err)
	}
	if e.fake.Page("book").Trashed || e.fake.Page("book-1").Trashed {
		t.Error("not restored")
	}
	// Forever needs a confirmation; without a terminal, --yes.
	_, _, err = e.run("trash", "rm", "book", "--permanent", "--children", "lift")
	mustErr(t, err, "add --yes")
	if e.fake.Page("book").Trashed {
		t.Error("deleted without confirmation")
	}
	stdout, _, err = e.run("trash", "rm", "book", "--permanent", "--children", "lift", "--yes", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if obj := oneJSONObject(t, stdout); obj["trashed"] != false || len(obj["deleted_items"].([]any)) != 1 {
		t.Errorf("--json %v", obj)
	}
	if e.fake.Page("book") != nil || e.fake.Page("book-1") == nil || e.fake.Page("book-1").Parent != "" {
		t.Error("permanent delete: the page should be gone, its sub-page lifted")
	}
	// Already in the trash: --permanent deletes it from there.
	_, _, _ = e.run("trash", "rm", "book-1")
	if _, _, err := e.run("trash", "rm", "book-1", "--permanent", "-y"); err != nil || e.fake.Page("book-1") != nil {
		t.Errorf("forever from the trash: %v", err)
	}
	_, _, err = e.run("trash", "rm", "nothing", "--permanent", "-y")
	mustErr(t, err, "isn't in your trash")
	_, _, err = e.run("trash", "restore", "nothing")
	mustErr(t, err, "isn't in your trash")
	_, _, err = e.run("trash", "rm", "book-gone")
	mustErr(t, err, "markdrop trash ls")
	_, _, err = e.run("versions", "book-gone-too")
	if err == nil {
		t.Error("versions of a missing file")
	}
	e.fake.AddPage("a-page", fakeapi.Token, "A page", "x\n")
	e.fake.AddDoc("a-doc", fakeapi.Token, "markdown", []byte("x"), "text/markdown")
	_, _, err = e.run("versions", "a-doc")
	mustErr(t, err, "markdrop page versions a-doc")
	_, _, err = e.run("trash", "rm", "x", "--children", "keep")
	mustErr(t, err, "delete or lift")
}

func TestTrashPermanentAsksOnATerminal(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("doomed", fakeapi.Token, "Doomed", "d\n")
	old := stdinIsTTY
	stdinIsTTY = func(io.Reader) bool { return true }
	t.Cleanup(func() { stdinIsTTY = old })
	_, stderr, err := e.runIn("n\n", "trash", "rm", "doomed", "--permanent")
	mustErr(t, err, "cancelled")
	if !strings.Contains(stderr, "Delete doomed forever?") || e.fake.Page("doomed") == nil || e.fake.Page("doomed").Trashed {
		t.Errorf("stderr %q", stderr)
	}
	if _, _, err := e.runIn("y\n", "trash", "rm", "doomed", "--permanent"); err != nil || e.fake.Page("doomed") != nil {
		t.Errorf("yes: %v", err)
	}
}

func TestAccessRequests(t *testing.T) {
	e := setup(t)
	e.fake.AddPage("handbook", fakeapi.Token, "Handbook", "h\n")
	e.fake.AddPage("private", fakeapi.Token, "Private", "p\n")
	e.fake.SetAccess("private", "private")

	stdout, stderr, err := e.run("access", "request", "handbook", "--message", "typo fixes", "--token", fakeapi.OtherToken)
	if err != nil {
		t.Fatal(err, stderr)
	}
	id := strings.TrimSpace(stdout)
	if len(id) != 24 || !strings.Contains(stderr, "Asked to edit handbook (pending)") {
		t.Errorf("request %q %q", stdout, stderr)
	}
	_, _, err = e.run("access", "request", "handbook", "--token", fakeapi.OtherToken)
	mustErr(t, err, "already asked")
	_, _, err = e.run("access", "request", "handbook")
	mustErr(t, err, "already edit")
	stdout, _, err = e.run("access", "request", "private", "--view", "--token", fakeapi.OtherToken, "--json")
	if err != nil {
		t.Fatal(err)
	}
	viewID := oneJSONObject(t, stdout)["id"].(string)

	stdout, _, _ = e.run("access", "requests")
	if !strings.Contains(stdout, id) || !strings.Contains(stdout, "edit") || !strings.Contains(stdout, `"typo fixes"`) ||
		!strings.Contains(stdout, "someoneelse <someoneelse@example.com>") {
		t.Errorf("requests:\n%s", stdout)
	}
	stdout, _, _ = e.run("access", "requests", "--json")
	if obj := oneJSONObject(t, stdout); obj["pending_count"] != 2.0 {
		t.Errorf("--json %v", obj)
	}
	// Not theirs to decide.
	_, _, err = e.run("access", "approve", id, "--token", fakeapi.OtherToken)
	mustErr(t, err, "not found")

	stdout, stderr, err = e.run("access", "approve", id)
	if err != nil || stdout != "approved\n" || !strings.Contains(stderr, "they can edit it") {
		t.Fatalf("approve %q %q %v", stdout, stderr, err)
	}
	if !e.fake.Page("handbook").Editors[fakeapi.OtherToken] {
		t.Error("not granted")
	}
	// Now they can edit it.
	if _, _, err := e.run("page", "append", "handbook", "fixed", "--token", fakeapi.OtherToken); err != nil {
		t.Error(err)
	}
	_, _, err = e.run("access", "decline", id)
	mustErr(t, err, "already approved")
	stdout, _, err = e.run("access", "decline", viewID, "--json")
	if err != nil {
		t.Fatal(err)
	}
	if obj := oneJSONObject(t, stdout); obj["status"] != "declined" || obj["role_granted"] != nil {
		t.Errorf("decline %v", obj)
	}
	stdout, _, _ = e.run("access", "requests", "--status", "all")
	if strings.Count(stdout, "\n") != 4 || !strings.Contains(stdout, "declined") {
		t.Errorf("all:\n%s", stdout)
	}
	_, _, err = e.run("access", "requests", "--status", "open")
	mustErr(t, err, "--status must be")
	_, _, err = e.run("access", "approve", id, "--role", "owner")
	mustErr(t, err, "--role must be")
}

func TestSearch(t *testing.T) {
	e := setup(t)
	e.fake.AddAcme()
	e.fake.AddPage("roadmap", fakeapi.Token, "Roadmap 2026", "r\n")
	e.fake.AddPage("plans", fakeapi.Token, "Plans", "The kangaroo budget is in the second half.\n")
	e.fake.AddDoc("roadmap-video", fakeapi.Token, "artifact", []byte("v"), "video/mp4")
	if _, _, err := e.run("page", "new", "Guides roadmap", "--workspace", "Acme", "--slug", "acme-roadmap"); err != nil {
		t.Fatal(err)
	}
	stdout, _, err := e.run("search", "roadmap")
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"page  ", "Roadmap 2026", "file", "roadmap-video", "Acme", "https://docs.acme.test/acme-roadmap", "MATCHED"} {
		if !strings.Contains(stdout, w) {
			t.Errorf("search lacks %q:\n%s", w, stdout)
		}
	}
	// Inside the text: the matched text is shown.
	stdout, _, _ = e.run("search", "kangaroo")
	if !strings.Contains(stdout, "Plans") || !strings.Contains(stdout, "The kangaroo budget") {
		t.Errorf("body match:\n%s", stdout)
	}
	stdout, _, _ = e.run("search", "kangaroo", "--json")
	obj := oneJSONObject(t, stdout)
	rs, _ := obj["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["match"] != "body" || !strings.Contains(rs[0].(map[string]any)["snippet"].(string), "kangaroo") {
		t.Errorf("body match json %v", obj)
	}
	stdout, _, _ = e.run("search", "road", "--kind", "file", "--json")
	obj = oneJSONObject(t, stdout)
	rs, _ = obj["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["slug"] != "roadmap-video" || obj["backend"] != "search" || obj["query"] != "road" {
		t.Errorf("--kind file %v", obj)
	}
	stdout, _, _ = e.run("search", "roadmap", "--kind", "document", "--json")
	if rs, _ = oneJSONObject(t, stdout)["results"].([]any); len(rs) != 0 {
		t.Errorf("--kind document %v", rs)
	}
	stdout, _, _ = e.run("search", "roadmap", "--workspace", "Acme", "--json")
	rs, _ = oneJSONObject(t, stdout)["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["slug"] != "acme-roadmap" {
		t.Errorf("--workspace %v", rs)
	}
	stdout, _, _ = e.run("search", "setup", "--json")
	rs, _ = oneJSONObject(t, stdout)["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["kind"] != "folder" || rs[0].(map[string]any)["path"] != "Guides/Setup" ||
		rs[0].(map[string]any)["url"] != e.fake.WebBase+"/w/ws_acme/f/f_setup" {
		t.Errorf("folders %v", rs)
	}
	stdout, _, _ = e.run("search", "acm", "--kind", "workspace", "--json")
	rs, _ = oneJSONObject(t, stdout)["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["id"] != "ws_acme" {
		t.Errorf("workspaces %v", rs)
	}
	_, stderr, err := e.run("search", "zzzz")
	if err != nil || !strings.Contains(stderr, "Nothing found") {
		t.Errorf("nothing %q %v", stderr, err)
	}
	_, _, err = e.run("search", "x")
	mustErr(t, err, "at least 2")
	_, _, err = e.run("search", "xy", "--kind", "folders")
	mustErr(t, err, "kind must be")
	_, _, err = e.run("search", "xy", "--limit", "51", "--json")
	if err != nil {
		t.Errorf("--limit is capped, not refused: %v", err)
	}
}

// A server from before GET /api/v1/search: the search falls back to /search/quick.
func TestSearchFallsBackToQuick(t *testing.T) {
	e := setup(t)
	e.fake.NoSearchV1 = true
	e.fake.AddAcme()
	e.fake.AddPage("roadmap", fakeapi.Token, "Roadmap 2026", "r\n")
	e.fake.AddPage("plans", fakeapi.Token, "Plans", "The kangaroo budget.\n")
	stdout, _, err := e.run("search", "roadmap", "--json")
	if err != nil {
		t.Fatal(err)
	}
	obj := oneJSONObject(t, stdout)
	rs, _ := obj["results"].([]any)
	if obj["backend"] != "quick" || len(rs) != 1 || rs[0].(map[string]any)["slug"] != "roadmap" {
		t.Errorf("fallback %v", obj)
	}
	stdout, _, _ = e.run("search", "setup", "--json")
	rs, _ = oneJSONObject(t, stdout)["results"].([]any)
	if len(rs) != 1 || rs[0].(map[string]any)["path"] != "guides/setup" {
		t.Errorf("fallback folders %v", rs)
	}
	// The quick search never looks inside the text.
	_, stderr, _ := e.run("search", "kangaroo")
	if !strings.Contains(stderr, "Nothing found") {
		t.Errorf("fallback body %q", stderr)
	}
}

func TestNewCommandsNeedAToken(t *testing.T) {
	e := setup(t)
	t.Setenv("MARKDROP_TOKEN", "")
	for _, args := range [][]string{{"page", "get", "x"}, {"search", "xx"}, {"trash", "ls"}, {"access", "requests"},
		{"export", "x", "-o", "-"}, {"link", "set", "x", "abc"}} {
		_, _, err := e.run(args...)
		mustErr(t, err, "no Markdrop API token")
	}
}
