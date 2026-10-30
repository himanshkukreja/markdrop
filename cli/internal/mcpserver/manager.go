package mcpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/peer"
	"github.com/markdrop/cli/internal/signaling"
)

// States reported by share_status.
const (
	StateWaiting      = "waiting"
	StateConnecting   = "connecting"
	StateTransferring = "transferring"
	StateDone         = "done"
	StateStopped      = "stopped"
	StateError        = "error"
)

// noHostPatience is how long a receive keeps looking for a sender the server
// doesn't know yet (a restart, a sender still connecting) — as the browser does.
const noHostPatience = 60 * time.Second

// Config is what the manager needs from the command line and environment.
type Config struct {
	Server     string // API base URL
	Origin     string // WebSocket Origin header
	ShareURL   func(roomID string) string
	Token      string // MARKDROP_TOKEN or the saved login token, for share attribution
	Guard      *Guard
	Downloads  string // default receive directory
	Log        *log.Logger
	NewRoomID  func() string
	NewHostKey func() string

	// File publishing tools (upload_file, replace_file, …).
	FilesToken string // MARKDROP_TOKEN, or the token saved by `markdrop login`
	UserAgent  string // e.g. markdrop-cli/0.4.0
	// NewUploader builds the upload engine for a client; nil = defaults with
	// resumable state in the user cache dir. Tests shorten its timings.
	NewUploader func(*files.Client) *files.Uploader
}

// Manager owns every share and receive of this process. They live as long as
// the process: Shutdown says goodbye to every room.
type Manager struct {
	cfg Config

	mu       sync.Mutex
	shares   map[string]*share
	receives map[string]*receive
	closing  bool
	wg       sync.WaitGroup
}

// NewManager makes a manager.
func NewManager(cfg Config) *Manager {
	if cfg.Log == nil {
		cfg.Log = log.New(os.Stderr, "markdrop mcp: ", log.LstdFlags)
	}
	if cfg.Guard == nil {
		cfg.Guard = NewGuard()
	}
	if cfg.NewRoomID == nil {
		cfg.NewRoomID = func() string { return randomHex(6)[:10] }
	}
	if cfg.NewHostKey == nil {
		cfg.NewHostKey = func() string { return randomHex(16) }
	}
	if cfg.NewUploader == nil {
		cfg.NewUploader = func(c *files.Client) *files.Uploader {
			return &files.Uploader{Client: c, StateDir: files.DefaultStateDir()}
		}
	}
	return &Manager{cfg: cfg, shares: map[string]*share{}, receives: map[string]*receive{}}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// progress is shared by shares and receives.
type progress struct {
	mu       sync.Mutex
	state    string
	bytes    int64
	total    int64
	lastErr  string
	fileName string
}

func (p *progress) set(f func(p *progress)) {
	p.mu.Lock()
	f(p)
	p.mu.Unlock()
}

// ── Shares ──────────────────────────────────────────────────────────────────

type share struct {
	progress
	id, url   string
	src       *peer.Source
	sig       *signaling.Client
	started   time.Time
	cancel    context.CancelFunc
	done      chan struct{}
	served    int
	lastDone  time.Time
	signalOff bool // signalling socket is reconnecting
	stopOnce  sync.Once
}

// StartShare checks paths, packs them, connects to the signalling server as
// the room's host and starts serving recipients one after another.
func (m *Manager) StartShare(paths []string) (*ShareInfo, error) {
	if len(paths) == 0 {
		return nil, errors.New("give at least one file or folder path")
	}
	if len(paths) > 100 {
		return nil, errors.New("at most 100 paths per share; share a folder instead")
	}
	abs := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, p := range paths {
		a, err := m.cfg.Guard.CheckSharePath(p)
		if err != nil {
			return nil, err
		}
		if !seen[a] {
			seen[a] = true
			abs = append(abs, a)
		}
	}
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return nil, errors.New("the server is shutting down")
	}

	src, err := peer.SourceFromPaths(abs)
	if err != nil {
		return nil, err
	}
	if src.IsFolder && src.FileCount == 0 {
		src.Close()
		return nil, errors.New("nothing to share: the folder has no readable files")
	}

	id := m.cfg.NewRoomID()
	s := &share{id: id, url: m.cfg.ShareURL(id), src: src, started: time.Now(), done: make(chan struct{})}
	s.state = StateWaiting
	s.total = src.Size
	s.fileName = src.Name

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	sig, err := signaling.Dial(ctx, signaling.Options{
		Server: m.cfg.Server, Room: id, Role: "host", Origin: m.cfg.Origin,
		HostKey: m.cfg.NewHostKey(), Reconnect: true,
		OnState: func(up bool) {
			s.set(func(*progress) { s.signalOff = !up })
			if up {
				m.cfg.Log.Printf("share %s: signalling reconnected", id)
			} else {
				m.cfg.Log.Printf("share %s: signalling dropped, reconnecting", id)
			}
		},
	})
	if err != nil {
		cancel()
		src.Close()
		return nil, fmt.Errorf("could not reach the Markdrop signalling server: %w", err)
	}
	s.sig = sig

	m.mu.Lock()
	m.shares[id] = s
	m.wg.Add(1)
	m.mu.Unlock()
	m.cfg.Log.Printf("share %s: serving %s (%d files, %d bytes)", id, src.Name, src.FileCount, src.Size)
	go func() {
		defer m.wg.Done()
		m.runShare(ctx, s)
	}()
	info := m.shareInfo(s)
	return &info, nil
}

