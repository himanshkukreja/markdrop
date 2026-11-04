package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/markdrop/cli/internal/files"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Page tools that need this computer's disk: an image file into a page, and a
// page's export into a file. Everything else about pages is the remote
// server's (create_page, update_page, …).

// UploadPageImageInput is upload_page_image's input.
type UploadPageImageInput struct {
	Document string `json:"document" jsonschema:"The page: its Markdrop link or slug"`
	Path     string `json:"path" jsonschema:"The image on this computer (PNG, JPEG, GIF or WebP, up to 10 MB): absolute, ~/..., or relative to the app's working folder"`
	Alt      string `json:"alt,omitempty" jsonschema:"Alt text (default: the file name)"`
	SetAs    string `json:"set_as,omitempty" jsonschema:"cover or icon: also make the image the page's cover or icon"`
	Append   bool   `json:"append,omitempty" jsonschema:"Also add the image at the end of the page"`
}

// UploadPageImageOutput is upload_page_image's output.
type UploadPageImageOutput struct {
	Asset    string `json:"asset" jsonschema:"asset:<id>: what a page's icon or cover takes"`
	Markdown string `json:"markdown" jsonschema:"![alt](asset:<id>): put it in the page where the image belongs"`
	ID       string `json:"id"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
	Slug     string `json:"slug"`
	URL      string `json:"url" jsonschema:"The page's link"`
	SetAs    string `json:"set_as,omitempty"`
	Appended bool   `json:"appended"`
	Rev      int    `json:"rev,omitempty" jsonschema:"The page's revision after set_as or append"`
}

// ExportPageInput is export_page's input.
type ExportPageInput struct {
	Document        string `json:"document" jsonschema:"The page or document: its Markdrop link or slug"`
	Format          string `json:"format,omitempty" jsonschema:"md (portable Markdown, the default), html (one self-contained file, images inlined) or zip (the Markdown with its images)"`
	IncludeSubpages bool   `json:"include_subpages,omitempty" jsonschema:"Also export every sub-page the user can open (always a zip)"`
	Path            string `json:"path,omitempty" jsonschema:"A file to save to, or a folder to save into under the export's own name (default ~/Downloads/Markdrop)"`
	Overwrite       bool   `json:"overwrite,omitempty" jsonschema:"Replace an existing file (default: refuse)"`
}

func (m *Manager) checkImagePath(p string) (string, error) {
	abs, err := m.cfg.Guard.CheckSharePath(p)
	if err != nil {
		var r *refusal
		if errors.As(err, &r) {
			return "", errors.New(strings.Replace(err.Error(), "refused to share", "refused to upload", 1))
		}
		return "", err
	}
	if fi, err := os.Stat(abs); err != nil {
		return "", err
	} else if fi.IsDir() {
		return "", fmt.Errorf("%s is a folder; give one image file", abs)
	}
	return abs, nil
}

// exportTarget turns export_page's path into what ExportToFile takes,
// refusing secret and autostart locations and dotfiles.
func (m *Manager) exportTarget(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		p = m.cfg.Downloads
		if p == "" {
			p = "~/Downloads/Markdrop"
		}
		p += string(os.PathSeparator)
	}
	abs, err := m.cfg.Guard.Expand(p)
	if err != nil {
		return "", err
	}
	isDir := strings.HasSuffix(p, "/") || strings.HasSuffix(p, string(os.PathSeparator))
	if fi, err := os.Stat(abs); err == nil && fi.IsDir() {
		isDir = true
	}
	dir := abs
	if !isDir {
		dir = filepath.Dir(abs)
		if name := filepath.Base(abs); strings.HasPrefix(name, ".") && !m.cfg.Guard.AllowAny {
			return "", fmt.Errorf("refused to save as %s: a name starting with a dot is a hidden settings file. "+
				"Choose a plain file name, or a folder", name)
		}
	}
	if _, err := m.cfg.Guard.CheckReceiveDir(dir); err != nil {
		return "", err
	}
	if isDir {
		return abs + string(os.PathSeparator), nil
	}
	return abs, nil
}

func addPageTools(s *mcp.Server, m *Manager) {
	imgSchema := mustSchema[UploadPageImageInput]()
	imgSchema.Properties["document"].MinLength = jsonschema.Ptr(1)
	imgSchema.Properties["path"].MinLength = jsonschema.Ptr(1)
	imgSchema.Properties["set_as"].Enum = []any{"cover", "icon"}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "upload_page_image",
		Title: "Add an image file to a page",
		Description: "Uploads an image file from this computer (PNG, JPEG, GIF or WebP, up to 10 MB) to a Markdrop page " +
			"the user can edit, and returns the Markdown that shows it (![alt](asset:<id>)) to put in the page where it " +
			"belongs (with the remote server's update_page, replace_section or append_blocks). set_as cover or icon also " +
			"makes it the page's cover or icon; append also adds it at the end of the page. Use this (not the remote " +
			"server's base64 upload) for an image on this computer. Needs MARKDROP_TOKEN. Secret locations are refused.",
		InputSchema: imgSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Add an image file to a page", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in UploadPageImageInput) (*mcp.CallToolResult, UploadPageImageOutput, error) {
		slug, client, err := m.docClient(in.Document)
		if err != nil {
			return nil, UploadPageImageOutput{}, err
		}
		setAs := strings.ToLower(strings.TrimSpace(in.SetAs))
		if setAs != "" && setAs != "cover" && setAs != "icon" {
			return nil, UploadPageImageOutput{}, fmt.Errorf("set_as is cover or icon (got %q)", in.SetAs)
		}
		abs, err := m.checkImagePath(in.Path)
		if err != nil {
			return nil, UploadPageImageOutput{}, err
		}
		page, err := client.GetPage(ctx, slug)
		if err != nil {
			return nil, UploadPageImageOutput{}, err
		}
		img, err := client.UploadPageImage(ctx, page.Slug, abs, in.Alt)
		if err != nil {
			return nil, UploadPageImageOutput{}, err
		}
		m.cfg.Log.Printf("page image %s → %s (%s)", abs, page.Slug, img.Asset)
		out := UploadPageImageOutput{Asset: img.Asset, Markdown: img.Markdown, ID: img.ID, Mime: img.Mime,
			Size: img.Size, Width: img.Width, Height: img.Height, Slug: page.Slug, URL: page.CanonicalURL(), SetAs: setAs}
		msg := fmt.Sprintf("Uploaded %s to %s (%s, %s).", filepath.Base(abs), page.Slug, img.Mime, humanBytes(img.Size))
		if setAs != "" {
			after, err := client.SetPageProps(ctx, page.Slug, map[string]any{setAs: img.Asset})
			if err != nil {
				return nil, UploadPageImageOutput{}, fmt.Errorf("the image is on the page (%s) but making it the %s "+
					"failed: %w", img.Asset, setAs, err)
			}
			out.Rev = after.Rev
			msg += fmt.Sprintf(" It is the page's %s now.", setAs)
		}
		if in.Append {
			after, err := client.AppendToPage(ctx, page.Slug, img.Markdown)
			if err != nil {
				return nil, UploadPageImageOutput{}, fmt.Errorf("the image is on the page but adding it at the end "+
					"failed (put %s in the page yourself): %w", img.Markdown, err)
			}
			out.Rev, out.Appended = after.Rev, true
			msg += " Added at the end of the page."
		} else if setAs == "" {
			msg += " Put this in the page where it belongs: " + img.Markdown
		}
		return text(msg + " " + out.URL), out, nil
	})

	expSchema := mustSchema[ExportPageInput]()
	expSchema.Properties["document"].MinLength = jsonschema.Ptr(1)
	expSchema.Properties["format"].Enum = []any{"md", "html", "zip"}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "export_page",
		Title: "Export a page to a file",
		Description: "Saves a Markdrop page (or Markdown document) the user can open as a file on this computer: md " +
			"(portable Markdown, the default), html (one self-contained file, images inlined) or zip (the Markdown " +
			"with its images); include_subpages adds every sub-page (a zip). path is a file or a folder (default " +
			"~/Downloads/Markdrop, under the export's own name). An existing file is not replaced unless overwrite. " +
			"Returns where it was saved. Needs MARKDROP_TOKEN.",
		InputSchema: expSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Export a page to a file", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: true, OpenWorldHint: boolPtr(false),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ExportPageInput) (*mcp.CallToolResult, files.ExportResult, error) {
		slug, client, err := m.docClient(in.Document)
		if err != nil {
			return nil, files.ExportResult{}, err
		}
		format := strings.ToLower(strings.TrimSpace(in.Format))
		switch format {
		case "", "md", "markdown":
			format = "md"
		case "html", "zip":
		default:
			return nil, files.ExportResult{}, fmt.Errorf("format is md, html or zip (got %q)", in.Format)
		}
		dest, err := m.exportTarget(in.Path)
		if err != nil {
			return nil, files.ExportResult{}, err
		}
		res, err := client.ExportToFile(ctx, slug, format, in.IncludeSubpages, dest, in.Overwrite)
		if err != nil {
			return nil, files.ExportResult{}, errors.New(strings.Replace(err.Error(), "use --force", "pass overwrite: true", 1))
		}
		m.cfg.Log.Printf("export %s → %s", slug, res.Path)
		msg := fmt.Sprintf("Saved %s as %s (%s).", slug, res.Path, humanBytes(res.Bytes))
		if res.Notes > 0 {
			msg += fmt.Sprintf(" %d note(s) inside about what couldn't be exported as it is.", res.Notes)
		}
		return text(msg), *res, nil
	})
}
