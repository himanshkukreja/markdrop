// Package signaling provides a thin WebSocket client that relays JSON messages
// between WebRTC peers through the markdrop signalling server.
//
// The server never sees file bytes; it only forwards SDP offers/answers,
// ICE candidates, and small control signals (guest-joined, start, meta, …)
// between two peers so they can establish a direct WebRTC DataChannel.
//
// Every socket is sent {"type":"config","iceServers":[...]} first. The client
// keeps that list (STUN plus short-lived TURN credentials when the server has
// them) for the peer connection; it is never handed to the caller as a message.
package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/stun"
	"github.com/pion/webrtc/v3"
)

// Close codes the server uses (see backend/app/routers/share.py).
const (
	CloseDuplicateHost = 4000
	CloseNoHost        = 4001
	CloseBadRole       = 4002
	CloseRoomBusy      = 4003
	CloseBadRoom       = 4004
	CloseServerFull    = 4005
	CloseRoomFull      = 4006
	CloseReplaced      = 4007
)

// pingInterval keeps nginx's idle timeout from closing a sender who is still
// waiting for someone to open the link. The server ignores pings.
const pingInterval = 25 * time.Second

// ConfigWait is how long ICEServers waits for the server's config message
// before falling back to public STUN (an older backend never sends it).
var ConfigWait = 3 * time.Second

// backoff is the delay before each reconnect attempt (the last one repeats).
var backoff = []time.Duration{
	500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second,
}

// Options describe one signalling connection.
type Options struct {
	Server string // API base URL, http(s) or ws(s)
	Room   string
	Role   string // "host" or "guest"
	Origin string // must match a CORS origin the backend allows
	// HostKey (hosts only, 32+ hex) proves this process owns the room, so a
	// dropped socket can take the room straight back on reconnect.
	HostKey string
	// Reconnect makes a host redial with backoff whenever its socket drops,
	// until Close or a refusal a retry can't fix.
	Reconnect bool
	// OnState, if set, is told when the socket goes down (false) and when it
	// is back (true). Called from the client's own goroutine.
	OnState func(connected bool)
}

// Msg is a generic JSON envelope exchanged on the signalling channel.
type Msg struct {
	Type string          `json:"type"`
	Raw  json.RawMessage `json:"-"` // full original bytes
}

// Client is a thread-safe WebSocket signalling client. One goroutine reads the
// socket and delivers every message except config and pings on Messages().
type Client struct {
	opts Options

	mu   sync.Mutex // guards conn and writes
	conn *websocket.Conn

	msgs chan []byte

	iceMu    sync.Mutex
	ice      []webrtc.ICEServer
	iceReady chan struct{}
	iceOnce  sync.Once

	closeOnce sync.Once
	closed    chan struct{} // closed by Close
	// Done is closed when the client has stopped for good (Close, or the
	// socket dropped and no reconnect will follow). Err says why.
	Done <-chan struct{}
	done chan struct{}
	errV error
}

// Connect opens a WebSocket connection to the signalling server as the given
// role ("host" or "guest") without a host key or reconnects.
func Connect(serverURL, roomID, role, origin string) (*Client, error) {
	return Dial(context.Background(), Options{Server: serverURL, Room: roomID, Role: role, Origin: origin})
}

// Dial opens the first connection synchronously (so the caller sees a bad
// server URL or an unreachable server at once) and starts the reader.
func Dial(ctx context.Context, opts Options) (*Client, error) {
	if opts.Role != "host" && opts.Role != "guest" {
		return nil, fmt.Errorf("bad role %q", opts.Role)
	}
	c := &Client{
		opts:     opts,
		msgs:     make(chan []byte, 64),
		iceReady: make(chan struct{}),
		closed:   make(chan struct{}),
		done:     make(chan struct{}),
	}
	c.Done = c.done
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	c.conn = conn
	go c.readLoop(conn)
	go c.pingLoop()
	return c, nil
}

func (c *Client) dial(ctx context.Context) (*websocket.Conn, error) {
	u, err := BuildWsURL(c.opts.Server, c.opts.Room, c.opts.Role, c.opts.HostKey)
	if err != nil {
		return nil, fmt.Errorf("invalid server URL %q: %w", c.opts.Server, err)
	}
	hdr := http.Header{}
	if c.opts.Origin != "" {
		hdr.Set("Origin", c.opts.Origin)
	}
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 15 * time.Second
	conn, _, err := d.DialContext(ctx, u, hdr)
	if err != nil {
		return nil, fmt.Errorf("websocket dial %s: %w", redactKey(u), err)
	}
	return conn, nil
}

