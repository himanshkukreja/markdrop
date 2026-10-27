package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/markdrop/cli/internal/files"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

// stderrIsTTY decides whether progress is drawn. Tests replace it.
var stderrIsTTY = func(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && (isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd()))
}

// newUploader is the engine the file commands use. Tests replace it to
// shorten timings and to keep resumable state in a temp folder.
var newUploader = func(c *files.Client) *files.Uploader {
	return &files.Uploader{Client: c, StateDir: files.DefaultStateDir()}
}

func apiClient(token string) (*files.Client, error) {
	tok, _ := files.ResolveToken(token)
	if tok == "" {
		return nil, files.ErrNoToken
	}
	return &files.Client{Base: flagServer, Token: tok, UserAgent: "markdrop-cli/" + version}, nil
}

// fileFlags are shared by the file commands.
type fileFlags struct {
	token string
	json  bool
}

func (f *fileFlags) register(c *cobra.Command) {
	c.Flags().StringVar(&f.token, "token", "", "API token (default: $MARKDROP_TOKEN, then the one saved by markdrop login)")
	c.Flags().BoolVar(&f.json, "json", false, "print the API's JSON result (one object) on stdout and nothing else")
}

func newUploadCmd() *cobra.Command {
	var ff fileFlags
	var title, access, password, workspace, folder, slug string
	c := &cobra.Command{
		Use:   "upload <path>",
		Short: "Publish a file (video, PDF, HTML, …) and print its link",
		Long: `Upload a file from this computer and publish it on Markdrop. Prints the link.

  The file is hashed (sha256), sent in parts (4 at a time, retried on
  errors) and verified by the server before it goes live. If the upload is
  interrupted, run the same command again: it resumes where it stopped.

  --workspace files it in one of your workspaces (its id, name or custom
  domain) and --folder puts it in an existing folder there ("guides/setup").
  The printed link is then the workspace's custom domain when it has a live
  one; the markdrop.in link is shown too. See ` + "`markdrop workspaces`" + `.

  Needs an API token: MARKDROP_TOKEN, --token, or ` + "`markdrop login`" + `
  (create one at https://markdrop.in/settings/tokens).

Examples:
  markdrop upload demo.mp4
  markdrop upload demo.mp4 --slug q3-demo                 # markdrop.in/q3-demo
  markdrop upload report.pdf --title "Q3 report" --access private
  markdrop upload deck.html --access password --password hunter2
  markdrop upload spec.pdf --workspace Acme --folder guides/setup
  url=$(markdrop upload clip.mp4)        # stdout is just the link
  markdrop upload clip.mp4 --json        # {"url":…,"markdrop_url":…,"slug":…,…}`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			access = strings.ToLower(strings.TrimSpace(access))
			switch {
			case access == "" && password != "":
				access = "password"
			case access == "" && workspace != "":
				access = "workspace"
			}
			switch access {
			case "", "link", "private", "password", "workspace":
			default:
				return fmt.Errorf("--access must be link, private, password or workspace (got %q)", access)
			}
			if access == "password" && password == "" {
				return errors.New("--access password needs --password")
			}
			if access == "workspace" && workspace == "" {
				return errors.New("--access workspace needs --workspace")
			}
			if folder != "" && workspace == "" {
				return errors.New("--folder needs --workspace")
			}
			if slug != "" && !customSlugRE.MatchString(slug) {
				return fmt.Errorf("--slug must be 3-50 letters, digits, - or _ (got %q)", slug)
			}
			return runUpload(cmd, ff, files.UploadOptions{
				Path: args[0], Title: title, Access: access, Password: password, Workspace: workspace,
				Folder: strings.Trim(strings.TrimSpace(folder), "/"), Slug: slug,
			})
		},
	}
	ff.register(c)
	c.Flags().StringVar(&title, "title", "", "title shown on the page (default: the file name)")
	c.Flags().StringVar(&access, "access", "",
		"who can open it: link (default), private, password or workspace (the default with --workspace)")
	c.Flags().StringVar(&password, "password", "", "password for --access password (implies it)")
	c.Flags().StringVar(&workspace, "workspace", "", "file it in this workspace: its id, name or custom domain")
	c.Flags().StringVar(&folder, "folder", "", "an existing folder of --workspace: its path (guides/setup) or id")
	c.Flags().StringVar(&slug, "slug", "", "custom address: markdrop.in/<slug> (3-50 letters, digits, - or _)")
	return c
}

var customSlugRE = regexp.MustCompile(`^[A-Za-z0-9_-]{3,50}$`)

func newReplaceCmd() *cobra.Command {
	var ff fileFlags
	var title string
	c := &cobra.Command{
		Use:   "replace <slug-or-url> <path>",
		Short: "Replace a published file, keeping its link",
		Long: `Swap the file behind an existing Markdrop link for a new one.

  The link, access settings, title and view count stay the same; the
  previous file is kept as a version (see ` + "`markdrop versions`" + `, undo with
  ` + "`markdrop restore`" + `). Resumable like upload.

Examples:
  markdrop replace https://markdrop.in/demo-clip demo-v2.mp4
  markdrop replace demo-clip demo-v2.mp4 --title "Demo (v2)" --json`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			return runUpload(cmd, ff, files.UploadOptions{Path: args[1], TargetSlug: slug, Title: title})
		},
	}
	ff.register(c)
	c.Flags().StringVar(&title, "title", "", "also change the title (default: keep it)")
	return c
}

