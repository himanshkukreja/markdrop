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
	"syscall"

	"github.com/markdrop/cli/internal/peer"
	"github.com/markdrop/cli/internal/signaling"
	"github.com/markdrop/cli/internal/ui"
	"github.com/spf13/cobra"
)

var sendCmd = &cobra.Command{
	Use:   "send <file>",
	Short: "Share a file with a recipient via a one-time share link",
	Long: `Send a file peer-to-peer. A share URL is generated and displayed.
  Share the URL (or the room ID) with your recipient.
  The process stays alive until the recipient downloads the file.`,
	Args: cobra.ExactArgs(1),
	RunE: runSend,
}

func runSend(_ *cobra.Command, args []string) error {
	filePath := args[0]

	// Validate file exists and is readable.
	fi, err := os.Stat(filePath)
	if err != nil {
		return fmt.Errorf("cannot access %q: %w", filePath, err)
	}
	if fi.IsDir() {
		return fmt.Errorf("%q is a directory — only individual files are supported", filePath)
	}

	roomID := generateRoomID()
	shareURL := buildShareURL(flagServer, roomID)
	fileSize := formatBytes(fi.Size())

	// Print info box + QR code.
	ui.PrintSendReady(filepath.Base(filePath), fileSize, roomID, shareURL)
	ui.PrintQR(shareURL)

	// Context cancelled by SIGINT / SIGTERM.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Connect to signalling server as host.
	stopSpin := ui.Spinner("Connecting to signalling server…")
	sig, err := signaling.Connect(flagServer, roomID, "host", flagOrigin)
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

	// Progress bar.
	bar := ui.NewProgressBar(fi.Size(), "Sending  ")
	onProgress := func(sent, _ int64) {
		_ = bar.Set64(sent)
	}

	if err = peer.RunHost(ctx, sig, filePath, onProgress); err != nil {
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
	msgCh := make(chan error, 1)
	go func() {
		for {
			_, raw, err := sig.ReadMsg()
			if err != nil {
				msgCh <- err
				return
			}
			var hdr struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &hdr) == nil && hdr.Type == "guest-joined" {
				msgCh <- nil
				return
			}
		}
	}()
	select {
	case err := <-msgCh:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
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

// buildShareURL constructs the browser-friendly share URL.
func buildShareURL(server, roomID string) string {
	// For the default production server, use the canonical web URL.
	if server == defaultServer {
		return fmt.Sprintf("https://markdrop.in/share/%s", roomID)
	}
	// For local dev: replace port 8080 with 3000.
	webBase := replacePort(server, "8080", "3000")
	return fmt.Sprintf("%s/share/%s", webBase, roomID)
}

func replacePort(url, from, to string) string {
	old := ":" + from
	newPort := ":" + to
	for i := len(url) - 1; i >= 0; i-- {
		if url[i] == ':' {
			candidate := url[i : i+len(old)]
			if candidate == old {
				return url[:i] + newPort + url[i+len(old):]
			}
			break
		}
	}
	return url
}

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
