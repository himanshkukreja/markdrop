package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/markdrop/cli/internal/files"
	"github.com/spf13/cobra"
)

// `markdrop page …`: pages (documents in the block editor) through the
// documents API. Every command reads the page by its slug or link.

// pageOut is what --json prints for a page after a write (the hosted MCP
// tools' shape).
type pageOut struct {
	URL            string  `json:"url"`
	MarkdropURL    string  `json:"markdrop_url"`
	WorkspaceURL   *string `json:"workspace_url"`
	Slug           string  `json:"slug"`
	Title          *string `json:"title"`
	Rev            int     `json:"rev"`
	WorkspaceError *string `json:"workspace_error,omitempty"`
}

func pageResult(d *files.Document) pageOut {
	return pageOut{URL: d.CanonicalURL(), MarkdropURL: d.URL, WorkspaceURL: d.WorkspaceURL, Slug: d.Slug,
		Title: d.Title, Rev: max(d.Rev, 1)}
}

// readContent reads --from-file: a path, or "-" for stdin.
func readContent(cmd *cobra.Command, from string) (string, error) {
	var data []byte
	var err error
	if from == "-" {
		data, err = io.ReadAll(io.LimitReader(cmd.InOrStdin(), 8<<20))
	} else {
		data, err = os.ReadFile(from)
	}
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", from, err)
	}
	return strings.ReplaceAll(string(data), "\r\n", "\n"), nil
}

func newPageCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "page",
		Short: "Create, read and edit pages (new, get, update, append, props, image, versions, …)",
		Long: `Work with Markdrop pages from the terminal. A page is written in Markdown; its
icon, cover and other settings live in front matter at the top.

  A page is named by its slug or any of its links (markdrop.in/<slug>, or its
  address on a workspace's domain). Needs an API token, like upload.

Examples:
  markdrop page new "Release notes" --workspace Acme --folder guides --from-file notes.md
  markdrop page get release-notes > notes.md
  markdrop page update release-notes --from-file notes.md
  markdrop page append release-notes "- Fixed the export button"
  markdrop page props release-notes --icon 🚀 --cover gallery:dusk
  markdrop page image add release-notes diagram.png --append
  markdrop page versions release-notes`,
	}
	c.AddCommand(newPageNewCmd(), newPageGetCmd(), newPageUpdateCmd(), newPageAppendCmd(), newPagePropsCmd(),
		newPageTemplatesCmd(), newPageImageCmd(), newPageVersionsCmd(), newPageVersionCmd(), newPageRestoreCmd())
	return c
}

