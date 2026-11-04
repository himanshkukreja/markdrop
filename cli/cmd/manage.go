package cmd

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/markdrop/cli/internal/files"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

// link, export, trash, access and search: document-level commands.

// stdinIsTTY decides whether a confirmation can be asked. Tests replace it.
var stdinIsTTY = func(r io.Reader) bool {
	f, ok := r.(*os.File)
	return ok && (isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd()))
}

func newLinkCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "link",
		Short: "Change a document's link (slug)",
	}
	var ff fileFlags
	var check bool
	set := &cobra.Command{
		Use:   "set <document> <new-slug>",
		Short: "Give a page, document or file a new link; the old one keeps redirecting",
		Long: `Change the link of a page, document or file you own: markdrop.in/<new-slug>, and
the last part of its address on its workspace's domain. The old link keeps
working and redirects to the new one; embeds and mentions of it keep working.

  Slugs are 3-50 letters, digits, - or _. --check only says whether the new
  slug is free (and what the links would be), changing nothing.

Examples:
  markdrop link set https://markdrop.in/x7k2p9 q3-roadmap
  markdrop link set q3-roadmap roadmap --check`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			newSlug := strings.TrimSpace(args[1])
			if !customSlugRE.MatchString(newSlug) {
				return fmt.Errorf("the new slug must be 3-50 letters, digits, - or _ (got %q)", newSlug)
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			if check {
				sc, err := client.CheckSlug(ctx, slug, newSlug)
				if err != nil {
					return err
				}
				if ff.json {
					return printJSON(cmd.OutOrStdout(), sc.Raw)
				}
				if !sc.Available {
					why := "it is taken"
					if sc.Detail != nil && *sc.Detail != "" {
						why = *sc.Detail
					}
					return fmt.Errorf("%s can't be the new link: %s", newSlug, why)
				}
				fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ %s is free\n", newSlug)
				if sc.URL != nil {
					fmt.Fprintln(cmd.OutOrStdout(), *sc.URL)
				}
				return nil
			}
			before, err := client.GetDocument(ctx, slug)
			if err != nil {
				return err
			}
			if before.Slug == newSlug {
				return printLinkResult(cmd, ff, before, "", "That is already its link")
			}
			after, err := client.ChangeSlug(ctx, before.Slug, newSlug)
			if err != nil {
				if files.IsStatus(err, http.StatusConflict) {
					return fmt.Errorf("%s is taken (by another document, or one deleted less than 30 days ago): %w", newSlug, err)
				}
				return err
			}
			return printLinkResult(cmd, ff, after, before.Slug, "Changed the link")
		},
	}
	ff.register(set)
	set.Flags().BoolVar(&check, "check", false, "only check whether the new slug is free")
	c.AddCommand(set)
	return c
}

func printLinkResult(cmd *cobra.Command, ff fileFlags, d *files.Document, previous, verb string) error {
	if ff.json {
		var prev *string
		if previous != "" {
			prev = &previous
		}
		return printValue(cmd.OutOrStdout(), map[string]any{
			"url": d.CanonicalURL(), "markdrop_url": d.URL, "workspace_url": d.WorkspaceURL, "slug": d.Slug,
			"previous_slug": prev,
		})
	}
	msg := fmt.Sprintf("  ✓ %s: %s", verb, d.Slug)
	if previous != "" {
		msg += fmt.Sprintf(" (the old link, /%s, redirects there)", previous)
	}
	fmt.Fprintln(cmd.ErrOrStderr(), msg)
	fmt.Fprintln(cmd.OutOrStdout(), d.CanonicalURL())
	return nil
}

