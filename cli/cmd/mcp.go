package cmd

import (
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/fatih/color"
	"github.com/markdrop/cli/internal/files"
	"github.com/markdrop/cli/internal/mcpserver"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Run a local MCP server so AI apps can publish, replace and share files",
	Long: `Run Markdrop's local Model Context Protocol server over stdio.

  AI apps on this computer (Claude Code, Claude Desktop, Cursor, VS Code, …)
  start it themselves; you don't run it by hand. It gives them these tools:

    upload_file           publish a local file (video, PDF, …) behind a markdrop.in link
    replace_file          swap the file behind an existing link (same link, old version kept)
    list_file_versions    a published file's versions
    restore_file_version  make an earlier version current again
    get_file_info         size, sha256, version, media details of a published file
    list_workspaces       your workspaces and their custom domains (for upload_file)
    list_folders          a workspace's folders (for upload_file's folder)

    share_files    share files or folders peer-to-peer and get a markdrop.in/share link
    share_status   progress of shares and downloads
    stop_share     stop a share (or cancel a download)
    receive_share  download a Markdrop share link into ~/Downloads/Markdrop

  The file and workspace tools need an API token. Peer-to-peer shares live as
  long as this process: when the app closes, every share link stops.

  Claude Code:  claude mcp add markdrop-p2p -e MARKDROP_TOKEN=mdk_… -- markdrop mcp
  Others:       {"mcpServers": {"markdrop-p2p": {"command": "markdrop", "args": ["mcp"],
                 "env": {"MARKDROP_TOKEN": "mdk_…"}}}}
  After markdrop login, the env entry can be left out.

Environment:
  MARKDROP_TOKEN               API token (markdrop.in → Settings → API tokens). Without
                               it, the token saved by markdrop login is used. Needed by
                               the file and workspace tools; with it, shares also appear
                               in your account.
  MARKDROP_CONFIG_DIR          folder holding the token saved by markdrop login.
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

	filesToken, _ := files.ResolveToken("")
	mgr := mcpserver.NewManager(mcpserver.Config{
		Server:      flagServer,
		Origin:      flagOrigin,
		ShareURL:    func(id string) string { return buildShareURL(flagServer, flagWeb, id) },
		Token:       filesToken,
		Downloads:   downloads,
		Log:         logger,
		NewRoomID:   generateRoomID,
		NewHostKey:  generateHostKey,
		FilesToken:  filesToken,
		UserAgent:   "markdrop-cli/" + version + " (mcp)",
		NewUploader: newUploader,
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