func newPageNewCmd() *cobra.Command {
	var ff fileFlags
	var workspace, folder, parent, template, slug, from, icon, cover string
	var noAutoCover bool
	c := &cobra.Command{
		Use:   "new <title>",
		Short: "Create a page and print its link",
		Long: `Create a page. It starts blank, from a template (--template, see
` + "`markdrop page templates`" + `) or with your Markdown (--from-file, - for stdin).

  --workspace files it in one of your workspaces (id, name or domain) and
  --folder in a folder there (its path, e.g. guides/setup, or id). --parent
  puts it inside another page instead (it then lives in that page's
  workspace and folder and gets its access). --slug picks its address.

  Unless you give it a cover, a cover is picked for it (--no-auto-cover: none).

Examples:
  markdrop page new "Meeting notes" --template meeting-notes
  markdrop page new "Setup" --workspace Acme --folder guides --slug setup-guide
  markdrop page new "Step 2" --parent setup-guide --from-file step2.md
  cat draft.md | markdrop page new "Draft" --from-file - --icon 📝
  url=$(markdrop page new "Q3 plan")     # stdout is just the link`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			title := strings.TrimSpace(args[0])
			if title == "" {
				return errors.New("give the page a title")
			}
			if parent != "" && (workspace != "" || folder != "") {
				return errors.New("a page inside another page lives in that page's workspace and folder: use --parent alone")
			}
			if folder != "" && workspace == "" {
				return errors.New("--folder needs --workspace")
			}
			if template != "" && from != "" {
				return errors.New("use --template or --from-file, not both")
			}
			if slug != "" && !customSlugRE.MatchString(slug) {
				return fmt.Errorf("--slug must be 3-50 letters, digits, - or _ (got %q)", slug)
			}
			props := map[string]any{}
			if icon != "" {
				props["icon"] = icon
			}
			if cover != "" {
				props["cover"] = cover
			}
			for k, v := range props {
				if s, _ := v.(string); strings.HasPrefix(s, "asset:") {
					return fmt.Errorf("a new page has no images yet: create it, then `markdrop page image add <page> <file> --%s`", k)
				}
			}
			if _, err := files.ValidatePageProps(props); err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			req := files.PageCreate{Title: title, Template: template, Slug: slug,
				Folder: strings.Trim(strings.TrimSpace(folder), "/")}
			if parent != "" {
				if req.Parent, err = files.ParseSlug(parent); err != nil {
					return err
				}
			}
			if workspace != "" {
				ws, err := client.ResolveWorkspace(ctx, workspace)
				if err != nil {
					return err
				}
				req.Workspace = ws.ID
			}
			if from != "" {
				if req.Content, err = readContent(cmd, from); err != nil {
					return err
				}
			}
			if len(props) > 0 && template == "" {
				if req.Content, err = files.ApplyPageProps(req.Content, props); err != nil {
					return err
				}
				props = nil
			}
			if noAutoCover {
				f := false
				req.AutoCover = &f
			}
			created, err := client.CreatePage(ctx, req)
			if err != nil {
				return err
			}
			d := created.Document
			if len(props) > 0 {
				// A page made from a template: its icon and cover go into what it got.
				if after, err := client.SetPageProps(ctx, d.Slug, props); err != nil {
					fmt.Fprintf(cmd.ErrOrStderr(), "  ! Created %s, but couldn't set its icon/cover: %v\n", d.Slug, err)
				} else {
					d = after
				}
			}
			out := pageResult(d)
			out.WorkspaceError = created.WorkspaceError
			if ff.json {
				return printValue(cmd.OutOrStdout(), out)
			}
			errw := cmd.ErrOrStderr()
			fmt.Fprintf(errw, "  ✓ Created the page %q (%s)\n", d.TitleText(), d.Slug)
			if out.URL != out.MarkdropURL {
				fmt.Fprintf(errw, "    also at %s\n", out.MarkdropURL)
			}
			if created.WorkspaceError != nil && *created.WorkspaceError != "" {
				fmt.Fprintf(errw, "  ! %s\n", *created.WorkspaceError)
			}
			fmt.Fprintln(cmd.OutOrStdout(), out.URL)
			return nil
		},
	}
	ff.register(c)
	c.Flags().StringVar(&workspace, "workspace", "", "file it in this workspace: its id, name or custom domain")
	c.Flags().StringVar(&folder, "folder", "", "a folder of --workspace: its path (guides/setup) or id")
	c.Flags().StringVar(&parent, "parent", "", "put it inside this page (slug or link)")
	c.Flags().StringVar(&template, "template", "", "start from this template (an id from `markdrop page templates`)")
	c.Flags().StringVar(&slug, "slug", "", "its address: markdrop.in/<slug> (3-50 letters, digits, - or _)")
	c.Flags().StringVar(&from, "from-file", "", "the page's Markdown: a file, or - for stdin")
	c.Flags().StringVar(&icon, "icon", "", "its icon: an emoji")
	c.Flags().StringVar(&cover, "cover", "", "its cover: gallery:<name> or an https:// image address")
	c.Flags().BoolVar(&noAutoCover, "no-auto-cover", false, "don't pick a cover for it")
	return c
}

// pageView is what `page get --json` prints (the hosted get_page's shape).
type pageView struct {
	pageOut
	Markdown   string            `json:"markdown"`
	Editor     string            `json:"editor"`
	Parent     *files.PageRef    `json:"parent"`
	Properties map[string]any    `json:"properties"`
	Children   []files.PageRef   `json:"children"`
	Assets     map[string]string `json:"assets"`
	UpdatedAt  string            `json:"updated_at"`
}