// Messages delivers every signalling message except config and pings. It is
// closed when the client stops for good.
func (c *Client) Messages() <-chan []byte { return c.msgs }

// ReadMsg reads the next message (compatibility helper over Messages).
func (c *Client) ReadMsg() (Msg, json.RawMessage, error) {
	raw, ok := <-c.msgs
	if !ok {
		return Msg{}, nil, c.Err()
	}
	var m struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return Msg{}, nil, fmt.Errorf("unmarshal: %w", err)
	}
	return Msg{Type: m.Type, Raw: raw}, raw, nil
}

// Err is why the client stopped (nil while it runs, or after Close).
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.errV
}

// ICEServers returns the servers from the server's config message, waiting up
// to ConfigWait for it; after that, public STUN.
func (c *Client) ICEServers() []webrtc.ICEServer {
	select {
	case <-c.iceReady:
	case <-time.After(ConfigWait):
	case <-c.done:
	}
	c.iceMu.Lock()
	defer c.iceMu.Unlock()
	if len(c.ice) == 0 {
		return FallbackICEServers()
	}
	return append([]webrtc.ICEServer(nil), c.ice...)
}

// WriteJSON sends a value as JSON over the WebSocket.
func (c *Client) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("signalling is reconnecting")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(v)
}

// Close gracefully closes the WebSocket connection and stops reconnecting.
func (c *Client) Close() {
	c.closeOnce.Do(func() { close(c.closed) })
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		c.mu.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = conn.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		)
		c.mu.Unlock()
		_ = conn.Close()
	}
	// readLoop finishes the job (closes msgs and done) once the socket is gone.
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
	}
}

func (c *Client) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func (c *Client) finish(err error) {
	c.mu.Lock()
	if c.errV == nil && err != nil {
		c.errV = err
	}
	c.conn = nil
	c.mu.Unlock()
	close(c.msgs)
	close(c.done)
}

func (c *Client) readLoop(conn *websocket.Conn) {
	attempt := 0
	for {
		err := c.readConn(conn, &attempt)
		if c.isClosed() {
			c.finish(nil)
			return
		}
		if !c.opts.Reconnect || isFatal(err) {
			c.finish(describe(err))
			return
		}
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
		if c.opts.OnState != nil {
			c.opts.OnState(false)
		}
		// Redial with backoff until it works or we are closed.
		for {
			d := backoff[min(attempt, len(backoff)-1)]
			attempt++
			select {
			case <-c.closed:
				c.finish(nil)
				return
			case <-time.After(d):
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			nc, derr := c.dial(ctx)
			cancel()
			if derr == nil {
				conn = nc
				c.mu.Lock()
				c.conn = nc
				c.mu.Unlock()
				if c.isClosed() {
					_ = nc.Close()
					c.finish(nil)
					return
				}
				if c.opts.OnState != nil {
					c.opts.OnState(true)
				}
				break
			}
		}
	}
}

// readConn reads one socket until it fails. The backoff resets on the server's
// config message (the server accepts a socket before it decides to refuse it).
func (c *Client) readConn(conn *websocket.Conn, attempt *int) error {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var hdr struct {
			Type       string          `json:"type"`
			IceServers json.RawMessage `json:"iceServers"`
		}
		if json.Unmarshal(raw, &hdr) != nil || hdr.Type == "" {
			continue
		}
		switch hdr.Type {
		case "config":
			*attempt = 0
			if servers, perr := ParseICEServers(hdr.IceServers); perr == nil && len(servers) > 0 {
				c.iceMu.Lock()
				c.ice = servers
				c.iceMu.Unlock()
			}
			c.iceOnce.Do(func() { close(c.iceReady) })
			continue
		case "ping", "pong":
			continue
		}
		select {
		case c.msgs <- raw:
		case <-c.closed:
			return errors.New("closed")
		}
	}
}

func (c *Client) pingLoop() {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-t.C:
			_ = c.WriteJSON(map[string]string{"type": "ping"})
		}
	}
}

// CloseCode extracts the WebSocket close code from an error, or 0.
func CloseCode(err error) int {
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return 0
}