func (m *Manager) blob(src *peer.Source) string {
	if m.cfg.Token == "" {
		return ""
	}
	return peer.EncodeShareMeta(peer.ShareMeta{
		Name: src.Name, Size: src.Size, Mime: src.MimeType, Token: m.cfg.Token, Count: src.FileCount,
	})
}

// runShare serves recipients one at a time (protocol v1 rooms hold one guest)
// until stopped.
func (m *Manager) runShare(ctx context.Context, s *share) {
	defer close(s.done)
	defer s.src.Close()
	defer s.sig.Close()
	blob := m.blob(s.src)
	msgs := s.sig.Messages()
	// pending: the next recipient joined while the last was still being served
	// (the server announces a guest once, so it must not be waited for again).
	pending := false

	for {
		s.set(func(p *progress) { p.state = StateWaiting; p.bytes = 0 })
		// Wait for a recipient.
	wait:
		for !pending {
			select {
			case raw, ok := <-msgs:
				if !ok {
					m.failShare(s, s.sig.Err())
					return
				}
				if msgType(raw) == "guest-joined" {
					break wait
				}
			case <-ctx.Done():
				return
			}
		}
		pending = false

		for {
			s.set(func(p *progress) { p.state = StateConnecting; p.bytes = 0 })
			err := peer.ServeOne(ctx, s.sig, s.src, peer.HostOptions{
				Blob:       blob,
				OnLateJoin: func(joined bool) { pending = joined },
				OnStart:    func() { s.set(func(p *progress) { p.state = StateTransferring }) },
				OnProgress: func(sent, total int64) {
					s.set(func(p *progress) { p.bytes = sent; p.total = total })
				},
			})
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				s.set(func(p *progress) { s.served++; s.lastDone = time.Now() })
				m.cfg.Log.Printf("share %s: recipient %d done", s.id, s.served)
				break
			}
			if errors.Is(err, peer.ErrRenegotiate) {
				continue
			}
			s.set(func(p *progress) { p.lastErr = err.Error() })
			m.cfg.Log.Printf("share %s: %v", s.id, err)
			select {
			case <-s.sig.Done:
				m.failShare(s, s.sig.Err())
				return
			default:
			}
			break
		}
	}
}

func (m *Manager) failShare(s *share, err error) {
	if err == nil {
		err = errors.New("signalling connection closed")
	}
	s.set(func(p *progress) {
		if p.state != StateStopped {
			p.state = StateError
			p.lastErr = err.Error()
		}
	})
	m.cfg.Log.Printf("share %s: stopped by error: %v", s.id, err)
}

// StopShare ends a share: recipients are told at once ("bye"), the room is
// closed. Stopping a stopped share is fine. A receive id cancels the download.
func (m *Manager) StopShare(id string) (*StopResult, error) {
	m.mu.Lock()
	s := m.shares[id]
	r := m.receives[id]
	m.mu.Unlock()
	switch {
	case s != nil:
		m.stopShare(s)
		s.mu.Lock()
		defer s.mu.Unlock()
		return &StopResult{ID: id, Kind: "share", State: s.state, RecipientsServed: s.served}, nil
	case r != nil:
		r.stop()
		<-waitOr(r.done, 5*time.Second)
		r.mu.Lock()
		defer r.mu.Unlock()
		return &StopResult{ID: id, Kind: "receive", State: r.state}, nil
	}
	return nil, fmt.Errorf("no share or receive with id %q in this session (share_status lists them)", id)
}

