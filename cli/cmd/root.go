// Package cmd implements the markdrop CLI using cobra.
package cmd

import (
	"github.com/spf13/cobra"
)

// Persistent flag values shared across subcommands.
var (
	flagServer string // API base URL (http/https)
	flagOrigin string // WebSocket Origin header
)

// defaultServer is the production API endpoint.
const defaultServer = "https://api.markdrop.in"

// defaultOrigin must match one of the CORS allowed origins in the backend.
const defaultOrigin = "https://www.markdrop.in"

// version is set at build time via -ldflags "-X github.com/markdrop/cli/cmd.version=<ver>".
var version = "dev"

var rootCmd = &cobra.Command{
	Use:   "markdrop",
	Short: "markdrop — peer-to-peer file sharing from the terminal",
	Long: `markdrop lets you share files directly between machines with no cloud storage.

  Transfers are end-to-end encrypted via WebRTC DataChannel.
  The signalling server only sees tiny handshake messages — never your files.

Examples:
  markdrop send report.pdf
  markdrop get https://markdrop.in/share/a3f7c12e
  markdrop get a3f7c12e -o ~/Downloads`,
}

// Execute is called from main.go.
func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.Version = version
	rootCmd.PersistentFlags().StringVar(
		&flagServer, "server", defaultServer,
		"API base URL of the markdrop signalling server",
	)
	rootCmd.PersistentFlags().StringVar(
		&flagOrigin, "origin", defaultOrigin,
		"Origin header for the WebSocket handshake (must match server CORS config)",
	)

	rootCmd.AddCommand(sendCmd)
	rootCmd.AddCommand(getCmd)
}
