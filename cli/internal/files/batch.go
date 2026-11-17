package files

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// DirOptions describes a folder upload: every file under Path, recursively.
type DirOptions struct {
	Path      string // local folder
	Access    string // link | private | password | workspace; "" = the server's default (the folder's "new items start as")
	Password  string
	Workspace string // workspace id
	Folder    string // folder of that workspace (path or id) to upload into; "" = its root

	OnFile     func(done, total int, rel string) // optional: a file starts (hashing, then sending)
	OnProgress func(Progress)                    // optional
	OnNotice   func(string)                      // optional
}

// DirFile is the outcome for one file of a folder upload.
type DirFile struct {
	Path   string  `json:"path"` // relative to the folder, with forward slashes
	Folder string  `json:"folder,omitempty"`
	Result *Result `json:"-"`
	URL    string  `json:"url,omitempty"`
	Slug   string  `json:"slug,omitempty"`
	Error  string  `json:"error,omitempty"`
}

// DirResult is a folder upload's outcome, file by file.
type DirResult struct {
	Files  []DirFile `json:"files"`
	Done   int       `json:"done"`
	Failed int       `json:"failed"`
}

// ListDir returns the files a folder upload sends: regular files under root,
// recursively, sorted, skipping hidden files and folders (.git, .DS_Store, …)
// and symlinks. Paths are relative, with forward slashes.
func ListDir(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != root && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(out)
	return out, err
}

// UploadDir publishes every file under opts.Path with the batch API: files
// are hashed, sessions for up to MaxBatch of them are opened in one call, the
// parts are sent, and one call completes them all. With a workspace, the
// folder's sub-folders become folders of the workspace (created when
// missing) under opts.Folder; without one, every file is a link of its own.
// One file failing doesn't stop the others; re-running resumes what's open.
func (u *Uploader) UploadDir(ctx context.Context, opts DirOptions) (*DirResult, error) {
	if u.Client == nil {
		return nil, errors.New("files: Uploader.Client is nil")
	}
	if strings.TrimSpace(u.Client.Token) == "" {
		return nil, ErrNoToken
	}
	root, err := filepath.Abs(opts.Path)
	if err != nil {
		return nil, err
	}
	rels, err := ListDir(root)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", opts.Path, unwrapPath(err))
	}
	if len(rels) == 0 {
		return nil, fmt.Errorf("%s has no files to upload (hidden files are skipped)", root)
	}
	notice := opts.OnNotice
	if notice == nil {
		notice = func(string) {}
	}
	folders := &folderMaker{c: u.Client, ws: opts.Workspace, base: strings.Trim(opts.Folder, "/")}
	if opts.Workspace == "" && hasSubdirs(rels) {
		notice("Files in sub-folders are published as links of their own: folders need --workspace.")
	}

	res := &DirResult{Files: make([]DirFile, len(rels))}
	for i, rel := range rels {
		res.Files[i] = DirFile{Path: rel}
	}
	for start := 0; start < len(rels); start += MaxBatch {
		end := min(start+MaxBatch, len(rels))
		if err := u.uploadChunk(ctx, root, opts, folders, res.Files[start:end], start, len(rels)); err != nil {
			return res.count(), err
		}
	}
	return res.count(), nil
}

func (r *DirResult) count() *DirResult {
	r.Done, r.Failed = 0, 0
	for _, f := range r.Files {
		if f.Error == "" && f.URL != "" {
			r.Done++
		} else {
			r.Failed++
		}
	}
	return r
}

func hasSubdirs(rels []string) bool {
	for _, r := range rels {
		if strings.Contains(r, "/") {
			return true
		}
	}
	return false
}

// dirJob is one file of a chunk on its way.
type dirJob struct {
	out  *DirFile
	abs  string
	f    *os.File
	size int64
	sha  string
	req  CreateUploadRequest
	job  *job
}

