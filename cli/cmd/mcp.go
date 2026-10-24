package cmd

import (
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/fatih/color"
	"github.com/markdrop/cli/internal/mcpserver"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Run a local MCP server so AI apps can send and receive files peer-to-peer",
	Long: `Run Markdrop's local Model Context Protocol server over stdio.

  AI apps on this computer (Claude Code, Claude Desktop, Cursor, VS Code, …)
  start it themselves; you don't run it by hand. It gives them four tools:

    share_files    share files or folders and get a markdrop.in/share link
    share_status   progress of shares and downloads
    stop_share     stop a share (or cancel a download)
    receive_share  download a Markdrop link into ~/Downloads/Markdrop

  Shares live as long as this process: when the app closes, every link stops.

  Claude Code:  claude mcp add markdrop-p2p -- markdrop mcp
  Others:       {"mcpServers": {"markdrop-p2p": {"command": "markdrop", "args": ["mcp"]}}}

Environment:
  MARKDROP_TOKEN               API token (markdrop.in → Settings → API tokens);
                               shares then appear in your account (list_shares).
  MARKDROP_MCP_ALLOW_ANY_PATH  set to 1 to allow sharing secret locations
                               (~/.ssh, ~/.aws, .env files, …), refused by default.`,
	Args: cobra.NoArgs,
	RunE: runMCP,
}

func runMCP(_ *cobra.Command, _ []string) error {
	// stdout is the protocol. Keep the real one for the transport and point
	// everything else that might print (a stray fmt.Println, a library) at
	// stderr, where MCP clients collect logs.
	protocolOut := os.Stdout
	os.Stdout = os.Stderr
	color.Output = os.Stderr
	logger := log.New(os.Stderr, "markdrop mcp: ", log.LstdFlags)

	home, _ := os.UserHomeDir()
	downloads := filepath.Join(home, "Downloads", "Markdrop")
	if home == "" {
		downloads = "Markdrop"
	}

	mgr := mcpserver.NewManager(mcpserver.Config{
		Server:     flagServer,
		Origin:     flagOrigin,
		ShareURL:   func(id string) string { return buildShareURL(flagServer, flagWeb, id) },
		Token:      strings.TrimSpace(os.Getenv("MARKDROP_TOKEN")),
		Downloads:  downloads,
		Log:        logger,
		NewRoomID:  generateRoomID,
		NewHostKey: generateHostKey,
	})
	server := mcpserver.NewServer(mgr, version)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	logger.Printf("v%s ready (server %s)", version, flagServer)
	err := server.Run(ctx, &mcp.IOTransport{Reader: os.Stdin, Writer: nopWriteCloser{protocolOut}})

	// stdin closed (the app quit) or a signal: end every share cleanly so
	// recipients hear "sender stopped" now rather than after a timeout.
	mgr.Shutdown(5 * time.Second)
	if err != nil && ctx.Err() == nil && err != io.EOF {
		logger.Printf("session ended: %v", err)
	}
	return nil
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
