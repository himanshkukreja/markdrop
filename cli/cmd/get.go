package cmd

import (
	"context"
	"fmt"
	"net/url"
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

var (
	flagOutput     string
	flagAutoAccept bool
)

var getCmd = &cobra.Command{
	Use:   "get <room-id|url>",
	Short: "Download a file shared by a sender",
	Long: `Connect to a sender and download their shared file.

  You can pass either the full share URL or just the room ID:
    markdrop get https://markdrop.in/share/a3f7c12e
    markdrop get a3f7c12e`,
	Args: cobra.ExactArgs(1),
	RunE: runGet,
}

func init() {
	getCmd.Flags().StringVarP(&flagOutput, "output", "o", "", "Output directory or file path (default: current directory)")
	getCmd.Flags().BoolVarP(&flagAutoAccept, "yes", "y", false, "Auto-accept download without prompting")
}

func runGet(_ *cobra.Command, args []string) error {
	roomID, err := parseRoomID(args[0])
	if err != nil {
		return err
	}

	// Resolve output directory and optional explicit filename.
	outputDir := "."
	outputFile := ""
	if flagOutput != "" {
		// If the path ends with a known extension, treat it as a file path.
		if ext := filepath.Ext(flagOutput); ext != "" {
			outputDir = filepath.Dir(flagOutput)
			outputFile = filepath.Base(flagOutput)
		} else {
			outputDir = flagOutput
		}
		if err = os.MkdirAll(outputDir, 0o755); err != nil {
			return fmt.Errorf("create output directory: %w", err)
		}
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Connect to signalling server as guest.
	stopSpin := ui.Spinner("Connecting to sender…")
	sig, err := signaling.Connect(flagServer, roomID, "guest", flagOrigin)
	stopSpin()
	if err != nil {
		return fmt.Errorf("could not connect to signalling server: %w", err)
	}
	defer sig.Close()

	ui.Info("Establishing encrypted P2P connection…")

	var bar interface {
		Set64(n int64) error
		Finish() error
	}

	onMeta := func(m peer.FileMeta) {
		ui.Success(fmt.Sprintf("P2P connection established"))
		ui.Info(fmt.Sprintf("File : %s", m.Name))
		ui.Info(fmt.Sprintf("Size : %s", formatBytes(m.Size)))
		if !flagAutoAccept {
			// Progress bar is created after user accepts in guest.go — mirror here.
		} else {
			bar = ui.NewProgressBar(m.Size, "Receiving")
		}
	}

	onProgress := func(received, total int64) {
		if bar != nil {
			_ = bar.Set64(received)
		}
	}

	// For non-auto-accept, the progress bar is created AFTER the prompt in
	// guest.go. We recreate it here by hooking via a wrapper.
	var barReady bool
	var barTotal int64

	wrappedOnMeta := func(m peer.FileMeta) {
		barTotal = m.Size
		onMeta(m)
	}

	wrappedOnProgress := func(received, total int64) {
		if bar == nil && !barReady {
			barReady = true
			bar = ui.NewProgressBar(barTotal, "Receiving")
		}
		onProgress(received, total)
	}

	if err = peer.RunGuest(ctx, sig, outputDir, outputFile, flagAutoAccept, wrappedOnProgress, wrappedOnMeta); err != nil {
		if ctx.Err() != nil {
			fmt.Println()
			ui.Info("Interrupted.")
			return nil
		}
		return err
	}

	if bar != nil {
		_ = bar.Finish()
	}

	finalName := outputFile
	if finalName == "" {
		finalName = "(filename from sender)"
	}
	savedAt := filepath.Join(outputDir, finalName)
	ui.Success(fmt.Sprintf("Saved to %s", savedAt))
	return nil
}

// parseRoomID extracts the 10-char room ID from either a bare ID or a full URL.
func parseRoomID(input string) (string, error) {
	input = strings.TrimSpace(input)
	// Looks like a URL.
	if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") {
		u, err := url.Parse(input)
		if err != nil {
			return "", fmt.Errorf("invalid URL: %w", err)
		}
		segments := strings.Split(strings.Trim(u.Path, "/"), "/")
		// Expected path: /share/<roomID>
		for i, seg := range segments {
			if seg == "share" && i+1 < len(segments) {
				return segments[i+1], nil
			}
		}
		return "", fmt.Errorf("could not find room ID in URL %q — expected .../share/<room-id>", input)
	}
	// Bare room ID.
	if len(input) == 0 {
		return "", fmt.Errorf("room ID cannot be empty")
	}
	return input, nil
}
