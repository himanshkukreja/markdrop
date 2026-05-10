// Package peer implements the WebRTC DataChannel logic for both the sending
// (host) and receiving (guest) sides of a markdrop file transfer.
//
// The package mirrors the browser-side logic in frontend/src/lib/webrtc.ts and
// frontend/src/app/share/page.tsx exactly so that CLI↔Browser and CLI↔CLI
// transfers both work without any backend changes.
package peer

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"time"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/pion/webrtc/v3"
)

// chunkSize matches the browser CHUNK_SIZE constant (64 KB).
const chunkSize = 64 * 1024

// bufferHighWater mirrors the browser's bufferedAmountLowThreshold (256 KB).
// Sending is paused while the DataChannel buffer exceeds this value.
const bufferHighWater = 256 * 1024

// iceServers mirrors ICE_SERVERS in frontend/src/lib/webrtc.ts.
var iceServers = []webrtc.ICEServer{
	{URLs: []string{"stun:stun.l.google.com:19302"}},
	{URLs: []string{"stun:stun1.l.google.com:19302"}},
}

// sdpMsg is used for offer/answer JSON messages.
type sdpMsg struct {
	Type string                    `json:"type"`
	SDP  webrtc.SessionDescription `json:"sdp"`
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
}

// startMsg is sent from guest to host over the DataChannel to begin streaming.
type startMsg struct {
	Type string `json:"type"`
}

// RunHost connects to the signalling server as a host (file sender) and sends
// the file at filePath to the first guest that joins the room.
//
// onProgress is called periodically with (bytesSent, totalBytes).
// The function blocks until the transfer completes or ctx is cancelled.
func RunHost(
	ctx context.Context,
	sig *signaling.Client,
	filePath string,
	onProgress func(sent, total int64),
) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat file: %w", err)
	}
	total := fi.Size()
	mimeType := mime.TypeByExtension(filepath.Ext(filePath))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	config := webrtc.Configuration{ICEServers: iceServers}
	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}
	defer pc.Close()

	ordered := true
	dc, err := pc.CreateDataChannel("file", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return fmt.Errorf("create data channel: %w", err)
	}

	// transferErr receives any error from the goroutines below.
	transferErr := make(chan error, 1)

	// Trickle ICE candidates to the peer via the signalling relay.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		msg := iceMsg{Type: "ice", Candidate: c.ToJSON()}
		if werr := sig.WriteJSON(msg); werr != nil {
			select {
			case transferErr <- fmt.Errorf("send ICE: %w", werr):
			default:
			}
		}
	})

	// DataChannel is open → send file metadata, then wait for "start".
	dc.OnOpen(func() {
		meta := metaMsg{
			Type:     "meta",
			Name:     filepath.Base(filePath),
			Size:     total,
			MimeType: mimeType,
		}
		b, _ := json.Marshal(meta)
		if serr := dc.SendText(string(b)); serr != nil {
			select {
			case transferErr <- fmt.Errorf("send meta: %w", serr):
			default:
			}
		}
	})

	// Guest sent {"type":"start"} → begin streaming chunks.
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			return
		}
		var inner struct {
			Type string `json:"type"`
		}
		if jerr := json.Unmarshal(msg.Data, &inner); jerr != nil || inner.Type != "start" {
			return
		}

		go func() {
			transferErr <- streamFile(dc, f, total, onProgress)
		}()
	})

	dc.OnError(func(err error) {
		select {
		case transferErr <- fmt.Errorf("data channel error: %w", err):
		default:
		}
	})

	// Create and send the SDP offer.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}
	if err = sig.WriteJSON(sdpMsg{Type: "offer", SDP: *pc.LocalDescription()}); err != nil {
		return fmt.Errorf("send offer: %w", err)
	}

	// Signalling loop: process incoming messages until transfer completes.
	sigErr := make(chan error, 1)
	go func() {
		for {
			_, raw, rerr := sig.ReadMsg()
			if rerr != nil {
				select {
				case sigErr <- rerr:
				default:
				}
				return
			}
			var hdr struct {
				Type string `json:"type"`
			}
			if jerr := json.Unmarshal(raw, &hdr); jerr != nil {
				continue
			}
			switch hdr.Type {
			case "answer":
				var m sdpMsg
				if jerr := json.Unmarshal(raw, &m); jerr == nil {
					if sderr := pc.SetRemoteDescription(m.SDP); sderr != nil {
						select {
						case sigErr <- fmt.Errorf("set remote SDP: %w", sderr):
						default:
						}
						return
					}
				}
			case "ice":
				var m iceMsg
				if jerr := json.Unmarshal(raw, &m); jerr == nil {
					// Stale candidates can be safely ignored.
					_ = pc.AddICECandidate(m.Candidate)
				}
			case "peer-disconnected":
				select {
				case sigErr <- fmt.Errorf("recipient disconnected before transfer completed"):
				default:
				}
				return
			}
		}
	}()

	select {
	case err = <-transferErr:
		return err
	case err = <-sigErr:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// streamFile sends the file in chunkSize chunks over the DataChannel.
// It applies backpressure by polling BufferedAmount and sleeping when the
// channel buffer exceeds bufferHighWater.
func streamFile(
	dc *webrtc.DataChannel,
	f *os.File,
	total int64,
	onProgress func(sent, total int64),
) error {
	buf := make([]byte, chunkSize)
	var sent int64

	for sent < total {
		// Backpressure: wait for buffer to drain before sending more.
		for dc.BufferedAmount() > bufferHighWater {
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
	return nil
}
