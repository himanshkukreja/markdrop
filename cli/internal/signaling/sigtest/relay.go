// Package sigtest is a tiny in-process stand-in for the markdrop signalling
// server (backend/app/routers/share.py, version-1 rooms only) for tests.
package sigtest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// Relay is a test signalling server.
type Relay struct {
	*httptest.Server
	// Config is sent first on every socket; nil sends no config at all.
	Config []byte

	mu    sync.Mutex
	rooms map[string]*room
	// Offers records every offer a host sent, as received (blob included).
	Offers [][]byte
	// HostKeys records the hk query parameter of every host connection.
	HostKeys []string
}

type room struct {
	host  *conn
	guest *conn
	key   string
}

type conn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *conn) send(b []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteMessage(websocket.TextMessage, b)
}

// DefaultConfig offers one unreachable local STUN server, so tests never
// touch the network; host candidates connect on loopback.
var DefaultConfig = []byte(`{"type":"config","iceServers":[{"urls":["stun:127.0.0.1:9"]}]}`)

// New starts a relay.
func New() *Relay {
	r := &Relay{Config: DefaultConfig, rooms: map[string]*room{}}
	r.Server = httptest.NewServer(http.HandlerFunc(r.handle))
	return r
}

// DropHost closes the host socket of a room (a network blip).
func (r *Relay) DropHost(id string) {
	r.mu.Lock()
	rm := r.rooms[id]
	r.mu.Unlock()
	if rm != nil && rm.host != nil {
		_ = rm.host.ws.Close()
	}
}

// Keys returns the host keys seen so far.
func (r *Relay) Keys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.HostKeys...)
}

// OfferList returns the offers seen so far.
func (r *Relay) OfferList() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.Offers...)
}

// HasRoom reports whether a room exists.
func (r *Relay) HasRoom(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.rooms[id]
	return ok
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func (r *Relay) handle(w http.ResponseWriter, req *http.Request) {
	id := strings.TrimPrefix(req.URL.Path, "/ws/share/")
	role := req.URL.Query().Get("role")
	hk := req.URL.Query().Get("hk")
	ws, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c := &conn{ws: ws}
	closeWith := func(code int) {
		_ = ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""))
		_ = ws.Close()
	}

	r.mu.Lock()
	rm := r.rooms[id]
	if rm == nil {
		rm = &room{}
		r.rooms[id] = rm
	}
	if role == "host" {
		r.HostKeys = append(r.HostKeys, hk)
		if rm.key != "" && rm.key != hk {
			r.mu.Unlock()
			closeWith(4000)
			return
		}
		if rm.host != nil && (rm.key == "" || rm.key != hk) {
			r.mu.Unlock()
			closeWith(4000)
			return
		}
		if rm.host != nil {
			_ = rm.host.ws.Close()
		}
		rm.key = hk
		rm.host = c
		guest := rm.guest
		r.mu.Unlock()
		if r.Config != nil {
			c.send(r.Config)
		}
		if guest != nil {
			c.send([]byte(`{"type":"guest-joined"}`))
		}
	} else {
		if rm.host == nil && rm.key == "" {
			r.mu.Unlock()
			c.send([]byte(`{"type":"no-host"}`))
			closeWith(4001)
			return
		}
		if rm.guest != nil {
			r.mu.Unlock()
			c.send([]byte(`{"type":"room-busy"}`))
			closeWith(4003)
			return
		}
		rm.guest = c
		host := rm.host
		r.mu.Unlock()
		if r.Config != nil {
			c.send(r.Config)
		}
		if host == nil {
			c.send([]byte(`{"type":"peer-disconnected"}`))
		} else {
			host.send([]byte(`{"type":"guest-joined"}`))
		}
	}

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg["type"] == "ping" {
			continue
		}
		r.mu.Lock()
		peer := rm.host
		if role == "host" {
			peer = rm.guest
			if msg["type"] == "offer" {
				r.Offers = append(r.Offers, data)
				if _, ok := msg["x"]; ok {
					delete(msg, "x")
					data, _ = json.Marshal(msg)
				}
			}
		}
		r.mu.Unlock()
		if role == "host" && msg["type"] == "bye" {
			if peer != nil {
				peer.send([]byte(`{"type":"room-closed"}`))
			}
			continue
		}
		peer.send(data)
	}

	r.mu.Lock()
	var other *conn
	if role == "host" && rm.host == c {
		rm.host = nil
		other = rm.guest
	} else if role == "guest" && rm.guest == c {
		rm.guest = nil
		other = rm.host
	}
	if rm.host == nil && rm.guest == nil && rm.key == "" {
		delete(r.rooms, id)
	}
	r.mu.Unlock()
	other.send([]byte(`{"type":"peer-disconnected"}`))
}
