package peer

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/pion/webrtc/v3"
)

// FileMeta holds the metadata received from the host before download starts.
type FileMeta struct {
	Name     string
	Size     int64
	MimeType string
	IsFolder bool
}

// GuestOptions tune one download.
type GuestOptions struct {
	OutputDir  string // "" → current directory
	OutputFile string // "" → the sender's file name
	// NoOverwrite saves under a fresh name ("x (1).pdf") instead of replacing
	// an existing file or folder.
	NoOverwrite bool
	// NoDotfiles strips leading dots from what lands in OutputDir, so a sender
	// can't plant ".bashrc" or ".ssh" there.
	NoDotfiles bool
	// Confirm is asked before the download starts; nil accepts. It runs on its
	// own goroutine and may block (e.g. on a terminal prompt).
	Confirm    func(FileMeta) bool
	OnMeta     func(FileMeta)
	OnProgress func(received, total int64)
	// OnWaiting is called when the sender's signalling went away before we
	// connected; we wait up to SenderGrace for it to come back.
	OnWaiting   func()
	SenderGrace time.Duration
}

// GuestResult says where the download landed.
type GuestResult struct {
	Meta  FileMeta
	Saved []string // the file, or the top-level entries extracted from a folder
}

// ErrNoHost means nobody is sharing on the link.
var ErrNoHost = errors.New("no sender found: the link may be wrong, or the sender has stopped sharing")

// ErrRoomBusy means a one-recipient-at-a-time sender is serving someone else.
var ErrRoomBusy = errors.New("someone else is receiving from this sender right now; try again when they are done")

// ErrRejected means Confirm said no.
var ErrRejected = errors.New("download rejected by user")

// defaultSenderGrace matches the server's hold on a room whose sender dropped
// (KEY_HOLD_SECONDS in backend/app/routers/share.py) and the browser's wait.
const defaultSenderGrace = 10 * time.Minute

type guestResult struct {
	res *GuestResult
	err error
}

