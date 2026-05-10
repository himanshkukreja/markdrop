// Package peer implements the WebRTC DataChannel logic for both the sending
// (host) and receiving (guest) sides of a markdrop file transfer.
//
// The package mirrors the browser-side logic in frontend/src/lib/webrtc.ts and
// frontend/src/app/share/page.tsx exactly so that CLI↔Browser and CLI↔CLI
// transfers both work without any backend changes.
package peer

import (
	"archive/zip"
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

// sctpReceiveBufSize overrides pion's default SCTP receive buffer (8 KB).
// It must be larger than the biggest single message either side can receive.
// The browser sends 64 KB chunks, so 512 KB gives 8× headroom without the
// memory-pressure that a 16 MB allocation can cause on the SCTP state machine.
const sctpReceiveBufSize = 512 * 1024 // 512 KB

// iceServers mirrors ICE_SERVERS in frontend/src/lib/webrtc.ts.
var iceServers = []webrtc.ICEServer{
	{URLs: []string{"stun:stun.l.google.com:19302"}},
	{URLs: []string{"stun:stun1.l.google.com:19302"}},
}

// newPeerConnection creates a PeerConnection with a generous SCTP receive
// buffer so that large DataChannel messages from the browser never hit pion's
// "short buffer" error.
func newPeerConnection() (*webrtc.PeerConnection, error) {
	se := webrtc.SettingEngine{}
	se.SetSCTPMaxReceiveBufferSize(sctpReceiveBufSize)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	return api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
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
	IsFolder bool   `json:"isFolder,omitempty"`
}

// startMsg is sent from guest to host over the DataChannel to begin streaming.
type startMsg struct {
	Type string `json:"type"`
}

// RunHost connects to the signalling server as a host (file sender) and sends
// the file at filePath to the first guest that joins the room.
// If filePath is a directory it is transparently zipped before transfer.
//
// onProgress is called periodically with (bytesSent, totalBytes).
// The function blocks until the transfer completes or ctx is cancelled.
func RunHost(
	ctx context.Context,
	sig *signaling.Client,
	filePath string,
	onProgress func(sent, total int64),
) error {
	fi, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}

	// If a directory is given, zip it to a temp file first.
	isFolder := fi.IsDir()
	var tmpZip string
	// displayName is what the receiver will see (and use for the output filename).
	displayName := filepath.Base(filePath)
	if isFolder {
		tmpZip, err = zipDir(filePath)
		if err != nil {
			return fmt.Errorf("compress folder: %w", err)
		}
		defer os.Remove(tmpZip)
		filePath = tmpZip
		fi, err = os.Stat(filePath)
		if err != nil {
			return fmt.Errorf("stat zip: %w", err)
		}
		displayName = displayName + ".zip"
	}

	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	total := fi.Size()
	mimeType := "application/zip"
	if !isFolder {
		mimeType = mime.TypeByExtension(filepath.Ext(filePath))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	}

	pc, err := newPeerConnection()
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
	// dcOpened is closed once the DataChannel is open and meta has been sent.
	// After that point we no longer need the signalling WS and can ignore its errors.
	dcOpened := make(chan struct{}, 1)

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
			Name:     displayName,
			Size:     total,
			MimeType: mimeType,
			IsFolder: isFolder,
		}
		b, _ := json.Marshal(meta)
		if serr := dc.SendText(string(b)); serr != nil {
			select {
			case transferErr <- fmt.Errorf("send meta: %w", serr):
			default:
			}
			return
		}
		// Signal that the P2P channel is usable; signalling WS is no longer critical.
		select {
		case dcOpened <- struct{}{}:
		default:
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

	// Phase 1: wait until the DataChannel is open (or something fails first).
	// The signalling WS must stay healthy until the P2P channel is established.
	select {
	case <-dcOpened:
		// fall through to phase 2
	case err = <-transferErr:
		return err
	case err = <-sigErr:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}

	// Phase 2: DataChannel is up — the signalling WS can drop without killing
	// the transfer (proxies often close idle WS connections).
	select {
	case err = <-transferErr:
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

// zipDir recursively zips the directory at src into a temp file and returns
// its path. The caller is responsible for deleting the temp file.
func zipDir(src string) (string, error) {
	src = filepath.Clean(src)
	base := filepath.Base(src)

	tmp, err := os.CreateTemp("", "markdrop-"+base+"-*.zip")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	zw := zip.NewWriter(tmp)
	defer zw.Close()

	err = filepath.Walk(src, func(path string, info os.FileInfo, werr error) error {
		if werr != nil {
			return werr
		}

		// Build the in-archive path relative to src's parent so the zip
		// contains a top-level folder named after the directory itself.
		rel, err := filepath.Rel(filepath.Dir(src), path)
		if err != nil {
			return err
		}
		// Use forward slashes inside the zip (cross-platform).
		rel = filepath.ToSlash(rel)

		if info.IsDir() {
			// Zip directories as entries ending with "/".
			if rel != "." {
				_, err = zw.Create(rel + "/")
			}
			return err
		}

		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(w, f)
		return err
	})
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}

	// Flush the zip writer before returning.
	if err = zw.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return tmp.Name(), nil
}
