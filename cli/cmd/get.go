package cmd

import (
	"bufio"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
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
	sig, err := signaling.Dial(ctx, signaling.Options{
		Server: flagServer, Room: roomID, Role: "guest", Origin: flagOrigin,
	})
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
	var total int64

	opts := peer.GuestOptions{
		OutputDir:  outputDir,
		OutputFile: outputFile,
		OnMeta: func(m peer.FileMeta) {
			total = m.Size
			ui.Success("P2P connection established")
			ui.Info(fmt.Sprintf("File : %s", m.Name))
			ui.Info(fmt.Sprintf("Size : %s", formatBytes(m.Size)))
		},
		OnProgress: func(received, _ int64) {
			if bar == nil {
				bar = ui.NewProgressBar(total, "Receiving")
			}
			_ = bar.Set64(received)
		},
		OnWaiting: func() {
			ui.Info("The sender is away — waiting for them to reconnect…")
		},
	}
	if !flagAutoAccept {
		opts.Confirm = func(m peer.FileMeta) bool {
			fmt.Printf("\n  Accept download of %q (%s)? [Y/n]: ", m.Name, formatBytes(m.Size))
			ans, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			ans = strings.TrimSpace(strings.ToLower(ans))
			return ans != "n" && ans != "no"
		}
	}

	res, err := peer.Receive(ctx, sig, opts)
	if err != nil {
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
	for _, p := range res.Saved {
		ui.Success(fmt.Sprintf("Saved to %s", p))
	}
	return nil
}

// roomIDPattern mirrors _ROOM_ID in backend/app/routers/share.py.
var roomIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

// parseRoomID extracts the room ID from either a bare ID or a full URL
// (https://markdrop.in/share/<id>, www., localhost in dev, …).
func parseRoomID(input string) (string, error) {
	input = strings.TrimSpace(input)
	id := input
	// Looks like a URL.
	if strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://") {
		u, err := url.Parse(input)
		if err != nil {
			return "", fmt.Errorf("invalid URL: %w", err)
		}
		id = ""
		segments := strings.Split(strings.Trim(u.Path, "/"), "/")
		// Expected path: /share/<roomID>
		for i, seg := range segments {
			if seg == "share" && i+1 < len(segments) {
				id = segments[i+1]
				break
			}
		}
		if id == "" {
			return "", fmt.Errorf("could not find room ID in URL %q — expected .../share/<room-id>", input)
		}
	}
	if id == "" {
		return "", fmt.Errorf("room ID cannot be empty")
	}
	if !roomIDPattern.MatchString(id) {
		return "", fmt.Errorf("%q is not a valid share id", id)
	}
	return id, nil
}