func (u *Uploader) uploadChunk(ctx context.Context, root string, opts DirOptions, folders *folderMaker,
	files []DirFile, offset, total int) error {
	report := opts.OnProgress
	if report == nil {
		report = func(Progress) {}
	}
	notice := opts.OnNotice
	if notice == nil {
		notice = func(string) {}
	}
	var jobs []*dirJob
	defer func() {
		for _, j := range jobs {
			if j.f != nil {
				j.f.Close()
			}
		}
	}()

	// 1. Hash every file and work out its folder.
	for i := range files {
		out := &files[i]
		if opts.OnFile != nil {
			opts.OnFile(offset+i, total, out.Path)
		}
		abs := filepath.Join(root, filepath.FromSlash(out.Path))
		f, err := os.Open(abs)
		if err != nil {
			out.Error = fmt.Sprintf("cannot read it: %v", unwrapPath(err))
			continue
		}
		fi, err := f.Stat()
		if err != nil {
			f.Close()
			out.Error = err.Error()
			continue
		}
		name := filepath.Base(abs)
		sum, err := hashFile(ctx, f, fi.Size(), u.tick(), func(done int64) {
			report(Progress{Phase: PhaseHashing, Done: done, Total: fi.Size(), FileName: name})
		})
		if err != nil {
			f.Close()
			if ctx.Err() != nil {
				return err
			}
			out.Error = err.Error()
			continue
		}
		folder := ""
		if opts.Workspace != "" {
			dir := path.Dir(out.Path)
			if dir == "." {
				dir = ""
			}
			folder, err = folders.ensure(ctx, dir)
			if err != nil {
				f.Close()
				if ctx.Err() != nil {
					return err
				}
				out.Error = err.Error()
				continue
			}
			out.Folder = folders.label(dir)
		}
		jobs = append(jobs, &dirJob{out: out, abs: abs, f: f, size: fi.Size(), sha: sum, req: CreateUploadRequest{
			FileName: name, SizeBytes: fi.Size(), ContentType: ContentTypeFor(name), SHA256: sum,
			Access: opts.Access, Password: opts.Password, Workspace: opts.Workspace, Folder: folder,
		}})
	}
	if len(jobs) == 0 {
		return nil
	}

	// 2. One call opens them all.
	reqs := make([]CreateUploadRequest, len(jobs))
	for i, j := range jobs {
		reqs[i] = j.req
	}
	items, err := u.Client.CreateUploads(ctx, reqs)
	if err != nil {
		return err
	}

	// 3. Send each file's parts (a re-run's open session skips what storage has).
	var open []*dirJob
	for i, it := range items {
		j := jobs[i]
		if !it.OK {
			j.out.Error = it.Error
			if j.out.Error == "" {
				j.out.Error = fmt.Sprintf("refused (HTTP %d)", it.Status)
			}
			continue
		}
		name := filepath.Base(j.abs)
		j.job = &job{u: u, f: j.f, size: j.size, name: name, sha: j.sha, report: report, notice: notice,
			st: newStateStore("")}
		if it.Resumed {
			done, resumed, err := j.job.resume(ctx, &savedState{UploadID: it.UploadID, PartSize: it.PartSize})
			if err != nil {
				j.out.Error = err.Error()
				continue
			}
			if done != nil {
				j.out.setResult(done)
				continue
			}
			if !resumed {
				j.out.Error = "its upload session ended; run the command again to start it over"
				continue
			}
		} else {
			if err := j.job.setGeometry(it.PartSize); err != nil {
				j.out.Error = err.Error()
				continue
			}
			j.job.uploadID = it.UploadID
			j.job.done = map[int]UploadedPart{}
			j.job.setURLs(it.Parts)
		}
		if missing := j.job.missing(); len(missing) > 0 {
			if err := j.job.uploadParts(ctx, missing); err != nil {
				if ctx.Err() != nil {
					return err
				}
				j.out.Error = err.Error()
				continue
			}
		}
		report(Progress{Phase: PhaseVerifying, Done: j.size, Total: j.size, FileName: name})
		open = append(open, j)
	}
	if len(open) == 0 {
		return nil
	}

	// 4. One call completes them all; big files still being checked are polled.
	ids := make([]string, len(open))
	for i, j := range open {
		ids[i] = j.job.uploadID
	}
	results, err := u.Client.CompleteUploads(ctx, ids)
	if err != nil {
		return err
	}
	byID := map[string]BatchCompleteItem{}
	for _, r := range results {
		byID[r.UploadID] = r
	}
	for _, j := range open {
		r, ok := byID[j.job.uploadID]
		switch {
		case !ok:
			j.out.Error = "the server didn't answer for this file"
		case r.Status == http.StatusOK:
			res, err := ParseResult(r.Result)
			if err != nil {
				j.out.Error = err.Error()
			} else {
				j.out.setResult(res)
			}
		case r.Status == http.StatusAccepted:
			res, err := j.job.waitVerified(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return err
				}
				j.out.Error = err.Error()
			} else {
				j.out.setResult(res)
			}
		default:
			j.out.Error = r.Error
			if j.out.Error == "" {
				j.out.Error = fmt.Sprintf("couldn't be completed (%s)", r.State)
			}
		}
	}
	return nil
}

