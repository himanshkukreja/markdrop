package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/markdrop/cli/internal/files"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ── Inputs and outputs ──────────────────────────────────────────────────────

// UploadFileInput is upload_file's input.
type UploadFileInput struct {
	Path      string `json:"path" jsonschema:"The file to publish: absolute, ~/..., or relative to the app's working folder. One file (zip a folder first)."`
	Title     string `json:"title,omitempty" jsonschema:"Title shown on the page (default: the file name)"`
	Access    string `json:"access,omitempty" jsonschema:"Who can open the link: link (anyone with it, the default), private (only the owner), password, or workspace"`
	Password  string `json:"password,omitempty" jsonschema:"Password for access=password (implies it)"`
	Workspace string `json:"workspace,omitempty" jsonschema:"Workspace for access=workspace (implies it)"`
}

// ReplaceFileInput is replace_file's input.
type ReplaceFileInput struct {
	Document string `json:"document" jsonschema:"The published file to replace: its Markdrop link (https://markdrop.in/<slug>) or slug"`
	Path     string `json:"path" jsonschema:"The new file on this computer: absolute, ~/..., or relative to the app's working folder"`
	Title    string `json:"title,omitempty" jsonschema:"New title (default: keep the current one)"`
}

// DocumentInput names one published file.
type DocumentInput struct {
	Document string `json:"document" jsonschema:"A Markdrop link (https://markdrop.in/<slug>) or slug of a file you published"`
}

// RestoreVersionInput is restore_file_version's input.
type RestoreVersionInput struct {
	Document string `json:"document" jsonschema:"A Markdrop link (https://markdrop.in/<slug>) or slug of a file you published"`
	Version  int    `json:"version" jsonschema:"The version number to bring back (from list_file_versions)"`
}

// FileResult is upload_file's and replace_file's output.
type FileResult struct {
	URL       string `json:"url" jsonschema:"The link; for a replace it is the same link as before"`
	Slug      string `json:"slug"`
	Version   int    `json:"version" jsonschema:"Version number of the file now served (1 for a new upload)"`
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256" jsonschema:"sha256 of the file, verified by the server"`
}

// VersionsOutput is list_file_versions' output.
type VersionsOutput struct {
	Slug     string          `json:"slug"`
	Versions []files.Version `json:"versions" jsonschema:"Newest first; current marks the one the link serves"`
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const needsToken = "This tool needs a Markdrop API token: set MARKDROP_TOKEN in this MCP server's environment " +
	"(create one at " + files.TokensURL + "), or run `markdrop login` once on this computer, then restart the app."

func (m *Manager) fileClient() (*files.Client, error) {
	tok := strings.TrimSpace(m.cfg.FilesToken)
	if tok == "" {
		return nil, errors.New(needsToken)
	}
	return &files.Client{Base: m.cfg.Server, Token: tok, UserAgent: m.cfg.UserAgent}, nil
}

// checkUploadPath applies the secret-path guard and requires one file.
func (m *Manager) checkUploadPath(p string) (string, error) {
	abs, err := m.cfg.Guard.CheckSharePath(p)
	if err != nil {
		var r *refusal
		if errors.As(err, &r) {
			return "", errors.New(strings.Replace(err.Error(), "refused to share", "refused to upload", 1))
		}
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return "", fmt.Errorf("%s is a folder; upload_file and replace_file take one file (zip the folder first)", abs)
	}
	return abs, nil
}

// upload runs the engine for a tool call, with MCP progress notifications
// when the caller asked for them. The transfer has no deadline of its own: it
// runs until done or until the client cancels the request (a later call with
// the same arguments then resumes it).
func (m *Manager) upload(ctx context.Context, req *mcp.CallToolRequest, opts files.UploadOptions) (*files.Result, error) {
	client, err := m.fileClient()
	if err != nil {
		return nil, err
	}
	abs, err := m.checkUploadPath(opts.Path)
	if err != nil {
		return nil, err
	}
	opts.Path = abs
	opts.OnProgress = progressNotifier(ctx, req)
	opts.OnNotice = func(s string) { m.cfg.Log.Printf("upload %s: %s", abs, s) }
	m.cfg.Log.Printf("upload %s → %s", abs, orDefault(opts.TargetSlug, "new file"))
	res, err := m.cfg.NewUploader(client).Upload(ctx, opts)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("the upload was cancelled; call the tool again with the same arguments to resume it (%w)", err)
		}
		return nil, err
	}
	return res, nil
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// progressNotifier sends notifications/progress for the request's progress
// token (if any): progress and total are bytes, and progress only ever
// grows. Hashing announces itself once at 0; uploading reports bytes sent
// (held one byte short of the total), and verification reports the total.
func progressNotifier(ctx context.Context, req *mcp.CallToolRequest) func(files.Progress) {
	if req == nil || req.Params == nil || req.Session == nil {
		return nil
	}
	token := req.Params.GetProgressToken()
	if token == nil {
		return nil
	}
	var (
		mu       sync.Mutex
		last     = -1.0
		lastSent time.Time
		lastPh   files.Phase
	)
	return func(p files.Progress) {
		if p.Total <= 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		var value float64
		var msg string
		switch p.Phase {
		case files.PhaseHashing:
			if lastPh == files.PhaseHashing {
				return
			}
			value, msg = 0, fmt.Sprintf("Checking %s (%s)…", p.FileName, humanBytes(p.Total))
		case files.PhaseUploading:
			value = float64(min(p.Done, p.Total-1))
			msg = fmt.Sprintf("Uploading %s: %s of %s", p.FileName, humanBytes(p.Done), humanBytes(p.Total))
			if p.Phase == lastPh && time.Since(lastSent) < 500*time.Millisecond && p.Done < p.Total {
				return
			}
		case files.PhaseVerifying:
			value, msg = float64(p.Total), fmt.Sprintf("Verifying %s on the server…", p.FileName)
		}
		lastPh = p.Phase
		if value <= last {
			return
		}
		last, lastSent = value, time.Now()
		_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
			ProgressToken: token, Progress: value, Total: float64(p.Total), Message: msg,
		})
	}
}

