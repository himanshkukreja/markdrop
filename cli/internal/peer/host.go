// Package peer implements the WebRTC DataChannel logic for both the sending
// (host) and receiving (guest) sides of a markdrop file transfer.
//
// It speaks version 1 of the share protocol (frontend/src/lib/p2p/protocol.ts):
// host → meta {name,size,mimeType,isFolder?}, guest → start, host → bytes…
// The browser accepts it from a CLI sender and speaks it to a CLI recipient,
// so CLI↔Browser and CLI↔CLI transfers work without backend changes.
package peer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v3"
)

// chunkSize must not exceed math.MaxUint16 (65535).
// pion/webrtc's internal DataChannel read goroutine allocates a buffer of
// exactly math.MaxUint16 bytes. Sending one byte more causes pion/sctp's
// reassembly queue to return io.ErrShortBuffer on the receiver side.
// 64*1024 = 65536 is 1 byte over that limit — use 65535 instead.
const chunkSize = 65535

// bufferHighWater mirrors the browser's bufferedAmountLowThreshold (4 MB).
// Sending is paused while the DataChannel buffer exceeds this value.
const bufferHighWater = 4 * 1024 * 1024

// sctpReceiveBufSize overrides pion's default SCTP receive buffer (8 KB).
// Must be larger than the biggest single message we can receive (65535 bytes).
const sctpReceiveBufSize = 512 * 1024 // 512 KB

// negotiateTimeout bounds how long a recipient may take to open the data
// channel once it has joined.
const negotiateTimeout = 90 * time.Second

// ErrGuestLeft means the recipient went away before the transfer finished.
var ErrGuestLeft = errors.New("recipient disconnected before the transfer finished")

// ErrRenegotiate means the recipient (re)joined while we were still
// negotiating — start again with a fresh offer.
var ErrRenegotiate = errors.New("recipient rejoined; renegotiating")

// newPeerConnection creates a PeerConnection with a generous SCTP receive
// buffer so that large DataChannel messages from the browser never hit pion's
// "short buffer" error. pion logs to stderr, never stdout: stdout belongs to
// the MCP protocol in `markdrop mcp`.
func newPeerConnection(ice []webrtc.ICEServer) (*webrtc.PeerConnection, error) {
	se := webrtc.SettingEngine{}
	se.SetSCTPMaxReceiveBufferSize(sctpReceiveBufSize)
	lf := logging.NewDefaultLoggerFactory()
	lf.Writer = os.Stderr
	se.LoggerFactory = lf
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	return api.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
}

// sdpMsg is used for offer/answer JSON messages. X is the opaque share
// metadata blob the server logs and strips (offers only).
type sdpMsg struct {
	Type string                    `json:"type"`
	SDP  webrtc.SessionDescription `json:"sdp"`
	X    string                    `json:"x,omitempty"`
}