func (m *Manager) stopShare(s *share) {
	s.stopOnce.Do(func() {
		s.set(func(p *progress) {
			if p.state != StateError {
				p.state = StateStopped
			}
		})
		// Tell recipients first, while the socket is still ours.
		_ = s.sig.WriteJSON(map[string]string{"type": "bye"})
		s.cancel()
		<-waitOr(s.done, 5*time.Second)
		s.set(func(p *progress) {
			if p.state != StateError {
				p.state = StateStopped
			}
		})
		m.cfg.Log.Printf("share %s: stopped", s.id)
	})
}

// ── Receives ────────────────────────────────────────────────────────────────

type receive struct {
	progress
	id, link, room, dir string
	started             time.Time
	saved               []string
	cancel              context.CancelFunc
	done                chan struct{}
}

func (r *receive) stop() { r.cancel() }

// StartReceive validates the link and directory and starts downloading in the
// background.
func (m *Manager) StartReceive(link, dir string) (*ReceiveInfo, error) {
	room, err := ParseShareLink(link)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(dir) == "" {
		dir = m.cfg.Downloads
	}
	abs, err := m.cfg.Guard.CheckReceiveDir(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create %s: %w", abs, unwrapPathErr(err))
	}
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return nil, errors.New("the server is shutting down")
	}

	ctx, cancel := context.WithCancel(context.Background())
	r := &receive{
		id: "recv-" + randomHex(4), link: strings.TrimSpace(link), room: room, dir: abs,
		started: time.Now(), cancel: cancel, done: make(chan struct{}),
	}
	r.state = StateConnecting
	m.mu.Lock()
	m.receives[r.id] = r
	m.wg.Add(1)
	m.mu.Unlock()
	m.cfg.Log.Printf("%s: receiving share %s into %s", r.id, room, abs)
	go func() {
		defer m.wg.Done()
		defer close(r.done)
		m.runReceive(ctx, r)
	}()
	info := m.receiveInfo(r)
	return &info, nil
}

func (m *Manager) runReceive(ctx context.Context, r *receive) {
	first := time.Now()
	for {
		res, err := m.receiveOnce(ctx, r)
		if err == nil {
			r.set(func(p *progress) {
				p.state = StateDone
				r.saved = res.Saved
				if p.total > 0 {
					p.bytes = p.total
				}
			})
			m.cfg.Log.Printf("%s: saved %s", r.id, strings.Join(res.Saved, ", "))
			return
		}
		if ctx.Err() != nil {
			r.set(func(p *progress) { p.state = StateStopped })
			return
		}
		if errors.Is(err, peer.ErrNoHost) && time.Since(first) < noHostPatience {
			r.set(func(p *progress) { p.state = StateWaiting; p.lastErr = err.Error() })
			select {
			case <-time.After(3 * time.Second):
				continue
			case <-ctx.Done():
				r.set(func(p *progress) { p.state = StateStopped })
				return
			}
		}
		r.set(func(p *progress) { p.state = StateError; p.lastErr = err.Error() })
		m.cfg.Log.Printf("%s: %v", r.id, err)
		return
	}
}

func (m *Manager) receiveOnce(ctx context.Context, r *receive) (*peer.GuestResult, error) {
	sig, err := signaling.Dial(ctx, signaling.Options{Server: m.cfg.Server, Room: r.room, Role: "guest", Origin: m.cfg.Origin})
	if err != nil {
		return nil, fmt.Errorf("could not reach the Markdrop signalling server: %w", err)
	}
	defer sig.Close()
	r.set(func(p *progress) { p.state = StateConnecting })
	return peer.Receive(ctx, sig, peer.GuestOptions{
		OutputDir:   r.dir,
		NoOverwrite: true,
		NoDotfiles:  true,
		OnMeta: func(fm peer.FileMeta) {
			r.set(func(p *progress) {
				p.state = StateTransferring
				p.fileName = fm.Name
				p.total = fm.Size
				p.lastErr = ""
			})
		},
		OnProgress: func(got, total int64) {
			r.set(func(p *progress) { p.bytes = got; p.total = total })
		},
		OnWaiting: func() {
			r.set(func(p *progress) { p.state = StateWaiting; p.lastErr = "the sender is away; waiting for them to come back" })
		},
	})
}

