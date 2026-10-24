// Package mcpserver is `markdrop mcp`: a local Model Context Protocol server
// (stdio) that lets an AI app on this computer send and receive files
// peer-to-peer with Markdrop. Bytes go straight from this device to the
// recipient's; markdrop.in only relays the handshake.
//
// stdout carries the protocol. Nothing in this package may print to it.
package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ServerName is the MCP server name clients show.
const ServerName = "markdrop-p2p"

const expires = "when this app closes or stop_share is called"

const instructions = `Markdrop P2P sends files straight from this computer to whoever opens the link (no upload to a cloud drive), and downloads files someone shared with a Markdrop link.

- share_files starts a share and returns a link; it keeps serving recipients one at a time until stop_share or until this app closes. Anyone with the link can download, so only share what the user asked to share, and give the link only to the user.
- receive_share downloads a Markdrop link into ~/Downloads/Markdrop (or a folder the user names) in the background.
- share_status reports progress of both.
Well-known secret locations (SSH and cloud credentials, keychains, .env files, private keys) are refused.`

func boolPtr(b bool) *bool { return &b }

// NewServer builds the MCP server with its four tools.
func NewServer(m *Manager, version string) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{
		Name:       ServerName,
		Title:      "Markdrop P2P sharing",
		Version:    version,
		WebsiteURL: "https://markdrop.in/mcp",
	}, &mcp.ServerOptions{Instructions: instructions})

	shareSchema := mustSchema[ShareFilesInput]()
	paths := shareSchema.Properties["paths"]
	paths.MinItems = jsonschema.Ptr(1)
	paths.MaxItems = jsonschema.Ptr(100)
	paths.Items = &jsonschema.Schema{Type: "string", MinLength: jsonschema.Ptr(1)}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "share_files",
		Title: "Share files peer-to-peer",
		Description: "Shares files or folders from this computer peer-to-peer and returns a Markdrop link " +
			"(https://markdrop.in/share/<id>). The recipient opens it in any browser (or runs `markdrop get <link>`) and " +
			"the bytes stream directly from this device, end-to-end encrypted; nothing is uploaded to a server. " +
			"One file is sent as-is; several paths or a folder are sent as one zip (Markdrop's CLI unpacks it). " +
			"The link keeps working, for one recipient at a time, until stop_share is called or this app closes. " +
			"Anyone with the link can download, so share only what the user asked for. Secret locations " +
			"(~/.ssh, ~/.aws, keychains, .env files, private keys, …) are refused.",
		InputSchema: shareSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Share files peer-to-peer", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ShareFilesInput) (*mcp.CallToolResult, ShareFilesOutput, error) {
		info, err := m.StartShare(in.Paths)
		if err != nil {
			return nil, ShareFilesOutput{}, err
		}
		out := ShareFilesOutput{
			ShareID: info.ShareID, URL: info.URL, FileName: info.FileName,
			FileCount: info.FileCount, TotalBytes: info.TotalBytes, Expires: expires,
		}
		what := info.FileName
		if info.FileCount > 1 {
			what = fmt.Sprintf("%s (%d files)", info.FileName, info.FileCount)
		}
		return text(fmt.Sprintf(
			"Sharing %s, %s. Link: %s\nThe link works while this app stays open (one recipient at a time); "+
				"check progress with share_status and end it with stop_share (share_id %s).",
			what, humanBytes(info.TotalBytes), info.URL, info.ShareID)), out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "share_status",
		Title: "Status of shares and downloads",
		Description: "Reports every share and download started in this session (or just one, by share_id or receive_id): " +
			"state (waiting, connecting, transferring, done, stopped, error), progress in bytes and percent, " +
			"how many recipients a share has served, where a download was saved, and the last error.",
		Annotations: &mcp.ToolAnnotations{
			Title: "Status of shares and downloads", ReadOnlyHint: true, DestructiveHint: boolPtr(false),
			IdempotentHint: true, OpenWorldHint: boolPtr(false),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ShareStatusInput) (*mcp.CallToolResult, StatusOutput, error) {
		out, err := m.Status(strings.TrimSpace(in.ShareID))
		if err != nil {
			return nil, StatusOutput{}, err
		}
		return text(statusText(out)), *out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "stop_share",
		Title: "Stop sharing",
		Description: "Stops a share started with share_files: anyone downloading is told the sender stopped, and the " +
			"link stops working. Stopping an already stopped share is harmless. Given a receive_id, cancels that download.",
		Annotations: &mcp.ToolAnnotations{
			Title: "Stop sharing", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: true, OpenWorldHint: boolPtr(false),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in StopShareInput) (*mcp.CallToolResult, StopResult, error) {
		res, err := m.StopShare(strings.TrimSpace(in.ShareID))
		if err != nil {
			return nil, StopResult{}, err
		}
		msg := fmt.Sprintf("Stopped share %s (%d recipient(s) served).", res.ID, res.RecipientsServed)
		if res.Kind == "receive" {
			msg = fmt.Sprintf("Download %s: %s.", res.ID, res.State)
		}
		return text(msg), *res, nil
	})

	recvSchema := mustSchema[ReceiveShareInput]()
	recvSchema.Properties["link"].MinLength = jsonschema.Ptr(6)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "receive_share",
		Title: "Download a Markdrop share",
		Description: "Downloads the file(s) behind a Markdrop share link (https://markdrop.in/share/<id>) straight from the " +
			"sender's device into a folder on this computer (default ~/Downloads/Markdrop, created if missing). Runs in " +
			"the background; follow it with share_status. Existing files are never overwritten (a new name is used), and " +
			"a shared folder is unpacked. The sender must still have the link open.",
		InputSchema: recvSchema,
		Annotations: &mcp.ToolAnnotations{
			Title: "Download a Markdrop share", ReadOnlyHint: false, DestructiveHint: boolPtr(false),
			IdempotentHint: false, OpenWorldHint: boolPtr(true),
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ReceiveShareInput) (*mcp.CallToolResult, ReceiveShareOutput, error) {
		info, err := m.StartReceive(in.Link, in.Directory)
		if err != nil {
			return nil, ReceiveShareOutput{}, err
		}
		out := ReceiveShareOutput{ReceiveID: info.ReceiveID, State: info.State, Directory: info.Directory}
		return text(fmt.Sprintf("Downloading into %s (receive_id %s). Check progress with share_status.",
			info.Directory, info.ReceiveID)), out, nil
	})
	return s
}