func newPageGetCmd() *cobra.Command {
	var ff fileFlags
	var body, info bool
	c := &cobra.Command{
		Use:   "get <page>",
		Short: "Print a page's Markdown (or its details)",
		Long: `Print a page's Markdown on stdout, front matter (icon, cover, …) included,
so that ` + "`markdrop page get p > p.md`" + ` and ` + "`markdrop page update p --from-file p.md`" + ` round-trip.

  --body leaves the front matter out; --info prints the title, link,
  revision, properties and sub-pages instead; --json prints all of it.`,
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
			ctx := cmdContext(cmd)
			d, err := client.GetPage(ctx, slug)
			if err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			if !ff.json && !info {
				md := d.Content
				if body {
					md = files.StripFrontMatter(md)
				}
				if md != "" && !strings.HasSuffix(md, "\n") {
					md += "\n"
				}
				_, err := io.WriteString(w, md)
				return err
			}
			kids := []files.PageRef{}
			if d.ChildrenCount > 0 {
				if kids, err = client.Children(ctx, d.Slug); err != nil {
					return err
				}
			}
			v := pageView{pageOut: pageResult(d), Markdown: d.Content, Editor: "classic", Parent: d.Parent,
				Properties: map[string]any{}, Children: kids, Assets: map[string]string{}, UpdatedAt: d.UpdatedAt}
			if body {
				v.Markdown = files.StripFrontMatter(d.Content)
			}
			if d.Editor != nil {
				v.Editor = *d.Editor
			}
			for k, val := range d.Page {
				if k != "icon_url" && k != "cover_url" {
					v.Properties[k] = val
				}
			}
			for id, raw := range d.Assets {
				var a struct {
					URL string `json:"url"`
				}
				_ = json.Unmarshal(raw, &a)
				v.Assets[id] = a.URL
			}
			if ff.json {
				return printValue(w, v)
			}
			fmt.Fprintln(w, v.URL)
			row := func(k, val string) {
				if val != "" {
					fmt.Fprintf(w, "  %-10s %s\n", k, val)
				}
			}
			row("title", d.TitleText())
			row("slug", d.Slug)
			row("editor", v.Editor)
			row("revision", strconv.Itoa(v.Rev))
			row("updated", shortTime(d.UpdatedAt))
			if d.Parent != nil {
				row("inside", d.Parent.Slug)
			}
			for _, k := range files.PagePropKeys {
				if val, ok := d.Page[k]; ok && val != nil {
					row(k, fmt.Sprint(val))
				}
			}
			for _, k := range kids {
				t := k.Slug
				if k.Title != nil && *k.Title != "" {
					t = *k.Title + " (" + k.Slug + ")"
				}
				row("sub-page", t)
			}
			return nil
		},
	}
	ff.register(c)
	c.Flags().BoolVar(&body, "body", false, "leave the front matter (icon, cover, …) out")
	c.Flags().BoolVar(&info, "info", false, "print the page's details instead of its Markdown")
	return c
}

func newPageUpdateCmd() *cobra.Command {
	var ff fileFlags
	var from, title string
	var baseRev int
	c := &cobra.Command{
		Use:   "update <page>",
		Short: "Replace a page's Markdown (and/or its title)",
		Long: `Replace a page's whole Markdown with a file's (--from-file, - for stdin), and/or
change its title (--title). The previous text is kept in the page's history
(` + "`markdrop page versions`" + `).

  --base-rev N refuses the save when the page changed since revision N (the
  revision ` + "`page get --info`" + ` showed), instead of overwriting someone's edit.
  Refused while someone else has the page open in the editor (try again).

Examples:
  markdrop page get notes > notes.md && $EDITOR notes.md && markdrop page update notes --from-file notes.md
  markdrop page update notes --title "Notes (final)"`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if from == "" && !cmd.Flags().Changed("title") {
				return errors.New("give --from-file (the new Markdown) and/or --title")
			}
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			var content string
			if from != "" {
				if content, err = readContent(cmd, from); err != nil {
					return err
				}
				if strings.TrimSpace(content) == "" {
					return errors.New("the new Markdown is empty; to delete the page use `markdrop trash rm`")
				}
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			d, err := client.GetPage(ctx, slug)
			if err != nil {
				return err
			}
			newTitle := d.TitleText()
			if cmd.Flags().Changed("title") {
				newTitle = strings.TrimSpace(title)
			}
			if from == "" {
				content = d.Content
			}
			rev := baseRev
			if rev <= 0 {
				rev = max(d.Rev, 1)
			}
			after, err := client.UpdateDocument(ctx, d.Slug, newTitle, content, rev)
			if err != nil {
				return err
			}
			return printPageWrite(cmd, ff, after, "Updated")
		},
	}
	ff.register(c)
	c.Flags().StringVar(&from, "from-file", "", "the new Markdown: a file, or - for stdin")
	c.Flags().StringVar(&title, "title", "", "the new title")
	c.Flags().IntVar(&baseRev, "base-rev", 0, "refuse if the page changed since this revision")
	return c
}

