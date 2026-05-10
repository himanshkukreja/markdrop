package peer

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/markdrop/cli/internal/signaling"
	"github.com/pion/webrtc/v3"
)

// FileMeta holds the metadata received from the host before download starts.
type FileMeta struct {
	Name     string
	Size     int64
	MimeType string
}

// guestResult carries the outcome of an async guest operation.
type guestResult struct{ err error }

// RunGuest connects to the signalling server as a guest (file receiver),
// performs the WebRTC handshake, waits for file metadata, optionally prompts
// the user for confirmation, then downloads the file to outputDir.
//
// If autoAccept is true the download starts without prompting.
// onProgress is called with (bytesReceived, totalBytes) for each chunk.
// The function blocks until the file is fully saved or an error occurs.
func RunGuest(
	ctx context.Context,
	sig *signaling.Client,
	outputDir string,
	outputFile string, // empty → use filename from meta
	autoAccept bool,
	onProgress func(received, total int64),
	onMeta func(FileMeta),
) error {
	done := make(chan guestResult, 1)
	metaCh := make(chan FileMeta, 1)

	// Signalling loop — runs until P2P channel takes over.
	go func() {
		var pc *webrtc.PeerConnection

		for {
			_, raw, err := sig.ReadMsg()
			if err != nil {
				done <- guestResult{fmt.Errorf("signalling disconnected: %w", err)}
				return
			}

			var hdr struct {
				Type string `json:"type"`
			}
			if jerr := json.Unmarshal(raw, &hdr); jerr != nil {
				continue
			}

			switch hdr.Type {
			case "no-host":
				done <- guestResult{fmt.Errorf("no sender found — the room ID may be wrong or the sender has closed the tab")}
				return

			case "offer":
				var m sdpMsg
				if jerr := json.Unmarshal(raw, &m); jerr != nil {
					done <- guestResult{fmt.Errorf("parse offer: %w", jerr)}
					return
				}

				config := webrtc.Configuration{ICEServers: iceServers}
				pc, err = webrtc.NewPeerConnection(config)
				if err != nil {
					done <- guestResult{fmt.Errorf("create peer connection: %w", err)}
					return
				}

				// Trickle our ICE candidates back to the host.
				pc.OnICECandidate(func(c *webrtc.ICECandidate) {
					if c == nil {
						return
					}
					_ = sig.WriteJSON(iceMsg{Type: "ice", Candidate: c.ToJSON()})
				})

				// Host will create the DataChannel — wire up receive handlers.
				pc.OnDataChannel(func(dc *webrtc.DataChannel) {
					handleIncomingChannel(dc, outputDir, outputFile, autoAccept, onProgress, onMeta, metaCh, done)
				})

				if err = pc.SetRemoteDescription(m.SDP); err != nil {
					done <- guestResult{fmt.Errorf("set remote description: %w", err)}
					return
				}

				answer, aerr := pc.CreateAnswer(nil)
				if aerr != nil {
					done <- guestResult{fmt.Errorf("create answer: %w", aerr)}
					return
				}
				if err = pc.SetLocalDescription(answer); err != nil {
					done <- guestResult{fmt.Errorf("set local description: %w", err)}
					return
				}
				if err = sig.WriteJSON(sdpMsg{Type: "answer", SDP: *pc.LocalDescription()}); err != nil {
					done <- guestResult{fmt.Errorf("send answer: %w", err)}
					return
				}

			case "ice":
				if pc == nil {
					continue
				}
				var m iceMsg
				if jerr := json.Unmarshal(raw, &m); jerr == nil {
					_ = pc.AddICECandidate(m.Candidate)
				}

			case "peer-disconnected":
				done <- guestResult{fmt.Errorf("sender disconnected before transfer completed")}
				return
			}
		}
	}()

	select {
	case r := <-done:
		return r.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// handleIncomingChannel wires up DataChannel message handlers for the guest.
// It receives the meta JSON, optionally prompts for user confirmation, then
// receives binary chunks and writes them to disk.
func handleIncomingChannel(
	dc *webrtc.DataChannel,
	outputDir string,
	outputFile string,
	autoAccept bool,
	onProgress func(received, total int64),
	onMeta func(FileMeta),
	metaCh chan FileMeta,
	done chan<- guestResult,
) {
	dc.OnError(func(err error) {
		select {
		case done <- guestResult{fmt.Errorf("data channel error: %w", err)}:
		default:
		}
	})

	var (
		meta      FileMeta
		tmpPath   string
		finalPath string
		tmpFile   *os.File
		received  int64
	)

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if msg.IsString {
			// Control message — only "meta" is expected.
			var inner struct {
				Type     string `json:"type"`
				Name     string `json:"name"`
				Size     int64  `json:"size"`
				MimeType string `json:"mimeType"`
			}
			if jerr := json.Unmarshal(msg.Data, &inner); jerr != nil || inner.Type != "meta" {
				return
			}
			meta = FileMeta{Name: inner.Name, Size: inner.Size, MimeType: inner.MimeType}
			if onMeta != nil {
				onMeta(meta)
			}
			select {
			case metaCh <- meta:
			default:
			}

			// Resolve output path.
			name := outputFile
			if name == "" {
				name = inner.Name
			}
			if outputDir != "" {
				finalPath = filepath.Join(outputDir, name)
			} else {
				finalPath = name
			}
			tmpPath = finalPath + ".tmp"

			// Create temp file for writing.
			var ferr error
			if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
				done <- guestResult{err}
				return
			}
			tmpFile, ferr = os.Create(tmpPath)
			if ferr != nil {
				done <- guestResult{fmt.Errorf("create output file: %w", ferr)}
				return
			}

			// Run the user prompt and "start" signal in a separate goroutine.
			// Blocking inside OnMessage prevents pion from processing SCTP
			// keepalives, which closes the data channel while the user types.
			localTmp := tmpFile
			localTmpPath := tmpPath
			localName := inner.Name
			localSize := inner.Size
			go func() {
				if !autoAccept {
					fmt.Printf("\n  Accept download of %q (%s)? [Y/n]: ", localName, formatBytes(localSize))
					reader := bufio.NewReader(os.Stdin)
					ans, _ := reader.ReadString('\n')
					ans = strings.TrimSpace(strings.ToLower(ans))
					if ans == "n" || ans == "no" {
						_ = localTmp.Close()
						_ = os.Remove(localTmpPath)
						select {
						case done <- guestResult{fmt.Errorf("download rejected by user")}:
						default:
						}
						return
					}
				}
				// Tell the host to start streaming.
				start, _ := json.Marshal(startMsg{Type: "start"})
				if serr := dc.SendText(string(start)); serr != nil {
					select {
					case done <- guestResult{fmt.Errorf("send start signal: %w", serr)}:
					default:
					}
				}
			}()
			return
		}

		// Binary chunk — write to temp file.
		if tmpFile == nil {
			return
		}
		chunk := msg.Data
		if _, werr := tmpFile.Write(chunk); werr != nil {
			done <- guestResult{fmt.Errorf("write chunk: %w", werr)}
			return
		}
		received += int64(len(chunk))
		if onProgress != nil {
			onProgress(received, meta.Size)
		}

		// All bytes received → finalise download.
		if meta.Size > 0 && received >= meta.Size {
			_ = tmpFile.Close()
			tmpFile = nil
			if rerr := os.Rename(tmpPath, finalPath); rerr != nil {
				// Rename may fail across filesystems; fall back to copy.
				if cerr := copyFile(tmpPath, finalPath); cerr != nil {
					done <- guestResult{fmt.Errorf("save file: %w", cerr)}
					return
				}
				_ = os.Remove(tmpPath)
			}
			done <- guestResult{nil}
		}
	})
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

// copyFile is a fallback for cross-device rename.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err = io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