func fileResult(r *files.Result) FileResult {
	return FileResult{URL: r.URL, Slug: r.Slug, Version: r.Version, SizeBytes: r.SizeBytes, SHA256: r.SHA256}
}

func infoText(fi *files.FileInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s — %s, %s, version %d", fi.URL, fi.ContentType, humanBytes(fi.SizeBytes), fi.Version)
	if fi.Media != nil {
		var parts []string
		if fi.Media.Width != nil && fi.Media.Height != nil {
			parts = append(parts, fmt.Sprintf("%d×%d", *fi.Media.Width, *fi.Media.Height))
		}
		if fi.Media.DurationS != nil {
			parts = append(parts, fmt.Sprintf("%.1f s", *fi.Media.DurationS))
		}
		if len(parts) > 0 {
			b.WriteString(", " + strings.Join(parts, ", "))
		}
	}
	if fi.UpdatedAt != "" {
		b.WriteString(". Updated " + fi.UpdatedAt)
	}
	b.WriteString(".")
	return b.String()
}

// ── Registration ────────────────────────────────────────────────────────────

func addFileTools(s *mcp.Server, m *Manager) {
	uploadSchema := mustSchema[UploadFileInput]()
	uploadSchema.Properties["path"].MinLength = jsonschema.Ptr(1)
	uploadSchema.Properties["access"].Enum = []any{"link", "private", "password", "workspace"}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "upload_file",
		Title: "Publish a file on Markdrop",
		Description: "Publishes a file from this computer (a video, PDF, HTML page, image, spreadsheet, …) on Markdrop and " +
			"returns its link (https://markdrop.in/<slug>). The file is read here and sent straight to storage in " +
			"parts, then verified by sha256 on the server; large videos (up to 2 GB) are fine. If the call is cut " +
			"short, calling it again with the same arguments resumes the upload. access defaults to link (anyone " +
			"with the link can open it). To change the file behind an existing link later, use replace_file. Needs " +
			"MARKDROP_TOKEN. Secret locations (~/.ssh, ~/.aws, .env files, private keys, …) are refused.",
		InputSchema: uploadSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Publish a file on Markdrop", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, req *mcp.CallToolRequest, in UploadFileInput) (*mcp.CallToolResult, FileResult, error) {
		access := strings.ToLower(strings.TrimSpace(in.Access))
		switch {
		case access == "" && in.Password != "":
			access = "password"
		case access == "" && in.Workspace != "":
			access = "workspace"
		}
		if access == "password" && in.Password == "" {
			return nil, FileResult{}, errors.New("access=password needs a password")
		}
		if access == "workspace" && in.Workspace == "" {
			return nil, FileResult{}, errors.New("access=workspace needs a workspace")
		}
		res, err := m.upload(ctx, req, files.UploadOptions{
			Path: in.Path, Title: in.Title, Access: access, Password: in.Password, Workspace: in.Workspace,
		})
		if err != nil {
			return nil, FileResult{}, err
		}
		return text(fmt.Sprintf("Published %s (%s): %s\nSlug %s, version %d. To swap the file behind this same "+
				"link later, use replace_file.", res.Slug, humanBytes(res.SizeBytes), res.URL, res.Slug, res.Version)),
			fileResult(res), nil
	})

	replaceSchema := mustSchema[ReplaceFileInput]()
	replaceSchema.Properties["document"].MinLength = jsonschema.Ptr(1)
	replaceSchema.Properties["path"].MinLength = jsonschema.Ptr(1)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "replace_file",
		Title: "Replace a published file (same link)",
		Description: "Replaces the file behind an existing Markdrop link with a file from this computer. The link, " +
			"access, title and views stay the same; the previous version is kept and can be restored with " +
			"restore_file_version (see list_file_versions). Use it to update a video, PDF or page you already " +
			"published (markdown documents are edited with update_document instead). Resumable like upload_file; " +
			"the new file is verified by sha256 before it goes live, and nothing changes if that fails. Needs " +
			"MARKDROP_TOKEN, and you must own the document.",
		InputSchema: replaceSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Replace a published file (same link)", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, req *mcp.CallToolRequest, in ReplaceFileInput) (*mcp.CallToolResult, FileResult, error) {
		slug, err := files.ParseSlug(in.Document)
		if err != nil {
			return nil, FileResult{}, err
		}
		res, err := m.upload(ctx, req, files.UploadOptions{Path: in.Path, TargetSlug: slug, Title: in.Title})
		if err != nil {
			return nil, FileResult{}, err
		}
		return text(fmt.Sprintf("Replaced the file behind %s: now version %d (%s). The link, access, title and views "+
			"are unchanged; the previous version is kept (list_file_versions, restore_file_version).",
			res.URL, res.Version, humanBytes(res.SizeBytes))), fileResult(res), nil
	})

	docSchema := func() *jsonschema.Schema {
		s := mustSchema[DocumentInput]()
		s.Properties["document"].MinLength = jsonschema.Ptr(1)
		return s
	}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_file_versions",
		Title: "List a file's versions",
		Description: "Lists the versions of a file you published on Markdrop, newest first: version number, size, " +
			"sha256, type, when it was uploaded, and which one the link serves now (current). Up to 5 are kept.",
		InputSchema: docSchema(),
		Annotations: &mcp.ToolAnnotations{
			Title: "List a file's versions", ReadOnlyHint: true, DestructiveHint: boolPtr(false),
			IdempotentHint: true, OpenWorldHint: boolPtr(false),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in DocumentInput) (*mcp.CallToolResult, VersionsOutput, error) {
		slug, client, err := m.docClient(in.Document)
		if err != nil {
			return nil, VersionsOutput{}, err
		}
		vs, err := client.Versions(ctx, slug)
		if err != nil {
			return nil, VersionsOutput{}, err
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%d version(s) of %s:", len(vs.Versions), slug)
		for _, v := range vs.Versions {
			cur := ""
			if v.Current {
				cur = " (current)"
			}
			fmt.Fprintf(&b, "\n- version %d%s: %s, %s, %s", v.Version, cur, v.ContentType, humanBytes(v.SizeBytes), v.CreatedAt)
		}
		return text(b.String()), VersionsOutput{Slug: slug, Versions: vs.Versions}, nil
	})

	restoreSchema := mustSchema[RestoreVersionInput]()
	restoreSchema.Properties["document"].MinLength = jsonschema.Ptr(1)
	restoreSchema.Properties["version"].Minimum = jsonschema.Ptr(1.0)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "restore_file_version",
		Title: "Restore an earlier version of a file",
		Description: "Makes an earlier version of a published file current again, behind the same link. The restored " +
			"file becomes a new version (nothing is deleted), so it can be undone the same way. Get version numbers " +
			"from list_file_versions.",
		InputSchema: restoreSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Restore an earlier version of a file", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in RestoreVersionInput) (*mcp.CallToolResult, files.FileInfo, error) {
		slug, client, err := m.docClient(in.Document)
		if err != nil {
			return nil, files.FileInfo{}, err
		}
		fi, err := client.Restore(ctx, slug, in.Version)
		if err != nil {
			return nil, files.FileInfo{}, err
		}
		return text(fmt.Sprintf("Version %d of %s is current again, as version %d: %s",
			in.Version, slug, fi.Version, fi.URL)), *fi, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_file_info",
		Title: "Details of a published file",
		Description: "Returns a published file's link, type, size, sha256, current version, dates and, for audio and " +
			"video, media details (duration, width, height, codecs) and a poster image URL when known.",
		InputSchema: docSchema(),
		Annotations: &mcp.ToolAnnotations{
			Title: "Details of a published file", ReadOnlyHint: true, DestructiveHint: boolPtr(false),
			IdempotentHint: true, OpenWorldHint: boolPtr(false),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in DocumentInput) (*mcp.CallToolResult, files.FileInfo, error) {
		slug, client, err := m.docClient(in.Document)
		if err != nil {
			return nil, files.FileInfo{}, err
		}
		fi, err := client.FileInfo(ctx, slug)
		if err != nil {
			return nil, files.FileInfo{}, err
		}
		return text(infoText(fi)), *fi, nil
	})
}

func (m *Manager) docClient(document string) (string, *files.Client, error) {
	slug, err := files.ParseSlug(document)
	if err != nil {
		return "", nil, err
	}
	client, err := m.fileClient()
	if err != nil {
		return "", nil, err
	}
	return slug, client, nil
}