// iceMsg is used for ICE candidate JSON messages.
type iceMsg struct {
	Type      string                  `json:"type"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

// metaMsg is sent from host to guest over the DataChannel.
type metaMsg struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
	IsFolder bool   `json:"isFolder,omitempty"`
}

// HostOptions tune one transfer.
type HostOptions struct {
	// OnProgress is called with (bytes acknowledged-or-queued, total).
	OnProgress func(sent, total int64)
	// OnConnected is called once the data channel is open.
	OnConnected func()
	// OnStart is called when the recipient asks for the bytes.
	OnStart func()
	// Blob, if set, rides on every offer as field `x` (see EncodeShareMeta).
	Blob string
	// OnLateJoin hears about signalling that arrives after the channel opened:
	// true for guest-joined (the next recipient is already waiting, since the
	// server announces it only once), false for peer-disconnected. Called on
	// ServeOne's goroutine.
	OnLateJoin func(joined bool)
}

// RunHost sends the file or folder at filePath to the guest that has just
// joined (the caller waits for guest-joined). Folders are zipped first.
func RunHost(ctx context.Context, sig *signaling.Client, filePath string, o HostOptions) error {
	src, err := SourceFromPath(filePath)
	if err != nil {
		return err
	}
	defer src.Close()
	return ServeOne(ctx, sig, src, o)
}

// ServeOne negotiates with the recipient that has just joined and streams src
// to it. It returns nil once every byte has been acknowledged, ErrGuestLeft if
// the recipient goes, ErrRenegotiate if it rejoins mid-negotiation.
func ServeOne(ctx context.Context, sig *signaling.Client, src *Source, o HostOptions) error {
	f, err := os.Open(src.Path)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	pc, err := newPeerConnection(sig.ICEServers())
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}
	defer pc.Close()

	ordered := true
	dc, err := pc.CreateDataChannel("file", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return fmt.Errorf("create data channel: %w", err)
	}

	transferErr := make(chan error, 1)
	fail := func(e error) {
		select {
		case transferErr <- e:
		default:
		}
	}
	dcOpened := make(chan struct{}, 1)

	// Trickle ICE candidates to the peer via the signalling relay. A write
	// that fails while signalling reconnects is not fatal: the guest is told
	// to renegotiate once we are back.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			_ = sig.WriteJSON(iceMsg{Type: "ice", Candidate: c.ToJSON()})
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed {
			fail(errors.New("couldn't connect the two devices (no direct or relayed route)"))
		}
	})

	dc.OnOpen(func() {
		b, _ := json.Marshal(metaMsg{
			Type: "meta", Name: src.Name, Size: src.Size, MimeType: src.MimeType, IsFolder: src.IsFolder,
		})
		if serr := dc.SendText(string(b)); serr != nil {
			fail(fmt.Errorf("send meta: %w", serr))
			return
		}
		select {
		case dcOpened <- struct{}{}:
		default:
		}
	})

	var startOnce sync.Once
	// allSent flips once every byte is queued. A recipient closes the channel
	// as soon as it has the last byte, which can beat waitDelivered's verdict.
	var allSent atomic.Bool
	progress := func(sent, total int64) {
		if sent >= total {
			allSent.Store(true)
		}
		if o.OnProgress != nil {
			o.OnProgress(sent, total)
		}
	}
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			return
		}
		var inner struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msg.Data, &inner) != nil {
			return
		}
		switch inner.Type {
		case "start":
			startOnce.Do(func() {
				if o.OnStart != nil {
					o.OnStart()
				}
				if src.Size == 0 {
					allSent.Store(true)
				}
				go func() { fail(streamFile(ctx, dc, f, src.Size, progress)) }()
			})
		case "ping": // a browser recipient checking we are still here
			_ = dc.SendText(`{"type":"pong"}`)
		}
	})
	dc.OnClose(func() {
		if !allSent.Load() {
			fail(ErrGuestLeft)
			return
		}
		// Everything was sent and the recipient hung up: that is how a
		// recipient says it is done. Let streamFile's own verdict (normally
		// nil within 250 ms) win; if it never comes, count it delivered.
		go func() {
			time.Sleep(2 * time.Second)
			fail(nil)
		}()
	})
	dc.OnError(func(err error) {
		if allSent.Load() {
			return // the recipient hanging up after the last byte; OnClose decides
		}
		fail(fmt.Errorf("data channel error: %w", err))
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}
	if err = sig.WriteJSON(sdpMsg{Type: "offer", SDP: *pc.LocalDescription(), X: o.Blob}); err != nil {
		return fmt.Errorf("send offer: %w", err)
	}

	msgs := sig.Messages()
	opened := false
	negotiate := time.NewTimer(negotiateTimeout)
	defer negotiate.Stop()

	for {
		select {
		case raw, ok := <-msgs:
			if !ok {
				if !opened {
					if e := sig.Err(); e != nil {
						return e
					}
					return errors.New("signalling closed")
				}
				// The data channel carries on without signalling.
				msgs = nil
				continue
			}
			var hdr struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &hdr) != nil {
				continue
			}
			switch hdr.Type {
			case "answer":
				var m sdpMsg
				if json.Unmarshal(raw, &m) == nil && pc.RemoteDescription() == nil {
					if sderr := pc.SetRemoteDescription(m.SDP); sderr != nil {
						return fmt.Errorf("set remote SDP: %w", sderr)
					}
				}
			case "ice":
				var m iceMsg
				if json.Unmarshal(raw, &m) == nil {
					_ = pc.AddICECandidate(m.Candidate) // stale candidates are harmless
				}
			case "peer-disconnected":
				// Before the channel opens the recipient really is gone; after,
				// only its signalling went, and the channel decides.
				if !opened {
					return ErrGuestLeft
				}
				if o.OnLateJoin != nil {
					o.OnLateJoin(false)
				}
			case "guest-joined":
				if !opened {
					return ErrRenegotiate
				}
				if o.OnLateJoin != nil {
					o.OnLateJoin(true)
				}
			}
		case <-dcOpened:
			opened = true
			negotiate.Stop()
			if o.OnConnected != nil {
				o.OnConnected()
			}
		case err := <-transferErr:
			return err
		case <-negotiate.C:
			if !opened {
				return errors.New("timed out connecting to the recipient")
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// streamFile sends the file in chunkSize chunks over the DataChannel.
// It applies backpressure by polling BufferedAmount and sleeping when the
// channel buffer exceeds bufferHighWater.
func streamFile(
	ctx context.Context,
	dc *webrtc.DataChannel,
	f *os.File,
	total int64,
	onProgress func(sent, total int64),
) error {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("read file: %w", err)
	}
	buf := make([]byte, chunkSize)
	var sent int64

	for sent < total {
		// Backpressure: wait for buffer to drain before sending more.
		for dc.BufferedAmount() > bufferHighWater {
			if dc.ReadyState() != webrtc.DataChannelStateOpen {
				return ErrGuestLeft
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			time.Sleep(10 * time.Millisecond)
		}

		n, err := f.Read(buf)
		if n > 0 {
			if serr := dc.Send(buf[:n]); serr != nil {
				return fmt.Errorf("send chunk: %w", serr)
			}
			sent += int64(n)
			if onProgress != nil {
				onProgress(sent, total)
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return fmt.Errorf("read file: %w", err)
		}
	}
	if sent != total {
		return fmt.Errorf("file changed while sending (%d of %d bytes)", sent, total)
	}
	return waitDelivered(dc)
}

// waitDelivered blocks until every queued byte has been acknowledged by the
// receiver. Send() only queues: returning as soon as the last chunk is queued
// let the caller print "Transfer complete" and exit, and closing the peer
// connection on exit discarded up to bufferHighWater of unsent data — the
// receiver got a truncated file. pion lowers BufferedAmount only as SCTP
// acknowledges data, so zero means the receiver has it all.
func waitDelivered(dc *webrtc.DataChannel) error {
	const stallLimit = 60 * time.Second
	last := dc.BufferedAmount()
	lastProgress := time.Now()
	for {
		n := dc.BufferedAmount()
		if n == 0 {
			// Let the receiver's SCTP stack hand the tail to the application
			// before our close tears the association down.
			time.Sleep(250 * time.Millisecond)
			return nil
		}
		if dc.ReadyState() != webrtc.DataChannelStateOpen {
			// We only close after this returns, so the recipient closed it.
			// A version-1 recipient hangs up as soon as it holds the last
			// byte, before pion has counted the final acknowledgements.
			return nil
		}
		if n < last {
			last, lastProgress = n, time.Now()
		} else if time.Since(lastProgress) > stallLimit {
			return fmt.Errorf("receiver stopped acknowledging data (%d bytes undelivered)", n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
