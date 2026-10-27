package mcpserver

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markdrop/cli/internal/signaling/sigtest"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func newTestManager(t *testing.T, server string, guard *Guard) *Manager {
	t.Helper()
	var w io.Writer = io.Discard
	if testing.Verbose() {
		w = os.Stderr
	}
	m := NewManager(Config{
		Server:    server,
		ShareURL:  func(id string) string { return "http://localhost:3000/share/" + id },
		Guard:     guard,
		Downloads: filepath.Join(t.TempDir(), "Downloads", "Markdrop"),
		Log:       log.New(w, "mcp: ", log.Lmicroseconds),
	})
	t.Cleanup(func() { m.Shutdown(5 * time.Second) })
	return m
}

func connect(t *testing.T, m *Manager) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	srv := NewServer(m, "0.3.0-test")
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args any) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", name, err)
	}
	var out map[string]any
	if res.StructuredContent != nil {
		b, _ := json.Marshal(res.StructuredContent)
		json.Unmarshal(b, &out)
	}
	return res, out
}

func resultText(r *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func TestToolsListed(t *testing.T) {
	cs := connect(t, newTestManager(t, "http://127.0.0.1:1", &Guard{}))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range res.Tools {
		byName[tool.Name] = tool
	}
	want := map[string]struct{ ro, destructive, idem, open bool }{
		"share_files":   {false, false, false, true},
		"share_status":  {true, false, true, false},
		"stop_share":    {false, false, true, false},
		"receive_share": {false, false, false, true},

		"upload_file":          {false, false, false, true},
		"replace_file":         {false, false, false, true},
		"list_file_versions":   {true, false, true, false},
		"restore_file_version": {false, false, false, true},
		"get_file_info":        {true, false, true, false},
		"list_workspaces":      {true, false, true, false},
		"list_folders":         {true, false, true, false},
	}
	if len(byName) != len(want) {
		t.Fatalf("tools: %v", byName)
	}
	for name, w := range want {
		tool := byName[name]
		if tool == nil {
			t.Fatalf("missing %s", name)
		}
		a := tool.Annotations
		if a == nil || a.ReadOnlyHint != w.ro || a.IdempotentHint != w.idem ||
			a.DestructiveHint == nil || *a.DestructiveHint != w.destructive || a.OpenWorldHint == nil || *a.OpenWorldHint != w.open {
			t.Errorf("%s annotations: %+v", name, a)
		}
		if tool.OutputSchema == nil || tool.Description == "" {
			t.Errorf("%s: missing output schema or description", name)
		}
	}
	schema, _ := json.Marshal(byName["share_files"].InputSchema)
	if !strings.Contains(string(schema), `"minItems":1`) || !strings.Contains(string(schema), `"maxItems":100`) {
		t.Errorf("share_files schema lacks bounds: %s", schema)
	}
	init := cs.InitializeResult()
	if init.ServerInfo.Name != "markdrop-p2p" || init.ServerInfo.Title != "Markdrop: P2P sharing and file publishing" || init.ServerInfo.Version != "0.3.0-test" {
		t.Errorf("server info: %+v", init.ServerInfo)
	}
}

func TestToolInputValidation(t *testing.T) {
	g, home := fakeHome(t)
	cs := connect(t, newTestManager(t, "http://127.0.0.1:1", g))

	check := func(name string, args any, wantInError string) {
		t.Helper()
		res, _ := call(t, cs, name, args)
		if !res.IsError {
			t.Errorf("%s %v: expected a tool error, got %s", name, args, resultText(res))
			return
		}
		if wantInError != "" && !strings.Contains(resultText(res), wantInError) {
			t.Errorf("%s %v: error %q lacks %q", name, args, resultText(res), wantInError)
		}
	}
	many := make([]string, 101)
	for i := range many {
		many[i] = filepath.Join(home, "work", "clean", "a.txt")
	}
	check("share_files", map[string]any{"paths": []string{}}, "")
	check("share_files", map[string]any{}, "")
	check("share_files", map[string]any{"paths": many}, "")
	check("share_files", map[string]any{"paths": []string{""}}, "")
	check("share_files", map[string]any{"paths": []string{"~/.ssh"}}, "refused")
	check("share_files", map[string]any{"paths": []string{"~/work/clean/a.txt", "~/.aws/credentials"}}, "refused")
	check("share_files", map[string]any{"paths": []string{"~/work/app"}}, ".env")
	check("share_files", map[string]any{"paths": []string{"~/missing.bin"}}, "cannot access")
	check("receive_share", map[string]any{"link": "https://markdrop.in/d/abcdef1234"}, "share link")
	check("receive_share", map[string]any{}, "")
	check("receive_share", map[string]any{"link": "abcdef1234", "directory": "~/.ssh"}, "refused")
	check("stop_share", map[string]any{"share_id": "nope123456"}, "no share")
	check("share_status", map[string]any{"share_id": "nope123456"}, "no share")

	res, out := call(t, cs, "share_status", map[string]any{})
	if res.IsError || out["shares"] == nil || out["receives"] == nil {
		t.Fatalf("empty status: %v %s", out, resultText(res))
	}
}

// TestShareAndReceiveOverRelay drives two MCP servers (sender and receiver)
// through the test relay: share a folder and a file, receive both, compare
// bytes, check status and stop.
func TestShareAndReceiveOverRelay(t *testing.T) {
	if testing.Short() {
		t.Skip("webrtc transfer")
	}
	relay := sigtest.New()
	defer relay.Close()

	g, home := fakeHome(t)
	payload := make([]byte, 2*1024*1024+3)
	rand.Read(payload)
	os.WriteFile(filepath.Join(home, "work", "clean", "big.bin"), payload, 0o644)

	t.Setenv("MARKDROP_TOKEN", "")
	sender := newTestManager(t, relay.URL, g)
	sender.cfg.Token = "mdk_testtoken"
	receiver := newTestManager(t, relay.URL, g)
	scs, rcs := connect(t, sender), connect(t, receiver)

	res, share := call(t, scs, "share_files", map[string]any{"paths": []string{"~/work/clean/big.bin"}})
	if res.IsError {
		t.Fatal(resultText(res))
	}
	id := share["share_id"].(string)
	if share["file_name"] != "big.bin" || share["total_bytes"].(float64) != float64(len(payload)) ||
		share["url"] != "http://localhost:3000/share/"+id || share["expires"] == "" {
		t.Fatalf("share_files output: %v", share)
	}

	dest := filepath.Join(home, "Downloads", "Markdrop")
	for round := 1; round <= 2; round++ {
		res, recv := call(t, rcs, "receive_share", map[string]any{"link": "https://markdrop.in/share/" + id, "directory": dest})
		if res.IsError {
			t.Fatal(resultText(res))
		}
		rid := recv["receive_id"].(string)
		st := waitState(t, rcs, rid, "done")
		saved := st["saved_to"].([]any)
		got, _ := os.ReadFile(saved[0].(string))
		if !bytes.Equal(got, payload) {
			t.Fatalf("round %d: received bytes differ", round)
		}
		wantName := "big.bin"
		if round == 2 {
			wantName = "big (1).bin"
		}
		if filepath.Base(saved[0].(string)) != wantName {
			t.Fatalf("round %d saved as %s", round, saved[0])
		}
	}

	// The share served both, one after the other, and is waiting again.
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, st := call(t, scs, "share_status", map[string]any{"share_id": id})
		row := st["shares"].([]any)[0].(map[string]any)
		if row["recipients_served"].(float64) == 2 && row["state"] == "waiting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("share status: %v", row)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// The token rode on the offer as the browser's blob.
	offers := relay.OfferList()
	if len(offers) == 0 || !strings.Contains(string(offers[0]), `"x":"`) {
		t.Fatal("no blob on the offer")
	}

	// A folder (zip) share is unpacked by the receiver.
	res, share2 := call(t, scs, "share_files", map[string]any{"paths": []string{"~/work/clean"}})
	if res.IsError {
		t.Fatal(resultText(res))
	}
	if share2["file_name"] != "clean.zip" || share2["file_count"].(float64) != 3 {
		t.Fatalf("folder share: %v", share2)
	}
	_, recv := call(t, rcs, "receive_share", map[string]any{"link": share2["share_id"], "directory": dest})
	st := waitState(t, rcs, recv["receive_id"].(string), "done")
	folder := st["saved_to"].([]any)[0].(string)
	if b, _ := os.ReadFile(filepath.Join(folder, "sub", "b.txt")); string(b) != "x" {
		t.Fatalf("folder not unpacked at %s", folder)
	}

	// Stop: idempotent, and the room is gone for new recipients.
	for i := 0; i < 2; i++ {
		res, out := call(t, scs, "stop_share", map[string]any{"share_id": id})
		if res.IsError || out["state"] != "stopped" || out["recipients_served"].(float64) != 2 {
			t.Fatalf("stop_share #%d: %v %s", i+1, out, resultText(res))
		}
	}
	_, recv = call(t, rcs, "receive_share", map[string]any{"link": id, "directory": dest})
	rid := recv["receive_id"].(string)
	// The relay holds a keyed room, so the guest waits for the sender; cancel it.
	time.Sleep(500 * time.Millisecond)
	res, out := call(t, rcs, "stop_share", map[string]any{"share_id": rid})
	if res.IsError || out["kind"] != "receive" || out["state"] != "stopped" {
		t.Fatalf("cancel receive: %v %s", out, resultText(res))
	}
}

func waitState(t *testing.T, cs *mcp.ClientSession, id, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		_, st := call(t, cs, "share_status", map[string]any{"share_id": id})
		var row map[string]any
		for _, k := range []string{"shares", "receives"} {
			if rows, ok := st[k].([]any); ok && len(rows) > 0 {
				row = rows[0].(map[string]any)
			}
		}
		if row != nil && row["state"] == want {
			return row
		}
		if row != nil && row["state"] == "error" {
			t.Fatalf("%s failed: %v", id, row)
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never reached %s: %v", id, want, row)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestStatusTextReadable(t *testing.T) {
	out := &StatusOutput{
		Shares:   []ShareInfo{{ShareID: "abc", FileName: "x.pdf", TotalBytes: 2048, State: StateTransferring, Progress: makeProgress(1024, 2048), URL: "u"}},
		Receives: []ReceiveInfo{{ReceiveID: "recv-1", State: StateDone, FileName: "y", SavedTo: []string{"/tmp/y"}}},
	}
	s := statusText(out)
	for _, want := range []string{"abc", "50.0%", "recv-1", "saved to /tmp/y"} {
		if !strings.Contains(s, want) {
			t.Errorf("status text %q lacks %q", s, want)
		}
	}
	if makeProgress(5, 0).Percent != 0 || makeProgress(3, 3).Percent != 100 {
		t.Error("progress edge cases")
	}
	_ = fmt.Sprintf
}