func newExportCmd() *cobra.Command {
	var ff fileFlags
	var format, output string
	var subpages, force bool
	c := &cobra.Command{
		Use:   "export <page>",
		Short: "Download a page as Markdown, HTML or a zip",
		Long: `Download a page as portable Markdown (md, the default), one self-contained HTML
file (html, images inlined) or a zip (zip: the Markdown with its images).
--subpages adds every sub-page you can open (as a zip of folders).

  -o names the file, or a folder to save into (default: the current folder,
  under the name Markdrop gives it); -o - writes to stdout. An existing file is
  never overwritten without --force.

Examples:
  markdrop export release-notes                      # ./release-notes.md
  markdrop export handbook --subpages -o ~/Backups/  # handbook.zip
  markdrop export spec --format html -o spec.html
  markdrop export notes -o - | wc -w`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			format = strings.ToLower(strings.TrimSpace(format))
			switch format {
			case "md", "markdown":
				format = "md"
			case "html", "zip":
			default:
				return fmt.Errorf("--format must be md, html or zip (got %q)", format)
			}
			slug, err := files.ParseSlug(args[0])
			if err != nil {
				return err
			}
			if output == "-" && ff.json {
				return errors.New("-o - writes the export to stdout; it can't go with --json")
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			if output == "-" {
				_, err := client.Export(ctx, slug, format, subpages, cmd.OutOrStdout())
				return err
			}
			res, err := client.ExportToFile(ctx, slug, format, subpages, output, force)
			if err != nil {
				return err
			}
			if ff.json {
				return printValue(cmd.OutOrStdout(), res)
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Exported %s (%s)\n", slug, formatBytes(res.Bytes))
			if res.Notes > 0 {
				fmt.Fprintf(cmd.ErrOrStderr(), "    %d note(s) about what couldn't be exported as it is: see the file\n", res.Notes)
			}
			fmt.Fprintln(cmd.OutOrStdout(), res.Path)
			return nil
		},
	}
	ff.register(c)
	c.Flags().StringVar(&format, "format", "md", "md, html or zip")
	c.Flags().BoolVar(&subpages, "subpages", false, "include the sub-pages (a zip)")
	c.Flags().StringVarP(&output, "output", "o", "", "file or folder to save to, or - for stdout")
	c.Flags().BoolVar(&force, "force", false, "overwrite an existing file")
	return c
}

func newTrashCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "trash",
		Short: "List, restore or delete items in the trash",
		Long: `Deleted pages, documents, files and folders go to the trash for 30 days, then
are deleted for good.

  markdrop trash ls                       what you can restore
  markdrop trash rm <document>            move a page, document or file to the trash
  markdrop trash restore <document>       bring it back (a folder: its id from ls)
  markdrop trash rm --permanent <document>  delete it forever (asks first)`,
	}
	c.AddCommand(newTrashLsCmd(), newTrashRestoreCmd(), newTrashRmCmd())
	return c
}

func newTrashLsCmd() *cobra.Command {
	var ff fileFlags
	var workspace string
	c := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List what you can restore",
		Long: `List your deleted items, and everything deleted from workspaces you administer,
newest first, with how many days are left before each is deleted for good.`,
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
			t, err := client.ListTrash(ctx, wsID)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), t.Raw)
			}
			if len(t.Items) == 0 {
				fmt.Fprintln(cmd.ErrOrStderr(), "  The trash is empty.")
				return nil
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "KEY\tKIND\tTITLE\tFROM\tDELETED\tDAYS LEFT")
			for _, it := range t.Items {
				title := "-"
				if it.Title != nil && *it.Title != "" {
					title = *it.Title
				}
				from := ""
				if it.Where != nil {
					var parts []string
					if it.Where.Workspace != nil && it.Where.Workspace.Name != nil {
						parts = append(parts, *it.Where.Workspace.Name)
					}
					if it.Where.Folder != nil && it.Where.Folder.Name != nil {
						parts = append(parts, *it.Where.Folder.Name)
					}
					from = strings.Join(parts, " / ")
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d\n", it.Key, it.Kind, title, orDash(from), shortTime(it.DeletedAt),
					it.DaysLeft)
			}
			return tw.Flush()
		},
	}
	ff.register(c)
	c.Flags().StringVar(&workspace, "workspace", "", "only items deleted from this workspace (id, name or domain)")
	return c
}

// trashKey is a document's slug (from a slug or link) or a folder's id.
func trashKey(arg string) (string, error) {
	return files.ParseSlug(arg)
}