func printPageWrite(cmd *cobra.Command, ff fileFlags, d *files.Document, verb string) error {
	out := pageResult(d)
	if ff.json {
		return printValue(cmd.OutOrStdout(), out)
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ %s %s (revision %d)\n", verb, d.Slug, out.Rev)
	fmt.Fprintln(cmd.OutOrStdout(), out.URL)
	return nil
}

func newPageAppendCmd() *cobra.Command {
	var ff fileFlags
	var from string
	c := &cobra.Command{
		Use:   "append <page> [markdown…]",
		Short: "Add Markdown at the end of a page",
		Long: `Add Markdown at the end of a page: the words after the page, or a file
(--from-file, - for stdin). Someone else's save in between is merged (the text is
added to the page as it is then); refused while someone else has the page open
in the editor.

Examples:
  markdrop page append standup "- Shipped the CLI update"
  git log --oneline -5 | markdrop page append changelog --from-file -`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			text := strings.Join(args[1:], " ")
			if from != "" {
				if text != "" {
					return errors.New("give the Markdown as words or with --from-file, not both")
				}
				if text, err = readContent(cmd, from); err != nil {
					return err
				}
			}
			if strings.TrimSpace(text) == "" {
				return errors.New("nothing to add: give the Markdown after the page, or --from-file")
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			after, err := client.AppendToPage(cmdContext(cmd), slug, text)
			if err != nil {
				return err
			}
			return printPageWrite(cmd, ff, after, "Added to")
		},
	}
	ff.register(c)
	c.Flags().StringVar(&from, "from-file", "", "the Markdown to add: a file, or - for stdin")
	return c
}

// parsePropValue reads a --set value: JSON when it is JSON (numbers, true,
// null, ["a","b"], "quoted"), else the text itself.
func parsePropValue(s string) any {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err == nil {
		return v
	}
	return s
}

func newPagePropsCmd() *cobra.Command {
	var ff fileFlags
	var icon, cover, font string
	var coverY float64
	var fullWidth, smallText, locked, allowExport bool
	var clear, set []string
	c := &cobra.Command{
		Use:   "props <page>",
		Short: "Show or change a page's icon, cover and other properties",
		Long: `Without flags, print the page's properties. With flags, change them:

  --icon 🚀                 an emoji, or asset:<id> (an image of the page)
  --cover gallery:dusk      a built-in cover, asset:<id>, an https:// image,
                            or auto (pick one, like a new page gets)
  --cover-y 30              the cover's focal point, 0 (top) .. 100 (bottom)
  --full-width, --small-text, --locked, --allow-export=false
  --font serif              default, serif or mono
  --clear icon              remove one (repeatable)
  --set Status=Done         a typed property of the page's folder (repeatable;
                            JSON values work: --set Points=3, --set Tags='["a","b"]')

  For an image from your disk as the cover, use ` + "`markdrop page image add <page> <file> --cover`" + `.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			fl := cmd.Flags()
			changes := map[string]any{}
			if fl.Changed("icon") {
				changes["icon"] = icon
			}
			autoCover := false
			if fl.Changed("cover") {
				if strings.EqualFold(strings.TrimSpace(cover), "auto") {
					autoCover = true
				} else {
					changes["cover"] = cover
				}
			}
			if fl.Changed("cover-y") {
				changes["cover_y"] = coverY
			}
			if fl.Changed("font") {
				changes["font"] = font
			}
			for flag, key := range map[string]string{"full-width": "full_width", "small-text": "small_text",
				"locked": "locked", "allow-export": "allow_export"} {
				if fl.Changed(flag) {
					v, _ := fl.GetBool(flag)
					changes[key] = v
				}
			}
			for _, k := range clear {
				k = strings.ReplaceAll(strings.TrimSpace(k), "-", "_")
				if !files.IsPagePropKey(k) {
					return fmt.Errorf("--clear takes one of %s (got %q)", strings.Join(files.PagePropKeys, ", "), k)
				}
				if _, dup := changes[k]; dup {
					return fmt.Errorf("--clear %s and a new %s at once", k, k)
				}
				changes[k] = nil
			}
			values := map[string]any{}
			for _, kv := range set {
				k, v, ok := strings.Cut(kv, "=")
				if !ok || strings.TrimSpace(k) == "" {
					return fmt.Errorf("--set takes key=value (got %q)", kv)
				}
				values[strings.TrimSpace(k)] = parsePropValue(v)
			}
			if _, err := files.ValidatePageProps(changes); err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			if len(changes) == 0 && len(values) == 0 && !autoCover {
				d, err := client.GetPage(ctx, slug)
				if err != nil {
					return err
				}
				return printProps(cmd, ff, d, nil)
			}
			if autoCover {
				picked, err := client.SuggestCover(ctx, slug)
				if err != nil {
					return err
				}
				changes["cover"] = picked
			}
			var d *files.Document
			if len(changes) > 0 {
				if d, err = client.SetPageProps(ctx, slug, changes); err != nil {
					return err
				}
				slug = d.Slug
			}
			var typed json.RawMessage
			if len(values) > 0 {
				if typed, err = client.SetPageValues(ctx, slug, values); err != nil {
					return err
				}
				if d, err = client.GetPage(ctx, slug); err != nil {
					return err
				}
			}
			for k, want := range changes {
				// The server reads front matter leniently: say so when it didn't take a value.
				if want != nil && d.Page != nil && d.Page[k] == nil && (k == "icon" || k == "cover") {
					fmt.Fprintf(cmd.ErrOrStderr(), "  ! Markdrop didn't accept %s %v (not a built-in cover or image of this page?)\n", k, want)
				}
			}
			return printProps(cmd, ff, d, typed)
		},
	}
	ff.register(c)
	f := c.Flags()
	f.StringVar(&icon, "icon", "", "an emoji, or asset:<id>")
	f.StringVar(&cover, "cover", "", "gallery:<name>, asset:<id>, an https:// image, or auto")
	f.Float64Var(&coverY, "cover-y", 50, "the cover's focal point, 0 (top) to 100 (bottom)")
	f.StringVar(&font, "font", "", "default, serif or mono")
	f.BoolVar(&fullWidth, "full-width", false, "use the full width of the window")
	f.BoolVar(&smallText, "small-text", false, "smaller text")
	f.BoolVar(&locked, "locked", false, "only its owner and workspace admins may edit it")
	f.BoolVar(&allowExport, "allow-export", true, "readers may export it (editors always can)")
	f.StringArrayVar(&clear, "clear", nil, "remove a property (icon, cover, …); repeatable")
	f.StringArrayVar(&set, "set", nil, "set a typed property of the page's folder: key=value; repeatable")
	return c
}

func printProps(cmd *cobra.Command, ff fileFlags, d *files.Document, typed json.RawMessage) error {
	props := map[string]any{}
	for _, k := range files.PagePropKeys {
		if v, ok := d.Page[k]; ok {
			props[k] = v
		}
	}
	var values map[string]any
	if typed != nil {
		var t struct {
			Values map[string]any `json:"values"`
		}
		_ = json.Unmarshal(typed, &t)
		values = t.Values
	} else if pp := d.Raw; pp != nil {
		var t struct {
			PageProperties *struct {
				Values map[string]any `json:"values"`
			} `json:"page_properties"`
		}
		_ = json.Unmarshal(pp, &t)
		if t.PageProperties != nil {
			values = t.PageProperties.Values
		}
	}
	if ff.json {
		out := struct {
			pageOut
			Properties map[string]any `json:"properties"`
			Values     map[string]any `json:"values"`
		}{pageResult(d), props, values}
		if out.Values == nil {
			out.Values = map[string]any{}
		}
		return printValue(cmd.OutOrStdout(), out)
	}
	w := cmd.OutOrStdout()
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, k := range files.PagePropKeys {
		v, ok := props[k]
		if !ok {
			continue
		}
		if v == nil {
			v = "-"
		}
		fmt.Fprintf(tw, "%s\t%v\n", k, v)
	}
	for k, v := range values {
		b, _ := json.Marshal(v)
		fmt.Fprintf(tw, "%s\t%s\n", k, b)
	}
	return tw.Flush()
}

func newPageTemplatesCmd() *cobra.Command {
	var ff fileFlags
	var workspace string
	c := &cobra.Command{
		Use:   "templates",
		Short: "List the templates a page can start from",
		Long: `List the page templates you can use with ` + "`markdrop page new --template <id>`" + `:
the built-in ones, your own, and with --workspace that workspace's.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			wsID := ""
			if workspace != "" {
				ws, err := client.ResolveWorkspace(ctx, workspace)
				if err != nil {
					return err
				}
				wsID = ws.ID
			}
			all, err := client.Templates(ctx, wsID)
			if err != nil {
				return err
			}
			if ff.json {
				return printValue(cmd.OutOrStdout(), map[string]any{"templates": all})
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tNAME\tSCOPE\tDESCRIPTION")
			for _, t := range all {
				desc := t.Description
				if len([]rune(desc)) > 60 {
					desc = string([]rune(desc)[:59]) + "…"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", t.ID, t.Name, t.Scope, orDash(desc))
			}
			return tw.Flush()
		},
	}
	ff.register(c)
	c.Flags().StringVar(&workspace, "workspace", "", "also list this workspace's templates (id, name or domain)")
	return c
}

func newPageImageCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "image",
		Short: "Add an image from your disk to a page",
	}
	var ff fileFlags
	var alt string
	var asCover, asIcon, appendIt bool
	add := &cobra.Command{
		Use:   "add <page> <file>",
		Short: "Upload an image to a page (and make it the cover, the icon, or add it at the end)",
		Long: `Upload an image (PNG, JPEG, GIF or WebP, up to 10 MB) to a page. Prints the
Markdown that shows it, ![alt](asset:<id>), to put where it belongs, or:

  --cover    make it the page's cover
  --icon     make it the page's icon
  --append   add it at the end of the page

Examples:
  markdrop page image add launch-notes hero.jpg --cover
  markdrop page image add launch-notes chart.png --append --alt "Signups by week"`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if asCover && asIcon {
				return errors.New("use --cover or --icon, not both")
			}
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			d, err := client.GetPage(ctx, slug)
			if err != nil {
				return err
			}
			img, err := client.UploadPageImage(ctx, d.Slug, args[1], alt)
			if err != nil {
				return err
			}
			errw := cmd.ErrOrStderr()
			fmt.Fprintf(errw, "  ✓ Uploaded %s to %s (%s, %s)\n", args[1], d.Slug, img.Mime, formatBytes(img.Size))
			out := struct {
				*files.PageImage
				Cover    bool   `json:"cover"`
				Icon     bool   `json:"icon"`
				Appended bool   `json:"appended"`
				Rev      *int   `json:"rev,omitempty"`
				URL      string `json:"url"`
			}{PageImage: img, Cover: asCover, Icon: asIcon, Appended: appendIt, URL: d.CanonicalURL()}
			if asCover || asIcon {
				key := "cover"
				if asIcon {
					key = "icon"
				}
				after, err := client.SetPageProps(ctx, d.Slug, map[string]any{key: img.Asset})
				if err != nil {
					return fmt.Errorf("the image is on the page (%s) but setting it as the %s failed: %w", img.Asset, key, err)
				}
				out.Rev = &after.Rev
				fmt.Fprintf(errw, "  ✓ It is the %s of %s now\n", key, d.Slug)
			}
			if appendIt {
				after, err := client.AppendToPage(ctx, d.Slug, img.Markdown)
				if err != nil {
					return fmt.Errorf("the image is on the page (%s) but adding it at the end failed: %w", img.Markdown, err)
				}
				out.Rev = &after.Rev
				fmt.Fprintf(errw, "  ✓ Added at the end of %s\n", d.Slug)
			}
			if ff.json {
				return printValue(cmd.OutOrStdout(), out)
			}
			fmt.Fprintln(cmd.OutOrStdout(), img.Markdown)
			return nil
		},
	}
	ff.register(add)
	add.Flags().StringVar(&alt, "alt", "", "alt text (default: the file name)")
	add.Flags().BoolVar(&asCover, "cover", false, "make it the page's cover")
	add.Flags().BoolVar(&asIcon, "icon", false, "make it the page's icon")
	add.Flags().BoolVar(&appendIt, "append", false, "add it at the end of the page")
	c.AddCommand(add)
	return c
}

