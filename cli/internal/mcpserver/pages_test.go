package mcpserver

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/markdrop/cli/internal/files/fakeapi"
)

var testPNG = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 40)...)

func TestUploadPageImageTool(t *testing.T) {
	e := newFilesEnv(t, fakeapi.Token)
	e.fake.AddPage("launch", fakeapi.Token, "Launch", "# Launch\n")
	cs, _ := connectWithProgress(t, e.mgr)
	img := filepath.Join(e.home, "Pictures", "hero shot.png")
	_ = os.MkdirAll(filepath.Dir(img), 0o755)
	_ = os.WriteFile(img, testPNG, 0o644)
	ctx := context.Background()

	res, out, err := callWithProgress(t, ctx, cs, "upload_page_image",
		map[string]any{"document": "https://markdrop.in/launch", "path": "~/Pictures/hero shot.png"}, nil)
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, resultText(res))
	}
	asset, _ := out["asset"].(string)
	if !strings.HasPrefix(asset, "asset:") || out["markdown"] != "![hero shot]("+asset+")" || out["mime"] != "image/png" ||
		out["slug"] != "launch" || out["appended"] != false {
		t.Errorf("out %v", out)
	}
	if !strings.Contains(resultText(res), "Put this in the page") || e.fake.Page("launch").Content != "# Launch\n" {
		t.Errorf("text %q", resultText(res))
	}

	res, out, err = callWithProgress(t, ctx, cs, "upload_page_image",
		map[string]any{"document": "launch", "path": img, "set_as": "cover", "append": true, "alt": "Hero"}, nil)
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, resultText(res))
	}
	asset, _ = out["asset"].(string)
	got := e.fake.Page("launch").Content
	if !strings.HasPrefix(got, "---\ncover: "+asset+"\n---\n# Launch\n\n![Hero]("+asset+")") || out["rev"] != 3.0 ||
		out["appended"] != true || out["set_as"] != "cover" {
		t.Errorf("content %q out %v", got, out)
	}

	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"document": "launch", "path": "~/.ssh/id_ed25519"}, "refused to upload"},
		{map[string]any{"document": "launch", "path": "~/work/clean"}, "is a folder"},
		{map[string]any{"document": "launch", "path": "~/Documents/report.pdf"}, "isn't a PNG"},
		{map[string]any{"document": "nope", "path": img}, "not found"},
		{map[string]any{"document": "launch", "path": img, "set_as": "banner"}, "set_as"},
	} {
		res, _, err := callWithProgress(t, ctx, cs, "upload_page_image", c.args, nil)
		msg := ""
		if err != nil {
			msg = err.Error()
		} else {
			msg = resultText(res)
		}
		if !strings.Contains(msg, c.want) {
			t.Errorf("%v: %q, want %q", c.args, msg, c.want)
		}
	}
}

func TestExportPageTool(t *testing.T) {
	e := newFilesEnv(t, fakeapi.Token)
	e.fake.AddPage("guide", fakeapi.Token, "Guide", "Body\n")
	e.fake.AddPage("guide-1", fakeapi.Token, "Part 1", "One\n")
	e.fake.SetParent("guide-1", "guide")
	cs, _ := connectWithProgress(t, e.mgr)
	ctx := context.Background()

	res, out, err := callWithProgress(t, ctx, cs, "export_page", map[string]any{"document": "guide"}, nil)
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, resultText(res))
	}
	want := filepath.Join(e.mgr.cfg.Downloads, "guide.md")
	if out["path"] != want || out["format"] != "md" || out["filename"] != "guide.md" {
		t.Errorf("out %v", out)
	}
	if b, _ := os.ReadFile(want); string(b) != "# Guide\n\nBody\n" {
		t.Errorf("file %q", b)
	}
	res, _, _ = callWithProgress(t, ctx, cs, "export_page", map[string]any{"document": "guide"}, nil)
	if !res.IsError || !strings.Contains(resultText(res), "pass overwrite: true") {
		t.Errorf("second export: %s", resultText(res))
	}
	res, _, _ = callWithProgress(t, ctx, cs, "export_page", map[string]any{"document": "guide", "overwrite": true}, nil)
	if res.IsError {
		t.Error(resultText(res))
	}

	zipPath := filepath.Join(e.home, "Backups", "guide-all.zip")
	res, out, _ = callWithProgress(t, ctx, cs, "export_page",
		map[string]any{"document": "guide", "include_subpages": true, "path": "~/Backups/guide-all.zip"}, nil)
	if res.IsError || out["path"] != zipPath || out["subpages"] != true {
		t.Fatalf("zip: %s %v", resultText(res), out)
	}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 2 {
		t.Errorf("zip has %d files", len(zr.File))
	}
	zr.Close()

	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"document": "guide", "path": "~/.ssh/guide.md"}, "refused to save into"},
		{map[string]any{"document": "guide", "path": "~/.zshrc"}, "hidden settings file"},
		{map[string]any{"document": "guide", "format": "pdf"}, "format"},
		{map[string]any{"document": "nope"}, "not found"},
	} {
		res, _, err := callWithProgress(t, ctx, cs, "export_page", c.args, nil)
		msg := ""
		if err != nil {
			msg = err.Error()
		} else {
			msg = resultText(res)
		}
		if !strings.Contains(msg, c.want) {
			t.Errorf("%v: %q, want %q", c.args, msg, c.want)
		}
	}
	if _, err := os.Stat(filepath.Join(e.home, ".zshrc")); err == nil {
		t.Error("wrote a dotfile")
	}
}

func TestPageToolsNeedAToken(t *testing.T) {
	e := newFilesEnv(t, "")
	cs, _ := connectWithProgress(t, e.mgr)
	for _, name := range []string{"upload_page_image", "export_page"} {
		res, _, err := callWithProgress(t, context.Background(), cs, name, map[string]any{"document": "x", "path": "y"}, nil)
		if err != nil || !res.IsError || !strings.Contains(resultText(res), "MARKDROP_TOKEN") {
			t.Errorf("%s without a token: %v %s", name, err, resultText(res))
		}
	}
}