func newTrashRestoreCmd() *cobra.Command {
	var ff fileFlags
	c := &cobra.Command{
		Use:   "restore <document|folder-id>",
		Short: "Bring an item back from the trash",
		Long: `Bring a deleted page, document, file or folder back, where it was: the same link,
workspace, folder, access and people (a page with the sub-pages deleted with it,
a folder with everything in it). A folder is named by the KEY ` + "`markdrop trash ls`" + ` shows.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			key, err := trashKey(args[0])
			if err != nil {
				return err
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			raw, err := client.RestoreFromTrash(cmdContext(cmd), key)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), raw)
			}
			var r struct {
				Slug  *string  `json:"slug"`
				Kind  string   `json:"kind"`
				URL   *string  `json:"url"`
				Items []any    `json:"items"`
				Notes []string `json:"notes"`
			}
			_ = json.Unmarshal(raw, &r)
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Restored %s (%d item(s))\n", key, max(len(r.Items), 1))
			for _, n := range r.Notes {
				fmt.Fprintf(cmd.ErrOrStderr(), "    %s\n", n)
			}
			if r.URL != nil {
				fmt.Fprintln(cmd.OutOrStdout(), *r.URL)
			}
			return nil
		},
	}
	ff.register(c)
	return c
}

func newTrashRmCmd() *cobra.Command {
	var ff fileFlags
	var permanent, yes bool
	var children string
	c := &cobra.Command{
		Use:   "rm <document>",
		Short: "Move a page, document or file to the trash (or delete it forever)",
		Long: `Delete a page, document or file you own: it goes to the trash, its link stops
working at once, and it can be brought back for 30 days (markdrop trash restore).

  A page with pages inside it needs --children delete (they go too, and come
  back with it) or --children lift (they move up a level and stay).

  --permanent deletes it forever, now (also an item already in the trash). It
  can't be undone: you are asked first, unless --yes.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			key, err := trashKey(args[0])
			if err != nil {
				return err
			}
			switch children {
			case "", "delete", "lift":
			default:
				return fmt.Errorf("--children must be delete or lift (got %q)", children)
			}
			if permanent && !yes {
				if !stdinIsTTY(cmd.InOrStdin()) {
					return errors.New("--permanent deletes it forever; add --yes to confirm")
				}
				fmt.Fprintf(cmd.ErrOrStderr(), "  Delete %s forever? This can't be undone. [y/N]: ", key)
				line, _ := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
				if a := strings.ToLower(strings.TrimSpace(line)); a != "y" && a != "yes" {
					return errors.New("cancelled; nothing was deleted")
				}
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			trashed := false
			err = client.MoveToTrash(ctx, key, children)
			switch {
			case err == nil:
				trashed = true
			case files.IsStatus(err, http.StatusConflict):
				var ae *files.APIError
				if errors.As(err, &ae) && ae.Code == "has_children" {
					return fmt.Errorf("%s has pages inside it: add --children delete (they go too) or --children lift "+
						"(they move up a level)", key)
				}
				return err
			case files.IsStatus(err, http.StatusNotFound) && permanent:
				// Already in the trash: delete it forever from there.
			default:
				return err
			}
			if !permanent {
				if ff.json {
					return printValue(cmd.OutOrStdout(), map[string]any{"deleted": true, "trashed": true, "slug": key})
				}
				fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Moved %s to the trash. Bring it back within 30 days with: markdrop trash restore %s\n", key, key)
				return nil
			}
			raw, err := client.DeleteForever(ctx, key)
			if err != nil {
				if trashed {
					return fmt.Errorf("%s is in the trash, but deleting it forever failed: %w", key, err)
				}
				return err
			}
			if ff.json {
				var r struct {
					Items json.RawMessage `json:"items"`
				}
				_ = json.Unmarshal(raw, &r)
				if r.Items == nil {
					r.Items = json.RawMessage("[]")
				}
				return printValue(cmd.OutOrStdout(), map[string]any{"deleted": true, "trashed": false, "slug": key,
					"deleted_items": r.Items})
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Deleted %s forever.\n", key)
			return nil
		},
	}
	ff.register(c)
	c.Flags().BoolVar(&permanent, "permanent", false, "delete it forever instead of moving it to the trash")
	c.Flags().BoolVarP(&yes, "yes", "y", false, "don't ask before deleting forever")
	c.Flags().StringVar(&children, "children", "", "for a page with sub-pages: delete or lift")
	return c
}

func newAccessCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "access",
		Short: "Request edit access, and approve or decline requests on your documents",
		Long: `Access requests, as in the app:

  markdrop access request <document> [--message …]   ask its owner for edit access
  markdrop access requests                            requests on your documents (pending)
  markdrop access approve <id> [--role viewer|editor]
  markdrop access decline <id>`,
	}
	c.AddCommand(newAccessRequestCmd(), newAccessRequestsCmd(), newAccessDecideCmd("approve"),
		newAccessDecideCmd("decline"))
	return c
}