func runUpload(cmd *cobra.Command, ff fileFlags, opts files.UploadOptions) error {
	client, err := apiClient(ff.token)
	if err != nil {
		return err
	}
	out, errw := cmd.OutOrStdout(), cmd.ErrOrStderr()
	ctx, cancel := signal.NotifyContext(cmdContext(cmd), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if opts.Workspace != "" && opts.TargetSlug == "" {
		// The API takes ids; a name or a domain is looked up among the user's workspaces.
		ws, err := client.ResolveWorkspace(ctx, opts.Workspace)
		if err != nil {
			return err
		}
		opts.Workspace = ws.ID
	}

	bar := &progressLine{w: errw, tty: stderrIsTTY(errw)}
	opts.OnProgress = bar.update
	opts.OnNotice = bar.notice
	res, err := newUploader(client).Upload(ctx, opts)
	bar.clear()
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
			return errors.New("interrupted; run the same command again to resume the upload")
		}
		return err
	}
	if ff.json {
		return printJSON(out, res.Raw)
	}
	if opts.TargetSlug != "" {
		fmt.Fprintf(errw, "  ✓ Replaced %s — version %d, %s. The previous version is kept (markdrop versions %s).\n",
			res.Slug, res.Version, formatBytes(res.SizeBytes), res.Slug)
		fmt.Fprintf(out, "%s\nversion %d\n", res.URL, res.Version)
		return nil
	}
	fmt.Fprintf(errw, "  ✓ Published %s (%s)\n", res.Slug, formatBytes(res.SizeBytes))
	if res.MarkdropURL != "" && res.MarkdropURL != res.URL {
		fmt.Fprintf(errw, "    also at %s\n", res.MarkdropURL)
	}
	if res.WorkspaceError != nil && *res.WorkspaceError != "" {
		fmt.Fprintf(errw, "  ! %s\n", *res.WorkspaceError)
	}
	fmt.Fprintln(out, res.URL)
	return nil
}

func newWorkspacesCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "workspaces [workspace]",
		Short: "List your workspaces, or the folders of one",
		Long: `Without an argument, list the workspaces you belong to: id, name, your role and
the custom domains that serve now. With a workspace (id, name or domain), list
its folders — the paths ` + "`markdrop upload --folder`" + ` takes.

Examples:
  markdrop workspaces
  markdrop workspaces Acme`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx, w := cmdContext(cmd), cmd.OutOrStdout()
			if len(args) == 0 {
				all, err := client.Workspaces(ctx)
				if err != nil {
					return err
				}
				if ff.json {
					return printValue(w, map[string]any{"workspaces": all})
				}
				if len(all) == 0 {
					fmt.Fprintln(cmd.ErrOrStderr(), "  You aren't a member of any workspace.")
					return nil
				}
				tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
				fmt.Fprintln(tw, "ID\tNAME\tROLE\tDOMAINS")
				for _, ws := range all {
					fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", ws.ID, ws.Name, ws.Role, orDash(strings.Join(ws.LiveDomains(), ", ")))
				}
				return tw.Flush()
			}
			ws, err := client.ResolveWorkspace(ctx, args[0])
			if err != nil {
				return err
			}
			tree, err := client.Tree(ctx, ws.ID)
			if err != nil {
				return err
			}
			if ff.json {
				return printValue(w, tree)
			}
			if len(tree.Folders) == 0 {
				fmt.Fprintf(cmd.ErrOrStderr(), "  %s has no folders yet (%d item(s) at its root).\n", ws.Name, tree.UnfiledCount)
				return nil
			}
			tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "PATH\tNAME\tITEMS\tID")
			for _, f := range tree.Folders {
				fmt.Fprintf(tw, "%s\t%s\t%d\t%s\n", f.Path, f.Name, f.TotalCount, f.ID)
			}
			return tw.Flush()
		},
	}
	ff.register(c)
	return c
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// printValue writes v as one compact JSON line.
func printValue(w io.Writer, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return printJSON(w, raw)
}

func newVersionsCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "versions <slug-or-url>",
		Short: "List the versions of a published file",
		Long: `List the versions of a file you published, newest first. The current one is
marked with *. Markdrop keeps up to 5 versions of each file.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			vs, err := client.Versions(cmdContext(cmd), slug)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), vs.Raw)
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "  VERSION\tSIZE\tTYPE\tSHA256\tCREATED")
			for _, v := range vs.Versions {
				mark := " "
				if v.Current {
					mark = "*"
				}
				sha := "-"
				if v.SHA256 != nil && len(*v.SHA256) >= 12 {
					sha = (*v.SHA256)[:12]
				}
				fmt.Fprintf(tw, "%s %d\t%s\t%s\t%s\t%s\n", mark, v.Version, formatBytes(v.SizeBytes), v.ContentType, sha,
					shortTime(v.CreatedAt))
			}
			return tw.Flush()
		},
	}
	ff.register(c)
	return c
}

func newRestoreCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "restore <slug-or-url> <version>",
		Short: "Make an earlier version of a file current again",
		Long: `Bring back an earlier version of a published file behind the same link.
