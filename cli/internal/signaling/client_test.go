package signaling_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/markdrop/cli/internal/signaling/sigtest"
)

func TestParseICEServers(t *testing.T) {
	// The exact shape backend/app/services/turn.py sends: STUN_SERVERS plus
	// Cloudflare TURN entries with credentials.
	raw := json.RawMessage(`[
		{"urls": ["stun:stun.cloudflare.com:3478"]},
		{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
		{"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp",
		          "turns:turn.cloudflare.com:5349?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp"],
		 "username": "u123", "credential": "p456"},
		{"urls": "stun:single.example.com:3478"},
		{"urls": ["turn:nocreds.example.com:3478"]},
		{"urls": ["bogus://nope", "stun:ok.example.com:3478"]},
		{"urls": 42}
	]`)
	got, err := signaling.ParseICEServers(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("want 5 servers, got %d: %+v", len(got), got)
	}
	turn := got[2]
	if len(turn.URLs) != 4 || turn.Username != "u123" || turn.Credential != "p456" {
		t.Fatalf("TURN entry not kept intact: %+v", turn)
	}
	if got[3].URLs[0] != "stun:single.example.com:3478" {
		t.Fatalf("string urls not accepted: %+v", got[3])
	}
	if len(got[4].URLs) != 1 || got[4].URLs[0] != "stun:ok.example.com:3478" {
		t.Fatalf("bad URL not dropped from its entry: %+v", got[4])
	}
	for _, s := range got {
		for _, u := range s.URLs {
			if strings.Contains(u, "nocreds") {
				t.Fatalf("TURN without credentials kept: %+v", s)
			}
		}
	}

	if got, err := signaling.ParseICEServers(json.RawMessage(`null`)); err != nil || got != nil {
		t.Fatalf("null: %v %v", got, err)
	}
	if _, err := signaling.ParseICEServers(json.RawMessage(`{"urls":"x"}`)); err == nil {
		t.Fatal("an object instead of a list should be an error")
	}
}

func TestBuildWsURL(t *testing.T) {
	u, err := signaling.BuildWsURL("https://api.markdrop.in/", "abc123def0", "host", "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	want := "wss://api.markdrop.in/ws/share/abc123def0?hk=0123456789abcdef0123456789abcdef&role=host"
	if u != want {
		t.Fatalf("got %s want %s", u, want)
	}
	u, _ = signaling.BuildWsURL("http://127.0.0.1:8097", "abc123def0", "guest", "ignored-for-guests")
	if u != "ws://127.0.0.1:8097/ws/share/abc123def0?role=guest" {
		t.Fatalf("guest url: %s", u)
	}
	if _, err := signaling.BuildWsURL("ftp://x", "a", "host", ""); err == nil {
		t.Fatal("ftp scheme accepted")
	}
}

func TestConfigIsKeptAndNotDelivered(t *testing.T) {
	relay := sigtest.New()
	defer relay.Close()
	relay.Config = []byte(`{"type":"config","iceServers":[{"urls":["turn:t.example.com:3478"],"username":"u","credential":"c"}]}`)

	c, err := signaling.Dial(context.Background(), signaling.Options{Server: relay.URL, Room: "room000001", Role: "host"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ice := c.ICEServers()
	if len(ice) != 1 || ice[0].URLs[0] != "turn:t.example.com:3478" || ice[0].Username != "u" {
		t.Fatalf("config not used: %+v", ice)
	}
	select {
	case m := <-c.Messages():
		t.Fatalf("config leaked to Messages: %s", m)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestFallbackWhenNoConfig(t *testing.T) {
	old := signaling.ConfigWait
	signaling.ConfigWait = 150 * time.Millisecond
	defer func() { signaling.ConfigWait = old }()

	relay := sigtest.New()
	defer relay.Close()
	relay.Config = nil // an old backend

	c, err := signaling.Dial(context.Background(), signaling.Options{Server: relay.URL, Room: "room000002", Role: "host"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	ice := c.ICEServers()
	if time.Since(start) < 100*time.Millisecond {
		t.Fatal("did not wait for config")
	}
	if len(ice) != 2 || !strings.HasPrefix(ice[0].URLs[0], "stun:") {
		t.Fatalf("want STUN fallback, got %+v", ice)
	}
}

func TestHostReconnectsWithKey(t *testing.T) {
	relay := sigtest.New()
	defer relay.Close()
	const key = "0123456789abcdef0123456789abcdef"
	states := make(chan bool, 4)
	host, err := signaling.Dial(context.Background(), signaling.Options{
		Server: relay.URL, Room: "room000003", Role: "host", HostKey: key, Reconnect: true,
		OnState: func(up bool) { states <- up },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	host.ICEServers() // config arrived: the room is ours

	relay.DropHost("room000003")
	if up := <-states; up {
		t.Fatal("expected a down event first")
	}
	select {
	case up := <-states:
		if !up {
			t.Fatal("expected to come back up")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("host did not reconnect")
	}
	if keys := relay.Keys(); len(keys) != 2 || keys[0] != key || keys[1] != key {
		t.Fatalf("host keys sent: %v", keys)
	}

	// A guest joining after the reconnect reaches the host on the same channel.
	guest, err := signaling.Dial(context.Background(), signaling.Options{Server: relay.URL, Room: "room000003", Role: "guest"})
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close()
	select {
	case m := <-host.Messages():
		if !strings.Contains(string(m), "guest-joined") {
			t.Fatalf("unexpected %s", m)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("guest-joined not delivered after reconnect")
	}
}

func TestGuestRefusalIsFinal(t *testing.T) {
	relay := sigtest.New()
	defer relay.Close()
	g, err := signaling.Dial(context.Background(), signaling.Options{Server: relay.URL, Room: "nobody0001", Role: "guest"})
	if err != nil {
		t.Fatal(err)
	}
	m := <-g.Messages()
	if !strings.Contains(string(m), "no-host") {
		t.Fatalf("got %s", m)
	}
	select {
	case <-g.Done:
	case <-time.After(3 * time.Second):
		t.Fatal("client did not stop after the server refused it")
	}
	var re *signaling.RefusalError
	if err := g.Err(); !errors.As(err, &re) || re.Code != signaling.CloseNoHost {
		t.Fatalf("want a no-host refusal, got %v", err)
	}
}