// Receive connects as a guest, performs the WebRTC handshake, waits for the
// file metadata, asks Confirm, then downloads the file into OutputDir (and
// unpacks it when the sender marked it as a folder).
func Receive(ctx context.Context, sig *signaling.Client, o GuestOptions) (*GuestResult, error) {
	done := make(chan guestResult, 1)
	finish := func(r guestResult) {
		select {
		case done <- r:
		default:
		}
	}
	grace := o.SenderGrace
	if grace <= 0 {
		grace = defaultSenderGrace
	}

	// established flips once the DataChannel delivered the metadata. After that
	// the signalling WebSocket is no longer critical.
	var established atomic.Bool
	var pc *webrtc.PeerConnection
	defer func() {
		if pc != nil {
			_ = pc.Close()
		}
	}()
	var graceC <-chan time.Time
	msgs := sig.Messages()
	// lastRx is when the last chunk (or the start) went by; 0 until started.
	var lastRx atomic.Int64
	watchdog := time.NewTicker(time.Second)
	defer watchdog.Stop()

	for {
		select {
		case <-watchdog.C:
			if t := lastRx.Load(); t != 0 && time.Since(time.Unix(0, t)) > stallLimit {
				return nil, fmt.Errorf("transfer stalled: nothing arrived for %s", stallLimit)
			}
		case raw, ok := <-msgs:
			if !ok {
				if established.Load() {
					msgs = nil
					continue
				}
				if e := sig.Err(); e != nil {
					return nil, fmt.Errorf("signalling disconnected: %w", e)
				}
				return nil, errors.New("signalling disconnected")
			}
			var hdr struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &hdr) != nil {
				continue
			}
			switch hdr.Type {
			case "no-host":
				return nil, ErrNoHost
			case "room-busy":
				return nil, ErrRoomBusy
			case "room-full":
				return nil, errors.New("too many people are downloading from this sender right now; try again shortly")
			case "room-closed":
				return nil, errors.New("the sender stopped sharing")
			case "offer":
				var m sdpMsg
				if err := json.Unmarshal(raw, &m); err != nil {
					return nil, fmt.Errorf("parse offer: %w", err)
				}
				if established.Load() {
					continue // already connected; a stale renegotiation
				}
				graceC = nil
				if pc != nil {
					_ = pc.Close()
				}
				var err error
				pc, err = newPeerConnection(sig.ICEServers())
				if err != nil {
					return nil, fmt.Errorf("create peer connection: %w", err)
				}
				pc.OnICECandidate(func(c *webrtc.ICECandidate) {
					if c != nil {
						_ = sig.WriteJSON(iceMsg{Type: "ice", Candidate: c.ToJSON()})
					}
				})
				thisPC := pc
				pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
					if s == webrtc.PeerConnectionStateFailed && thisPC == pc {
						finish(guestResult{err: errors.New("couldn't connect the two devices (no direct or relayed route)")})
					}
				})
				pc.OnDataChannel(func(dc *webrtc.DataChannel) {
					handleIncomingChannel(dc, o, finish, &established, &lastRx)
				})
				if err = pc.SetRemoteDescription(m.SDP); err != nil {
					return nil, fmt.Errorf("set remote description: %w", err)
				}
				answer, err := pc.CreateAnswer(nil)
				if err != nil {
					return nil, fmt.Errorf("create answer: %w", err)
				}
				if err = pc.SetLocalDescription(answer); err != nil {
					return nil, fmt.Errorf("set local description: %w", err)
				}
				if err = sig.WriteJSON(sdpMsg{Type: "answer", SDP: *pc.LocalDescription()}); err != nil {
					return nil, fmt.Errorf("send answer: %w", err)
				}
			case "ice":
				if pc == nil {
					continue
				}
				var m iceMsg
				if json.Unmarshal(raw, &m) == nil {
					_ = pc.AddICECandidate(m.Candidate)
				}
			case "peer-disconnected":
				// The sender's signalling dropped (or we joined a room whose
				// sender is away). Once connected that is irrelevant; before,
				// wait for it to come back and offer again.
				if established.Load() {
					continue
				}
				if pc != nil {
					_ = pc.Close()
					pc = nil
				}
				if graceC == nil {
					graceC = time.After(grace)
					if o.OnWaiting != nil {
						o.OnWaiting()
					}
				}
			}
		case <-graceC:
			return nil, errors.New("the sender went away and did not come back")
		case r := <-done:
			return r.res, r.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// handleIncomingChannel wires up DataChannel message handlers for the guest.
