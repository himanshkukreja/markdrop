package cmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/markdrop/cli/internal/peer"
	"github.com/markdrop/cli/internal/signaling"
	"github.com/markdrop/cli/internal/ui"
	"github.com/spf13/cobra"
)

var sendCmd = &cobra.Command{
	Use:   "send <file|folder>",
	Short: "Share a file or folder with a recipient via a one-time share link",
	Long: `Send a file or folder peer-to-peer. A share URL is generated and displayed.
  Share the URL (or the room ID) with your recipient.
  The process stays alive until the recipient downloads the file.

  Folders are transparently compressed (zip) on the sender side and
  automatically extracted on the CLI receiver side. The recipient gets
  the original folder structure, not a zip file.

  Set MARKDROP_TOKEN to an API token (Settings → API tokens on markdrop.in)
  to have the share listed under your account.`,
	Args: cobra.ExactArgs(1),
	RunE: runSend,
}

func runSend(_ *cobra.Command, args []string) error {
	filePath := args[0]

	// Validate path exists and is readable.
	fi, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("cannot access %q: %w", filePath, err)
	}

	roomID := generateRoomID()
	shareURL := buildShareURL(flagServer, flagWeb, roomID)

	displayName := filepath.Base(filePath)
	displaySize := formatBytes(fi.Size())
	if fi.IsDir() {
		displayName += "/"
		displaySize = "(folder — will be compressed before sending)"
	}

	// Print info box + QR code.
	ui.PrintSendReady(displayName, displaySize, roomID, shareURL)
	ui.PrintQR(shareURL)

	// Context cancelled by SIGINT / SIGTERM.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Connect to signalling server as host.
	stopSpin := ui.Spinner("Connecting to signalling server…")
	sig, err := signaling.Dial(ctx, signaling.Options{
		Server: flagServer, Room: roomID, Role: "host", Origin: flagOrigin,
	})
	stopSpin()
	if err != nil {
		return fmt.Errorf("could not connect to signalling server: %w", err)
	}
	defer sig.Close()

	// Wait for guest to join — poll the signalling channel.
	stopSpin = ui.Spinner("Waiting for recipient to open the link…")
	waitErr := waitForGuest(ctx, sig)
	stopSpin()
	if waitErr != nil {
		if ctx.Err() != nil {
			fmt.Println()
			ui.Info("Interrupted — no file was sent.")
			return nil
		}
		return waitErr
	}
	ui.Success("Recipient connected — establishing P2P link…")

	// For folders, the source is compressed first; show a note.
	if fi.IsDir() {
		ui.Info("Compressing folder…")
	}
	src, err := peer.SourceFromPath(filePath)
	if err != nil {
		return err
	}
	defer src.Close()

	bar := ui.NewProgressBar(src.Size, "Sending  ")
	onProgress := func(sent, total int64) {
		bar.ChangeMax64(total)
		_ = bar.Set64(sent)
	}

	err = peer.ServeOne(ctx, sig, src, peer.HostOptions{OnProgress: onProgress, Blob: shareBlob(src)})
	if err != nil {
		if ctx.Err() != nil {
			fmt.Println()
			ui.Info("Interrupted.")
			return nil
		}
		return err
	}

	_ = bar.Finish()
	ui.Success(fmt.Sprintf("Transfer complete! %s sent to recipient.", filepath.Base(filePath)))
	return nil
}

// waitForGuest blocks until the server sends {"type":"guest-joined"} or ctx is done.
func waitForGuest(ctx context.Context, sig *signaling.Client) error {
	for {
		select {
		case raw, ok := <-sig.Messages():
			if !ok {
				if err := sig.Err(); err != nil {
					return err
				}
				return fmt.Errorf("signalling closed")
			}
			var hdr struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &hdr) == nil && hdr.Type == "guest-joined" {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// shareBlob is the share-metadata blob for the offer when MARKDROP_TOKEN is
// set (so the share is listed under the token owner's account), else "".
// Without a token the CLI tells the server nothing about the file, as before.
func shareBlob(src *peer.Source) string {
	token := strings.TrimSpace(os.Getenv("MARKDROP_TOKEN"))
	if token == "" {
		return ""
	}
	return peer.EncodeShareMeta(peer.ShareMeta{
		Name: src.Name, Size: src.Size, Mime: src.MimeType, Token: token, Count: src.FileCount,
	})
}

// generateRoomID generates a 10-character hex room ID using crypto/rand.
// Mirrors generateRoomId() in frontend/src/lib/webrtc.ts.
func generateRoomID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)[:10]
}

// generateHostKey makes the 32-hex key that proves to the signalling server a
// reconnecting socket is this sender (randomHostKey in the browser's sender.ts).
func generateHostKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// buildShareURL constructs the browser-friendly share URL. web, when set, is
// the web app's base URL (--web); otherwise the production site for the
// production API, or the API URL with port 8080 swapped for 3000 in local dev.
func buildShareURL(server, web, roomID string) string {
	if web != "" {
		return fmt.Sprintf("%s/share/%s", strings.TrimRight(web, "/"), roomID)
	}
	if server == defaultServer {
		return fmt.Sprintf("https://markdrop.in/share/%s", roomID)
	}
	webBase := replacePort(strings.TrimRight(server, "/"), "8080", "3000")
	return fmt.Sprintf("%s/share/%s", webBase, roomID)
}

func replacePort(url, from, to string) string {
	old := ":" + from
	newPort := ":" + to
	for i := len(url) - 1; i >= 0; i-- {
		if url[i] == ':' {
			if strings.HasPrefix(url[i:], old) {
				return url[:i] + newPort + url[i+len(old):]
			}
			break
		}
	}
	return url
}

func formatBytes(b int64) string { return peer.FormatBytes(b) }