func mustSchema[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](nil)
	if err != nil {
		panic(err)
	}
	return s
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func statusText(out *StatusOutput) string {
	if len(out.Shares) == 0 && len(out.Receives) == 0 {
		return "Nothing shared or downloaded in this session yet."
	}
	var b strings.Builder
	for _, s := range out.Shares {
		fmt.Fprintf(&b, "Share %s (%s, %s): %s", s.ShareID, s.FileName, humanBytes(s.TotalBytes), s.State)
		if s.State == StateTransferring {
			fmt.Fprintf(&b, " %.1f%%", s.Progress.Percent)
		}
		fmt.Fprintf(&b, ", %d recipient(s) served. %s", s.RecipientsServed, s.URL)
		if s.LastError != "" {
			fmt.Fprintf(&b, " Last problem: %s.", s.LastError)
		}
		b.WriteString("\n")
	}
	for _, r := range out.Receives {
		fmt.Fprintf(&b, "Download %s: %s", r.ReceiveID, r.State)
		if r.FileName != "" {
			fmt.Fprintf(&b, " %s", r.FileName)
		}
		if r.State == StateTransferring {
			fmt.Fprintf(&b, " %.1f%%", r.Progress.Percent)
		}
		if len(r.SavedTo) > 0 {
			fmt.Fprintf(&b, ", saved to %s", strings.Join(r.SavedTo, ", "))
		}
		if r.LastError != "" {
			fmt.Fprintf(&b, ". %s", r.LastError)
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func humanBytes(b int64) string {
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