func isFatal(err error) bool {
	switch CloseCode(err) {
	case CloseDuplicateHost, CloseNoHost, CloseBadRole, CloseRoomBusy, CloseBadRoom, CloseRoomFull, CloseReplaced:
		return true
	}
	return false
}

// RefusalError is a refusal by the server that a retry won't fix.
type RefusalError struct {
	Code int
	Msg  string
}

func (e *RefusalError) Error() string { return e.Msg }

func describe(err error) error {
	switch CloseCode(err) {
	case CloseDuplicateHost:
		return &RefusalError{CloseDuplicateHost, "another sender already owns this share link"}
	case CloseNoHost:
		return &RefusalError{CloseNoHost, "no sender is sharing on this link"}
	case CloseBadRole:
		return &RefusalError{CloseBadRole, "the server refused the connection role"}
	case CloseRoomBusy:
		return &RefusalError{CloseRoomBusy, "someone else is receiving from this sender right now"}
	case CloseBadRoom:
		return &RefusalError{CloseBadRoom, "the share id is not valid"}
	case CloseServerFull:
		return &RefusalError{CloseServerFull, "the signalling server is full, try again shortly"}
	case CloseRoomFull:
		return &RefusalError{CloseRoomFull, "too many people are downloading from this sender right now"}
	case CloseReplaced:
		return &RefusalError{CloseReplaced, "this share was taken over by a newer connection"}
	}
	if err == nil {
		return errors.New("signalling connection closed")
	}
	return fmt.Errorf("signalling connection lost: %w", err)
}

// ParseICEServers converts the server's iceServers list (the browser's
// RTCIceServer shape: urls as a string or a list, optional username and
// credential) into pion's form. URLs pion can't parse, and TURN entries without
// credentials, are dropped rather than failing the whole connection.
func ParseICEServers(raw json.RawMessage) ([]webrtc.ICEServer, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var entries []struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential any             `json:"credential"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("iceServers: %w", err)
	}
	var out []webrtc.ICEServer
	for _, e := range entries {
		var urls []string
		var one string
		if json.Unmarshal(e.URLs, &one) == nil {
			if one != "" {
				urls = []string{one}
			}
		} else if json.Unmarshal(e.URLs, &urls) != nil {
			continue
		}
		cred, _ := e.Credential.(string)
		var keep []string
		for _, u := range urls {
			if usableICEURL(u, e.Username, cred) {
				keep = append(keep, u)
			}
		}
		if len(keep) == 0 {
			continue
		}
		s := webrtc.ICEServer{URLs: keep}
		if e.Username != "" {
			s.Username = e.Username
			s.Credential = cred
			s.CredentialType = webrtc.ICECredentialTypePassword
		}
		out = append(out, s)
	}
	return out, nil
}

// FallbackICEServers mirrors FALLBACK_ICE_SERVERS in frontend/src/lib/webrtc.ts
// (used only when the server never sends its config).
func FallbackICEServers() []webrtc.ICEServer {
	return []webrtc.ICEServer{
		{URLs: []string{"stun:stun.cloudflare.com:3478"}},
		{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"}},
	}
}

// BuildWsURL converts an HTTP(S) API base URL into the signalling WebSocket URL.
// e.g. https://api.markdrop.in → wss://api.markdrop.in/ws/share/<id>?role=host
func BuildWsURL(apiBase, roomID, role, hostKey string) (string, error) {
	apiBase = strings.TrimRight(apiBase, "/")
	u, err := url.Parse(apiBase)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
		// already a WS URL — leave as-is
	default:
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	u.Path = fmt.Sprintf("/ws/share/%s", url.PathEscape(roomID))
	q := u.Query()
	q.Set("role", role)
	if role == "host" && hostKey != "" {
		q.Set("hk", hostKey)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// usableICEURL reports whether pion can use this ICE URL: it must parse, and a
// TURN URL needs a username and a password credential.
func usableICEURL(raw, username, credential string) bool {
	u, err := stun.ParseURI(raw)
	if err != nil {
		return false
	}
	if u.Scheme == stun.SchemeTypeTURN || u.Scheme == stun.SchemeTypeTURNS {
		return username != "" && credential != ""
	}
	return true
}

func redactKey(u string) string {
	if i := strings.Index(u, "hk="); i >= 0 {
		end := strings.IndexByte(u[i:], '&')
		if end < 0 {
			return u[:i] + "hk=…"
		}
		return u[:i] + "hk=…" + u[i+end:]
	}
	return u
}
