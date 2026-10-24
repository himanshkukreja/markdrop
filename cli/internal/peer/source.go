package peer

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// BundleName is the folder a multi-file share unpacks into. It matches the
// browser's ZIP_FOLDER (frontend/src/lib/p2p/zip.ts), so a recipient gets the
// same thing whichever app the sender used.
const BundleName = "markdrop-files"

// Source is one file a host serves: the file itself, or a zip of a folder or
// of several paths that the recipient's CLI extracts (IsFolder).
type Source struct {
	Path      string // file streamed to the recipient
	Name      string // name the recipient sees
	Size      int64
	MimeType  string
	IsFolder  bool // a zip the CLI receiver unpacks
	FileCount int  // files inside (1 for a plain file)
	// FirstName / FirstMime describe the first file shared, as the browser's
	// share metadata does for several files.
	FirstName string
	FirstMime string

	tmp string // temp zip to delete on Close
}

// Close removes any temporary zip.
func (s *Source) Close() {
	if s != nil && s.tmp != "" {
		_ = os.Remove(s.tmp)
		s.tmp = ""
	}
}

// SourceFromPath is what `markdrop send` serves: a file as-is, a folder zipped
// under its own name.
func SourceFromPath(path string) (*Source, error) {
	return SourceFromPaths([]string{path})
}

// SourceFromPaths builds a Source from one or more files or folders:
//   - one file: sent as-is;
//   - one folder: zipped as <folder>.zip with the folder at the top;
//   - several paths: zipped as markdrop-files.zip with each path inside
//     markdrop-files/ (clashing names get " (2)", " (3)", …).
//
// Only regular files are included. Symlinks to files are followed; symlinks to
// folders, sockets, pipes and devices are skipped (a pipe would block forever).
func SourceFromPaths(paths []string) (*Source, error) {
	if len(paths) == 0 {
		return nil, errors.New("no paths given")
	}
	if len(paths) == 1 {
		p := paths[0]
		fi, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot access %q: %w", p, err)
		}
		if fi.Mode().IsRegular() {
			mt := mimeFor(p)
			return &Source{
				Path: p, Name: filepath.Base(p), Size: fi.Size(), MimeType: mt,
				FileCount: 1, FirstName: filepath.Base(p), FirstMime: mt,
			}, nil
		}
		if !fi.IsDir() {
			return nil, fmt.Errorf("%q is not a regular file or folder", p)
		}
		base := filepath.Base(filepath.Clean(p))
		return zipSource([]zipRoot{{path: p, name: base}}, base)
	}

	roots := make([]zipRoot, 0, len(paths))
	used := map[string]bool{}
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("cannot access %q: %w", p, err)
		}
		if !fi.IsDir() && !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("%q is not a regular file or folder", p)
		}
		name := uniqueName(filepath.Base(filepath.Clean(p)), used)
		roots = append(roots, zipRoot{path: p, name: BundleName + "/" + name})
	}
	return zipSource(roots, BundleName)
}

type zipRoot struct {
	path string // on disk
	name string // inside the archive (forward slashes)
}

func zipSource(roots []zipRoot, base string) (*Source, error) {
	tmp, err := os.CreateTemp("", "markdrop-"+sanitizeTemp(base)+"-*.zip")
	if err != nil {
		return nil, fmt.Errorf("compress: %w", err)
	}
	src := &Source{Path: tmp.Name(), Name: base + ".zip", MimeType: "application/zip", IsFolder: true, tmp: tmp.Name()}
	zw := zip.NewWriter(tmp)
	n, first, werr := writeZip(zw, roots)
	cerr := zw.Close()
	ferr := tmp.Close()
	if err = errors.Join(werr, cerr, ferr); err != nil {
		src.Close()
		return nil, fmt.Errorf("compress: %w", err)
	}
	fi, err := os.Stat(src.Path)
	if err != nil {
		src.Close()
		return nil, fmt.Errorf("compress: %w", err)
	}
	src.Size = fi.Size()
	src.FileCount = n
	src.FirstName = first
	src.FirstMime = mimeFor(first)
	if first == "" {
		src.FirstName = src.Name
		src.FirstMime = "application/zip"
	}
	return src, nil
}

// writeZip adds every regular file under roots. It returns how many files it
// wrote and the base name of the first.
func writeZip(zw *zip.Writer, roots []zipRoot) (int, string, error) {
	count := 0
	first := ""
	addFile := func(diskPath, name string) error {
		f, err := os.Open(diskPath)
		if err != nil {
			return err
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		if _, err = io.Copy(w, f); err != nil {
			return err
		}
		if count == 0 {
			first = filepath.Base(diskPath)
		}
		count++
		return nil
	}

	for _, r := range roots {
		fi, err := os.Stat(r.path)
		if err != nil {
			return count, first, err
		}
		if fi.Mode().IsRegular() {
			if err := addFile(r.path, r.name); err != nil {
				return count, first, err
			}
			continue
		}
		root := filepath.Clean(r.path)
		err = filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return werr
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			name := r.name
			if rel != "." {
				name = r.name + "/" + filepath.ToSlash(rel)
			}
			switch {
			case d.IsDir():
				_, err = zw.Create(name + "/")
				return err
			case d.Type()&fs.ModeSymlink != 0:
				fi, serr := os.Stat(p)
				if serr != nil || !fi.Mode().IsRegular() {
					return nil // dangling, or a link to a folder: skip
				}
				return addFile(p, name)
			case d.Type().IsRegular():
				return addFile(p, name)
			default:
				return nil // socket, pipe, device
			}
		})
		if err != nil {
			return count, first, err
		}
	}
	return count, first, nil
}

func uniqueName(name string, used map[string]bool) string {
	if !used[name] {
		used[name] = true
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if !used[cand] {
			used[cand] = true
			return cand
		}
	}
}

func mimeFor(name string) string {
	if mt := mime.TypeByExtension(filepath.Ext(name)); mt != "" {
		return mt
	}
	return "application/octet-stream"
}

func sanitizeTemp(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '*' || r == 0 {
			return '_'
		}
		return r
	}, s)
}