func (d *DirFile) setResult(r *Result) {
	d.Result, d.URL, d.Slug, d.Error = r, r.URL, r.Slug, ""
}

// folderMaker maps a local sub-folder ("specs/v2") to a folder of the
// workspace under base, creating what's missing, once per run.
type folderMaker struct {
	c    *Client
	ws   string
	base string // "" = the workspace's root; else a folder path or id that must exist

	loaded bool
	tree   []Folder
	ids    map[string]string // local dir → folder id (or base as given, for "")
}

func (m *folderMaker) label(dir string) string {
	switch {
	case m.base == "":
		return dir
	case dir == "":
		return m.base
	}
	return m.base + "/" + dir
}

func (m *folderMaker) ensure(ctx context.Context, dir string) (string, error) {
	if dir == "" {
		return m.base, nil // "" = the root; else the server resolves the path or id
	}
	if id, ok := m.ids[dir]; ok {
		return id, nil
	}
	if !m.loaded {
		t, err := m.c.Tree(ctx, m.ws)
		if err != nil {
			return "", err
		}
		m.tree, m.loaded, m.ids = t.Folders, true, map[string]string{}
	}
	parent := ""
	if m.base != "" {
		f := m.find(func(f Folder) bool { return f.ID == m.base || strings.EqualFold(f.Path, m.base) })
		if f == nil {
			return "", fmt.Errorf("the workspace has no folder %q (see markdrop workspaces)", m.base)
		}
		parent = f.ID
	}
	parentDir := path.Dir(dir)
	if parentDir != "." {
		id, err := m.ensure(ctx, parentDir)
		if err != nil {
			return "", err
		}
		parent = id
	}
	name := path.Base(dir)
	if f := m.find(func(f Folder) bool {
		return ptrEq(f.ParentID, parent) && (strings.EqualFold(f.Name, name) || strings.EqualFold(f.Slug, name))
	}); f != nil {
		m.ids[dir] = f.ID
		return f.ID, nil
	}
	f, err := m.c.CreateFolder(ctx, m.ws, name, parent)
	if err != nil {
		return "", err
	}
	if f.ParentID == nil && parent != "" {
		f.ParentID = &parent
	}
	m.tree = append(m.tree, *f)
	m.ids[dir] = f.ID
	return f.ID, nil
}

func (m *folderMaker) find(match func(Folder) bool) *Folder {
	for i := range m.tree {
		if match(m.tree[i]) {
			return &m.tree[i]
		}
	}
	return nil
}

func ptrEq(p *string, s string) bool {
	if p == nil {
		return s == ""
	}
	return *p == s
}
