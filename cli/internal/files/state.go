package files

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CacheDirEnv overrides where resumable upload sessions are remembered.
const CacheDirEnv = "MARKDROP_CACHE_DIR"

// staleAfter: saved sessions older than this are swept (the server keeps a
// session about 48 hours).
const staleAfter = 7 * 24 * time.Hour

// DefaultStateDir is <user cache dir>/markdrop/uploads (for example
// ~/Library/Caches/markdrop/uploads on macOS, ~/.cache/markdrop/uploads on
// Linux), or $MARKDROP_CACHE_DIR/uploads.
func DefaultStateDir() string {
	if d := strings.TrimSpace(os.Getenv(CacheDirEnv)); d != "" {
		return filepath.Join(d, "uploads")
	}
	d, err := os.UserCacheDir()
	if err != nil || d == "" {
		return ""
	}
	return filepath.Join(d, "markdrop", "uploads")
}

// savedState is one resumable session, stored as <key>.json. It holds no
// secrets: the upload id is useless without the owner's token.
type savedState struct {
	Format     int    `json:"format"`
	UploadID   string `json:"upload_id"`
	PartSize   int64  `json:"part_size"`
	Server     string `json:"server"`
	Path       string `json:"path"`
	Size       int64  `json:"size_bytes"`
	MtimeNS    int64  `json:"mtime_ns"`
	SHA256     string `json:"sha256"`
	TargetSlug string `json:"target_slug,omitempty"`
	CreatedAt  string `json:"created_at"`
	ExpiresAt  string `json:"expires_at,omitempty"`
}

type stateStore struct{ dir string }

func newStateStore(dir string) *stateStore { return &stateStore{dir: dir} }

// stateKey identifies "the same upload": same server, same file (absolute
// path, size, mtime, content) and the same request (target and options).
// The password is part of the hash only, never stored.
func stateKey(server, abs string, size, mtimeNS int64, sha string, req CreateUploadRequest) string {
	h := sha256.New()
	for _, part := range []string{
		strings.TrimRight(server, "/"), abs, fmt.Sprint(size), fmt.Sprint(mtimeNS), sha, req.TargetSlug,
		req.Title, req.Access, req.Password, req.Workspace, req.ContentType,
	} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	// Only when set, so uploads saved by older versions keep their keys.
	for _, kv := range [][2]string{{"folder", req.Folder}, {"slug", req.Slug}} {
		if kv[1] != "" {
			h.Write([]byte(kv[0] + "=" + kv[1]))
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func (s *stateStore) path(key string) string { return filepath.Join(s.dir, key+".json") }

func (s *stateStore) load(key string) *savedState {
	if s.dir == "" {
		return nil
	}
	data, err := os.ReadFile(s.path(key))
	if err != nil {
		return nil
	}
	var st savedState
	if json.Unmarshal(data, &st) != nil || st.UploadID == "" {
		_ = os.Remove(s.path(key))
		return nil
	}
	return &st
}

// save writes atomically (temp file + rename), 0600 in a 0700 folder.
// Failing to remember a session only costs resumability, so errors are
// ignored.
func (s *stateStore) save(key string, st *savedState) {
	if s.dir == "" {
		return
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return
	}
	s.sweep()
	st.Format = 1
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(s.dir, key+".*.tmp")
	if err != nil {
		return
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp.Name())
		return
	}
	_ = os.Chmod(tmp.Name(), 0o600)
	if err := os.Rename(tmp.Name(), s.path(key)); err != nil {
		_ = os.Remove(tmp.Name())
	}
}

func (s *stateStore) remove(key string) {
	if s.dir != "" {
		_ = os.Remove(s.path(key))
	}
}

// sweep deletes saved sessions (and stray temp files) older than staleAfter.
func (s *stateStore) sweep() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !(strings.HasSuffix(e.Name(), ".json") || strings.HasSuffix(e.Name(), ".tmp")) {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > staleAfter {
			_ = os.Remove(filepath.Join(s.dir, e.Name()))
		}
	}
}