func newPageVersionsCmd() *cobra.Command {
	var ff fileFlags
	var limit, cursor int
	c := &cobra.Command{
		Use:   "versions <page>",
		Short: "List a page's saved versions (its history)",
		Long: `List a page's saved versions, newest first: number, when, who, title and size;
* marks the one that is the page now. More with --cursor <the last number>.
(For a published file's versions, use ` + "`markdrop versions`" + `.)`,
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
			vs, err := client.ListPageVersions(cmdContext(cmd), slug, cursor, limit)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), vs.Raw)
			}
			if !vs.Available {
				reason := "it has no history"
				if vs.Reason != nil && *vs.Reason == "encrypted" {
					reason = "it is end-to-end encrypted"
				} else if vs.Reason != nil && *vs.Reason == "file" {
					reason = "it is a file: use `markdrop versions`"
				}
				return fmt.Errorf("no page history for %s: %s", slug, reason)
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "  VERSION\tSAVED\tBY\tTITLE\tSIZE")
			for _, v := range vs.Versions {
				mark := " "
				if v.Current {
					mark = "*"
				}
				title := "-"
				if v.Title != nil && *v.Title != "" {
					title = *v.Title
				}
				if v.RestoredFrom != nil {
					title += fmt.Sprintf(" (restored from %d)", *v.RestoredFrom)
				}
				fmt.Fprintf(tw, "%s %d\t%s\t%s\t%s\t%s\n", mark, v.N, shortTime(v.TS), orDash(v.AuthorName()), title,
					formatBytes(v.Bytes))
			}
			if err := tw.Flush(); err != nil {
				return err
			}
			if vs.NextCursor != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "  More: markdrop page versions %s --cursor %d\n", slug, *vs.NextCursor)
			}
			return nil
		},
	}
	ff.register(c)
	c.Flags().IntVar(&limit, "limit", 0, "how many (default 30, at most 100)")
	c.Flags().IntVar(&cursor, "cursor", 0, "list the versions older than this one")
	return c
}

func newPageVersionCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "version <page> <n>",
		Short: "Print the Markdown of one saved version of a page",
		Args:  cobra.ExactArgs(2),
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
			raw, err := client.GetPageVersion(cmdContext(cmd), slug, n)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), raw)
			}
			var v struct {
				Markdown string `json:"markdown"`
			}
			if err := json.Unmarshal(raw, &v); err != nil {
				return fmt.Errorf("unexpected answer from the server: %w", err)
			}
			md := v.Markdown
			if md != "" && !strings.HasSuffix(md, "\n") {
				md += "\n"
			}
			_, err = io.WriteString(cmd.OutOrStdout(), md)
			return err
		},
	}
	ff.register(c)
	return c
}

func newPageRestoreCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "restore <page> <n>",
		Short: "Make a saved version the page again",
		Long: `Make version n (see ` + "`markdrop page versions`" + `) the page again. The page as it is
now is kept as a version first, so a restore can be undone the same way.
(For a published file, use ` + "`markdrop restore`" + `.)`,
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
			d, v, err := client.RestorePageVersion(cmdContext(cmd), slug, n)
			if err != nil {
				return err
			}
			if ff.json {
				out := struct {
					pageOut
					Version      int `json:"version"`
					RestoredFrom int `json:"restored_from"`
				}{pageResult(d), v, n}
				return printValue(cmd.OutOrStdout(), out)
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Version %d of %s is the page again (saved as version %d)\n", n, d.Slug, v)
			fmt.Fprintln(cmd.OutOrStdout(), d.CanonicalURL())
			return nil
		},
	}
	ff.register(c)
	return c
}