func newAccessRequestCmd() *cobra.Command {
	var ff fileFlags
	var message string
	var view bool
	c := &cobra.Command{
		Use:   "request <document>",
		Short: "Ask for edit access to a page, document or file you can open",
		Long: `Ask for edit access to something you can open but not edit, like "Request edit
access" in the page's menu. The owner (or, when it has none, its workspace's
admins) gets an email to approve or decline, with your --message; you get one
when they decide. --view asks to open something you can't open yet instead.`,
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
			role := "editor"
			if view {
				role = "viewer"
			}
			raw, err := client.RequestAccess(cmdContext(cmd), slug, role, message)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), raw)
			}
			var r struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			}
			_ = json.Unmarshal(raw, &r)
			what := "edit"
			if view {
				what = "open"
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Asked to %s %s (%s). You get an email when it is decided.\n", what, slug, r.Status)
			fmt.Fprintln(cmd.OutOrStdout(), r.ID)
			return nil
		},
	}
	ff.register(c)
	c.Flags().StringVar(&message, "message", "", "a note for the owner: what you want to change, and why")
	c.Flags().BoolVar(&view, "view", false, "ask to open it (not to edit it)")
	return c
}

func newAccessRequestsCmd() *cobra.Command {
	var ff fileFlags
	var status string
	c := &cobra.Command{
		Use:   "requests",
		Short: "List access requests on your documents",
		Long: `List people's requests to open or edit your documents (and edit requests sent to
workspaces you administer), newest first. --status pending (default),
approved, declined or all. Decide with ` + "`markdrop access approve|decline <id>`" + `.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			switch status {
			case "pending", "approved", "declined", "all":
			default:
				return fmt.Errorf("--status must be pending, approved, declined or all (got %q)", status)
			}
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			rs, err := client.ListAccessRequests(cmdContext(cmd), status)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), rs.Raw)
			}
			if len(rs.Requests) == 0 {
				fmt.Fprintf(cmd.ErrOrStderr(), "  No %s access requests.\n", strings.TrimSuffix(status+" ", "all "))
				return nil
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tSTATUS\tWANTS\tFROM\tDOCUMENT\tASKED")
			for _, r := range rs.Requests {
				who := "-"
				if r.Requester.Email != nil {
					who = *r.Requester.Email
				}
				if r.Requester.Name != nil && *r.Requester.Name != "" {
					who = *r.Requester.Name + " <" + who + ">"
				}
				doc := r.Document.Slug
				if r.Document.Title != nil && *r.Document.Title != "" {
					doc = *r.Document.Title + " (" + r.Document.Slug + ")"
				}
				wants := "view"
				if r.RoleRequested == "editor" {
					wants = "edit"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", r.ID, r.Status, wants, who, doc, shortTime(r.CreatedAt))
			}
			if err := tw.Flush(); err != nil {
				return err
			}
			for _, r := range rs.Requests {
				if r.Message != nil && *r.Message != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "  %s: %q\n", r.ID, *r.Message)
				}
			}
			return nil
		},
	}
	ff.register(c)
	c.Flags().StringVar(&status, "status", "pending", "pending, approved, declined or all")
	return c
}

func newAccessDecideCmd(verb string) *cobra.Command {
	var ff fileFlags
	var role string
	c := &cobra.Command{
		Use:  verb + " <request-id>",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			decision := "decline"
			if verb == "approve" {
				switch role {
				case "", "viewer", "editor":
				default:
					return fmt.Errorf("--role must be viewer or editor (got %q)", role)
				}
				if role == "" {
					r, err := client.GetAccessRequest(ctx, id)
					if err != nil {
						return err
					}
					role = r.RoleRequested
				}
				decision = "view"
				if role == "editor" {
					decision = "edit"
				}
			}
			raw, err := client.DecideAccessRequest(ctx, id, decision)
			if err != nil {
				return err
			}
			if ff.json {
				return printJSON(cmd.OutOrStdout(), raw)
			}
			var r struct {
				Status      string  `json:"status"`
				RoleGranted *string `json:"role_granted"`
			}
			_ = json.Unmarshal(raw, &r)
			if r.Status == "approved" {
				can := "view"
				if r.RoleGranted != nil && *r.RoleGranted == "editor" {
					can = "edit"
				}
				fmt.Fprintf(cmd.ErrOrStderr(), "  ✓ Approved: they can %s it now, and get an email saying so.\n", can)
			} else {
				fmt.Fprintln(cmd.ErrOrStderr(), "  ✓ Declined. They get an email saying so.")
			}
			fmt.Fprintln(cmd.OutOrStdout(), r.Status)
			return nil
		},
	}
	if verb == "approve" {
		c.Short = "Approve an access request (shares the document with them)"
		c.Long = `Approve a request from ` + "`markdrop access requests`" + `: the document is shared with the
requester's email address and they get an email. A request to edit gives edit
access to that page only. --role viewer|editor gives other access than asked
for (a request to edit can only be approved as editor).`
		c.Flags().StringVar(&role, "role", "", "viewer or editor (default: what they asked for)")
	} else {
		c.Short = "Decline an access request"
	}
	ff.register(c)
	return c
}

func newSearchCmd() *cobra.Command {
	var ff fileFlags
	var workspace, kind string
	var limit int
	c := &cobra.Command{
		Use:   "search <query…>",
		Short: "Find your pages, documents, files, folders and workspaces",
		Long: `Search everything you can open by title, address or file name (and folders and
workspaces by name), like ⌘K in the app.

  --kind page|document|file|folder|workspace narrows it; --workspace (id, name or
  domain) keeps what is in that workspace; --limit is per kind (default 8, at
  most 20).

Examples:
  markdrop search roadmap
  markdrop search "launch video" --kind file
  markdrop search onboarding --workspace Acme --json`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := apiClient(ff.token)
			if err != nil {
				return err
			}
			ctx := cmdContext(cmd)
			opts := files.SearchOptions{Limit: limit, Kind: strings.ToLower(strings.TrimSpace(kind))}
			if workspace != "" {
				ws, err := client.ResolveWorkspace(ctx, workspace)
				if err != nil {
					return err
				}
				opts.WorkspaceID = ws.ID
			}
			res, err := client.Search(ctx, strings.Join(args, " "), opts)
			if err != nil {
				return err
			}
			if ff.json {
				return printValue(cmd.OutOrStdout(), res)
			}
			if len(res.Results) == 0 {
				fmt.Fprintf(cmd.ErrOrStderr(), "  Nothing found for %q.\n", res.Query)
				return nil
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "KIND\tTITLE\tWHERE\tLINK")
			for _, h := range res.Results {
				where := ""
				if h.Workspace != nil {
					where = h.Workspace.Name
				}
				if h.Path != "" {
					where = strings.TrimSuffix(where+" / "+h.Path, " / ")
				}
				link := h.URL
				if link == "" {
					link = h.ID
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", h.Kind, h.Title, orDash(strings.TrimPrefix(where, " / ")), link)
			}
			return tw.Flush()
		},
	}
	ff.register(c)
	c.Flags().StringVar(&workspace, "workspace", "", "only results in this workspace (id, name or domain)")
	c.Flags().StringVar(&kind, "kind", "", "page, document, file, folder or workspace")
	c.Flags().IntVar(&limit, "limit", 0, "results per kind (default 8, at most 20)")
	return c
}