// It receives the meta JSON, asks Confirm, then receives binary chunks and
// writes them to disk.
func handleIncomingChannel(
	dc *webrtc.DataChannel,
	o GuestOptions,
	finish func(guestResult),
	established *atomic.Bool,
	lastRx *atomic.Int64,
) {
	var (
		meta      FileMeta
		tmpPath   string
		finalPath string
		tmpFile   *os.File
		received  int64
		completed atomic.Bool
	)
	outDir := o.OutputDir
	if outDir == "" {
		outDir = "."
	}

	dc.OnError(func(err error) {
		if completed.Load() {
			return
		}
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			finish(guestResult{err: errors.New("the sender closed the connection before the transfer finished")})
			return
		}
		finish(guestResult{err: fmt.Errorf("data channel error: %w", err)})
	})
	dc.OnClose(func() {
		if !completed.Load() {
			if tmpFile != nil {
				_ = tmpFile.Close()
				_ = os.Remove(tmpPath)
			}
			finish(guestResult{err: errors.New("the sender closed the connection before the transfer finished")})
		}
	})

	complete := func() {
		completed.Store(true)
		lastRx.Store(0) // saving (or unzipping) may take a while; not a stall
		if tmpFile != nil {
			_ = tmpFile.Close()
			tmpFile = nil
		}
		res, err := saveDownload(tmpPath, finalPath, outDir, meta, o)
		finish(guestResult{res: res, err: err})
	}

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if msg.IsString {
			var inner struct {
				Type     string `json:"type"`
				Name     string `json:"name"`
				Size     int64  `json:"size"`
				MimeType string `json:"mimeType"`
				IsFolder bool   `json:"isFolder"`
			}
			if json.Unmarshal(msg.Data, &inner) != nil {
				return
			}
			switch inner.Type {
			case "ping":
				_ = dc.SendText(`{"type":"pong"}`)
				return
			case "bye":
				if !completed.Load() {
					finish(guestResult{err: errors.New("the sender stopped sharing")})
				}
				return
			case "meta":
			default:
				return
			}
			if tmpFile != nil || completed.Load() {
				return // one file per connection in protocol v1
			}
			if inner.Size < 0 {
				finish(guestResult{err: errors.New("sender announced a negative size")})
				return
			}
			meta = FileMeta{Name: SafeFileName(inner.Name, o.NoDotfiles), Size: inner.Size, MimeType: inner.MimeType, IsFolder: inner.IsFolder}
			if o.OnMeta != nil {
				o.OnMeta(meta)
			}

			name := meta.Name
			if o.OutputFile != "" {
				name = o.OutputFile
			}
			finalPath = filepath.Join(outDir, name)
			if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
				finish(guestResult{err: err})
				return
			}
			f, err := os.CreateTemp(filepath.Dir(finalPath), ".markdrop-*.part")
			if err != nil {
				finish(guestResult{err: fmt.Errorf("create output file: %w", err)})
				return
			}
			tmpFile, tmpPath = f, f.Name()
			established.Store(true)

			// Ask and send "start" off the callback: blocking inside OnMessage
			// stops pion processing SCTP keepalives, which closes the channel
			// while a person reads the prompt.
			go func(m FileMeta, f *os.File, p string) {
				if o.Confirm != nil && !o.Confirm(m) {
					_ = f.Close()
					_ = os.Remove(p)
					completed.Store(true)
					finish(guestResult{err: ErrRejected})
					return
				}
				if serr := dc.SendText(`{"type":"start"}`); serr != nil {
					finish(guestResult{err: fmt.Errorf("send start signal: %w", serr)})
					return
				}
				if !completed.Load() {
					lastRx.Store(time.Now().UnixNano())
				}
				if m.Size == 0 {
					complete() // no chunks will come
				}
			}(meta, f, tmpPath)
			return
		}

		// Binary chunk — write to temp file.
		if tmpFile == nil || completed.Load() {
			return
		}
		if _, werr := tmpFile.Write(msg.Data); werr != nil {
			finish(guestResult{err: fmt.Errorf("write chunk: %w", werr)})
			return
		}
		received += int64(len(msg.Data))
		lastRx.Store(time.Now().UnixNano())
		if o.OnProgress != nil {
			o.OnProgress(received, meta.Size)
		}
		if received >= meta.Size {
			complete()
		}
	})
}

// saveDownload moves the finished temp file into place, unpacking folders.
func saveDownload(tmpPath, finalPath, outDir string, meta FileMeta, o GuestOptions) (*GuestResult, error) {
	res := &GuestResult{Meta: meta}
	target := finalPath
	if o.NoOverwrite {
		target = UniquePath(finalPath)
	}
	if err := os.Rename(tmpPath, target); err != nil {
		if cerr := copyFile(tmpPath, target); cerr != nil {
			_ = os.Remove(tmpPath)
			return nil, fmt.Errorf("save file: %w", cerr)
		}
		_ = os.Remove(tmpPath)
	}
	if !meta.IsFolder {
		res.Saved = []string{target}
		return res, nil
	}
	// A folder (or several files) arrives as a zip the sender marked for
	// unpacking.
	var saved []string
	var err error
	if o.NoOverwrite || o.NoDotfiles {
		saved, err = unzipFresh(target, outDir, o.NoDotfiles)
	} else {
		saved, err = unzipTo(target, outDir)
	}
	if err != nil {
		return nil, fmt.Errorf("extract folder: %w (the zip is kept at %s)", err, target)
	}
	_ = os.Remove(target)
	res.Saved = saved
	return res, nil
}