// ── Status ──────────────────────────────────────────────────────────────────

// Status lists every share and receive (or the one with id).
func (m *Manager) Status(id string) (*StatusOutput, error) {
	m.mu.Lock()
	shares := make([]*share, 0, len(m.shares))
	for _, s := range m.shares {
		if id == "" || s.id == id {
			shares = append(shares, s)
		}
	}
	receives := make([]*receive, 0, len(m.receives))
	for _, r := range m.receives {
		if id == "" || r.id == id {
			receives = append(receives, r)
		}
	}
	m.mu.Unlock()
	if id != "" && len(shares) == 0 && len(receives) == 0 {
		return nil, fmt.Errorf("no share or receive with id %q in this session", id)
	}
	sort.Slice(shares, func(i, j int) bool { return shares[i].started.After(shares[j].started) })
	sort.Slice(receives, func(i, j int) bool { return receives[i].started.After(receives[j].started) })
	out := &StatusOutput{Shares: []ShareInfo{}, Receives: []ReceiveInfo{}}
	for _, s := range shares {
		out.Shares = append(out.Shares, m.shareInfo(s))
	}
	for _, r := range receives {
		out.Receives = append(out.Receives, m.receiveInfo(r))
	}
	return out, nil
}

func makeProgress(bytes, total int64) Progress {
	pct := 0.0
	if total > 0 {
		pct = float64(bytes) * 100 / float64(total)
		if pct > 100 {
			pct = 100
		}
		pct = float64(int(pct*10)) / 10
	}
	return Progress{Bytes: bytes, Total: total, Percent: pct}
}

func (m *Manager) shareInfo(s *share) ShareInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := ShareInfo{
		ShareID: s.id, URL: s.url, FileName: s.src.Name, FileCount: s.src.FileCount, TotalBytes: s.src.Size,
		State: s.state, Progress: makeProgress(s.bytes, s.total), RecipientsServed: s.served,
		LastError: s.lastErr, StartedAt: s.started.UTC().Format(time.RFC3339),
		SignallingReconnecting: s.signalOff && (s.state == StateWaiting || s.state == StateConnecting),
	}
	if !s.lastDone.IsZero() {
		info.LastCompletedAt = s.lastDone.UTC().Format(time.RFC3339)
	}
	return info
}

func (m *Manager) receiveInfo(r *receive) ReceiveInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	info := ReceiveInfo{
		ReceiveID: r.id, Link: r.link, State: r.state, FileName: r.fileName,
		Progress: makeProgress(r.bytes, r.total), Directory: r.dir, SavedTo: append([]string{}, r.saved...),
		LastError: r.lastErr, StartedAt: r.started.UTC().Format(time.RFC3339),
	}
	if r.state == StateDone {
		info.LastError = ""
	}
	return info
}

// Shutdown says goodbye to every room and cancels every download, waiting up
// to timeout.
func (m *Manager) Shutdown(timeout time.Duration) {
	m.mu.Lock()
	m.closing = true
	shares := make([]*share, 0, len(m.shares))
	for _, s := range m.shares {
		shares = append(shares, s)
	}
	receives := make([]*receive, 0, len(m.receives))
	for _, r := range m.receives {
		receives = append(receives, r)
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, s := range shares {
		wg.Add(1)
		go func() { defer wg.Done(); m.stopShare(s) }()
	}
	for _, r := range receives {
		r.stop()
	}
	all := make(chan struct{})
	go func() { wg.Wait(); m.wg.Wait(); close(all) }()
	<-waitOr(all, timeout)
}

func waitOr(ch <-chan struct{}, d time.Duration) <-chan struct{} {
	out := make(chan struct{})
	go func() {
		select {
		case <-ch:
		case <-time.After(d):
		}
		close(out)
	}()
	return out
}

func msgType(raw []byte) string {
	var hdr struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(raw, &hdr)
	return hdr.Type
}