The restored file becomes a new version (nothing is deleted), so a restore can
itself be undone.

Example:
  markdrop restore demo-clip 2`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			n, err := files.ParseVersion(args[1])
			if err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			info, err := client.Restore(cmdContext(cmd), slug, n)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), info.Raw)
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Restored version %d of %s as version %d.\n", n, info.Slug, info.Version)
			fmt.Fprintf(cmd.OutOrStdout(), "%s\nversion %d\n", info.URL, info.Version)
			return nil
		},
	}
	ff.register(c)
	return c
}

func newInfoCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "info <slug-or-url>",
		Short: "Show a published file's details (size, version, sha256, media)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			info, err := client.FileInfo(cmdContext(cmd), slug)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), info.Raw)
			}
			w := cmd.OutOrStdout()
			fmt.Fprintln(w, info.URL)
			row := func(k, v string) {
				if v != "" {
					fmt.Fprintf(w, "  %-9s %s\n", k, v)
				}
			}
			row("slug", info.Slug)
			row("type", info.ContentType)
			row("size", formatBytes(info.SizeBytes))
			row("version", fmt.Sprint(info.Version))
			if info.SHA256 != nil {
				row("sha256", *info.SHA256)
			}
			row("updated", shortTime(info.UpdatedAt))
			row("created", shortTime(info.CreatedAt))
			row("media", mediaText(info.Media))
			if info.PosterURL != nil {
				row("poster", *info.PosterURL)
			}
			return nil
		},
	}
	ff.register(c)
	return c
}

func mediaText(m *files.Media) string {
	if m == nil {
		return ""
	}
	var parts []string
	if m.Width != nil && m.Height != nil {
		parts = append(parts, fmt.Sprintf("%d×%d", *m.Width, *m.Height))
	}
	if m.DurationS != nil {
		parts = append(parts, (time.Duration(*m.DurationS * float64(time.Second))).Round(100*time.Millisecond).String())
	}
	var codecs []string
	for _, c := range []*string{m.VideoCodec, m.AudioCodec} {
		if c != nil && *c != "" {
			codecs = append(codecs, *c)
		}
	}
	if len(codecs) > 0 {
		parts = append(parts, strings.Join(codecs, "/"))
	}
	return strings.Join(parts, " · ")
}

func shortTime(s string) string {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format("2006-01-02 15:04 UTC")
		}
	}
	return s
}

// printJSON writes the API's JSON as one compact line.
func printJSON(w io.Writer, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return fmt.Errorf("the server's answer isn't JSON: %w", err)
	}
	buf.WriteByte('\n')
	_, err := w.Write(buf.Bytes())
	return err
}

func cmdContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// progressLine draws one self-updating line on stderr when it is a terminal
// (nothing otherwise), and prints notices (resuming, retrying) either way.
type progressLine struct {
	w   io.Writer
	tty bool

	mu        sync.Mutex
	phase     files.Phase
	started   time.Time
	startDone int64
	drawn     bool
}

func (p *progressLine) update(pr files.Progress) {
	if !p.tty {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if pr.Phase != p.phase {
		p.phase, p.started, p.startDone = pr.Phase, time.Now(), pr.Done
	}
	var line string
	switch pr.Phase {
	case files.PhaseVerifying:
		line = fmt.Sprintf("  Verifying %s on the server…", pr.FileName)
	default:
		label := "Hashing  "
		if pr.Phase == files.PhaseUploading {
			label = "Uploading"
		}
		frac := 1.0
		if pr.Total > 0 {
			frac = float64(pr.Done) / float64(pr.Total)
		}
		const width = 24
		fill := min(int(frac*width), width)
		line = fmt.Sprintf("  %s [%s%s] %3.0f%%  %s / %s", label, strings.Repeat("█", fill),
			strings.Repeat("░", width-fill), frac*100, formatBytes(pr.Done), formatBytes(pr.Total))
		if el := time.Since(p.started).Seconds(); pr.Phase == files.PhaseUploading && el > 1 {
			line += fmt.Sprintf("  %s/s", formatBytes(int64(float64(pr.Done-p.startDone)/el)))
		}
	}
	fmt.Fprintf(p.w, "\r\033[K%s", line)
	p.drawn = true
}

func (p *progressLine) notice(msg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.clearLocked()
	fmt.Fprintf(p.w, "  %s\n", msg)
}

func (p *progressLine) clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.clearLocked()
}

func (p *progressLine) clearLocked() {
	if p.drawn {
		fmt.Fprint(p.w, "\r\033[K")
		p.drawn = false
	}
}