// SafeFileName reduces a sender-supplied name to a plain file name: no
// directories, no "..", optionally no leading dots.
func SafeFileName(name string, noDotfiles bool) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = filepath.Base(filepath.FromSlash(name))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == ':' && os.PathSeparator == '\\' {
			return '_'
		}
		return r
	}, name)
	if noDotfiles {
		name = strings.TrimLeft(name, ".")
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || name == string(filepath.Separator) {
		return "download"
	}
	return name
}

// UniquePath returns p, or "name (1).ext", "name (2).ext", … if p exists.
func UniquePath(p string) string {
	if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
		return p
	}
	dir, base := filepath.Split(p)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if strings.HasSuffix(stem, ".tar") { // keep "x.tar.gz" together
		stem = strings.TrimSuffix(stem, ".tar")
		ext = ".tar" + ext
	}
	for i := 1; ; i++ {
		cand := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if _, err := os.Lstat(cand); errors.Is(err, os.ErrNotExist) {
			return cand
		}
	}
}

// copyFile is a fallback for cross-device rename.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err = io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// unzipTo extracts the zip archive at zipPath into destDir, preserving the
// internal directory structure (and replacing what is there — `markdrop get`'s
// behaviour). It returns the top-level entries.
func unzipTo(zipPath, destDir string) ([]string, error) {
	return extract(zipPath, destDir)
}

// unzipFresh extracts into a scratch folder inside destDir, then moves each
// top-level entry into destDir under a name nothing else has.
func unzipFresh(zipPath, destDir string, noDotfiles bool) ([]string, error) {
	scratch, err := os.MkdirTemp(destDir, ".markdrop-extract-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(scratch)
	tops, err := extract(zipPath, scratch)
	if err != nil {
		return nil, err
	}
	var saved []string
	for _, t := range tops {
		name := SafeFileName(filepath.Base(t), noDotfiles)
		dst := UniquePath(filepath.Join(destDir, name))
		if err := os.Rename(t, dst); err != nil {
			return saved, err
		}
		saved = append(saved, dst)
	}
	return saved, nil
}

// extract unpacks zipPath into destDir, guarding against zip-slip, and returns
// the paths of the top-level entries in archive order.
func extract(zipPath, destDir string) ([]string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()

	root, err := filepath.Abs(destDir)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var tops []string

	for _, f := range r.File {
		rel := filepath.FromSlash(strings.ReplaceAll(f.Name, "\\", "/"))
		target := filepath.Join(root, rel)
		if rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(filepath.ToSlash(rel), "../") ||
			(target != root && !strings.HasPrefix(target, root+string(filepath.Separator))) {
			return tops, fmt.Errorf("invalid path in zip: %q", f.Name)
		}
		if target == root {
			continue
		}
		top := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		if !seen[top] {
			seen[top] = true
			tops = append(tops, filepath.Join(root, top))
		}

		mode := f.Mode()
		if f.FileInfo().IsDir() {
			if err = os.MkdirAll(target, mode.Perm()|0o700); err != nil {
				return tops, err
			}
			continue
		}
		if !mode.IsRegular() {
			continue // never create links or special files from an archive
		}
		if err = os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return tops, err
		}
		rc, err := f.Open()
		if err != nil {
			return tops, err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode.Perm()|0o600)
		if err != nil {
			rc.Close()
			return tops, err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return tops, err
		}
	}
	return tops, nil
}

// formatBytes converts a byte count to a human-readable string.
func formatBytes(b int64) string {
	switch {
	case b < 1_024:
		return fmt.Sprintf("%d B", b)
	case b < 1_048_576:
		return fmt.Sprintf("%.1f KB", float64(b)/1_024)
	case b < 1_073_741_824:
		return fmt.Sprintf("%.1f MB", float64(b)/1_048_576)
	default:
		return fmt.Sprintf("%.2f GB", float64(b)/1_073_741_824)
	}
}

// FormatBytes is formatBytes for other packages.
func FormatBytes(b int64) string { return formatBytes(b) }
