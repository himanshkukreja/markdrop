// Package cmd implements the markdrop CLI using cobra.
package cmd

import (
	"github.com/spf13/cobra"
)

// Persistent flag values shared across subcommands.
var (
	flagServer string // API base URL (http/https)
	flagOrigin string // WebSocket Origin header
	flagWeb    string // web app base URL used in share links
)

// defaultServer is the production API endpoint.
const defaultServer = "https://api.markdrop.in"

// defaultOrigin must match one of the CORS allowed origins in the backend.
const defaultOrigin = "https://www.markdrop.in"

// version is the CLI version. Release builds set it from the git tag via
// -ldflags "-X github.com/markdrop/cli/cmd.version=<ver>"; this default is what
// a plain `go build` / `go install` reports.
var version = "0.3.0"

var rootCmd = &cobra.Command{
	Use:   "markdrop",
	Short: "markdrop — peer-to-peer file sharing from the terminal",
	Long: `markdrop lets you share files directly between machines with no cloud storage.

  Transfers are end-to-end encrypted via WebRTC DataChannel.
  The signalling server only sees tiny handshake messages — never your files.

Examples:
  markdrop send report.pdf
  markdrop get https://markdrop.in/share/a3f7c12e
  markdrop get a3f7c12e -o ~/Downloads
  markdrop mcp            # local MCP server for AI assistants (stdio)`,
	// A failed transfer is not a usage mistake: print the error, not the help.
	SilenceUsage: true,
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
	rootCmd.PersistentFlags().StringVar(
		&flagWeb, "web", "",
		"Base URL of the markdrop web app used in share links (default: https://markdrop.in for the production server)",
	)

	rootCmd.AddCommand(sendCmd)
	rootCmd.AddCommand(getCmd)
	rootCmd.AddCommand(mcpCmd)
}
