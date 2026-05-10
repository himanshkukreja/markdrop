// Package signaling provides a thin WebSocket client that relays JSON messages
// between WebRTC peers through the markdrop signalling server.
//
// The server never sees file bytes; it only forwards SDP offers/answers,
// ICE candidates, and small control signals (guest-joined, start, meta, …)
// between two browser peers so they can establish a direct WebRTC DataChannel.
package signaling

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// Msg is a generic JSON envelope exchanged on the signalling channel.
type Msg struct {
	Type string          `json:"type"`
	Raw  json.RawMessage `json:"-"` // full original bytes
}

// Client is a thread-safe WebSocket signalling client.
type Client struct {
	conn *websocket.Conn
	mu   sync.Mutex
	Done <-chan struct{} // closed when the connection is lost
	done chan struct{}
}

// Connect opens a WebSocket connection to the signalling server as the given
// role ("host" or "guest").
//
// origin must match one of the CORS allowed origins configured in the backend
// (e.g. "https://www.markdrop.in").
func Connect(serverURL, roomID, role, origin string) (*Client, error) {
	// Build the WebSocket URL: wss://<host>/ws/share/<roomID>?role=<role>
	u, err := buildWsURL(serverURL, roomID, role)
	if err != nil {
		return nil, fmt.Errorf("invalid server URL %q: %w", serverURL, err)
	}

	hdr := http.Header{}
	hdr.Set("Origin", origin)

	conn, _, err := websocket.DefaultDialer.Dial(u, hdr)
	if err != nil {
		return nil, fmt.Errorf("websocket dial %s: %w", u, err)
	}

	done := make(chan struct{})
	c := &Client{conn: conn, done: done, Done: done}
	return c, nil
}

// ReadMsg reads the next JSON message from the server.
func (c *Client) ReadMsg() (Msg, json.RawMessage, error) {
	_, raw, err := c.conn.ReadMessage()
	if err != nil {
		select {
		case <-c.done:
		default:
			close(c.done)
		}
		return Msg{}, nil, err
	}
	var m struct {
		Type string `json:"type"`
	}
	if jerr := json.Unmarshal(raw, &m); jerr != nil {
		return Msg{}, nil, fmt.Errorf("unmarshal: %w", jerr)
	}
	return Msg{Type: m.Type}, raw, nil
}

// WriteJSON sends a value as JSON over the WebSocket.
func (c *Client) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

// Close gracefully closes the WebSocket connection.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.WriteMessage(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
	)
	_ = c.conn.Close()
	select {
	case <-c.done:
	default:
		close(c.done)
	}
}

// buildWsURL converts an HTTP(S) API base URL into the signalling WebSocket URL.
// e.g. https://api.markdrop.in → wss://api.markdrop.in/ws/share/<id>?role=host
func buildWsURL(apiBase, roomID, role string) (string, error) {
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
	u.Path = fmt.Sprintf("/ws/share/%s", roomID)
	q := u.Query()
	q.Set("role", role)
	u.RawQuery = q.Encode()
	return u.String(), nil
}
