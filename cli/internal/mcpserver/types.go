package mcpserver

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// ShareFilesInput is share_files' input.
type ShareFilesInput struct {
	Paths []string `json:"paths" jsonschema:"Files or folders to share (absolute, ~/..., or relative to the app's working folder). Several paths, or a folder, are sent as one zip that Markdrop's CLI unpacks."`
}

// ShareInfo describes one share (share_files' output and share_status rows).
type ShareInfo struct {
	ShareID                string   `json:"share_id" jsonschema:"Id of the share (the room id in the link)"`
	URL                    string   `json:"url" jsonschema:"Link to give the recipient; it opens in any browser or works with markdrop get"`
	FileName               string   `json:"file_name" jsonschema:"Name the recipient sees"`
	FileCount              int      `json:"file_count" jsonschema:"Number of files shared"`
	TotalBytes             int64    `json:"total_bytes" jsonschema:"Bytes each recipient downloads"`
	State                  string   `json:"state" jsonschema:"waiting | connecting | transferring | stopped | error"`
	Progress               Progress `json:"progress" jsonschema:"Progress of the recipient being served now"`
	RecipientsServed       int      `json:"recipients_served" jsonschema:"Recipients who have received everything"`
	LastCompletedAt        string   `json:"last_completed_at,omitempty" jsonschema:"When the last recipient finished (RFC 3339)"`
	LastError              string   `json:"last_error,omitempty" jsonschema:"The most recent problem, if any"`
	StartedAt              string   `json:"started_at" jsonschema:"When sharing started (RFC 3339)"`
	SignallingReconnecting bool     `json:"signalling_reconnecting,omitempty" jsonschema:"True while the connection to markdrop.in is being re-established"`
}

// ShareFilesOutput is share_files' output.
type ShareFilesOutput struct {
	ShareID    string `json:"share_id" jsonschema:"Id of the share, for share_status and stop_share"`
	URL        string `json:"url" jsonschema:"Link to give the recipient; it opens in any browser, or use markdrop get"`
	FileName   string `json:"file_name" jsonschema:"Name the recipient sees"`
	FileCount  int    `json:"file_count" jsonschema:"Number of files shared"`
	TotalBytes int64  `json:"total_bytes" jsonschema:"Bytes each recipient downloads"`
	Expires    string `json:"expires" jsonschema:"When the link stops working"`
}

// Progress is bytes moved out of the total.
type Progress struct {
	Bytes   int64   `json:"bytes"`
	Total   int64   `json:"total"`
	Percent float64 `json:"percent"`
}

// ShareStatusInput is share_status' input.
type ShareStatusInput struct {
	ShareID string `json:"share_id,omitempty" jsonschema:"A share_id or receive_id to report on; omit for everything in this session"`
}

// ReceiveInfo describes one receive.
type ReceiveInfo struct {
	ReceiveID string   `json:"receive_id"`
	Link      string   `json:"link"`
	State     string   `json:"state" jsonschema:"waiting | connecting | transferring | done | stopped | error"`
	FileName  string   `json:"file_name,omitempty"`
	Progress  Progress `json:"progress"`
	Directory string   `json:"directory" jsonschema:"Folder the download is saved into"`
	SavedTo   []string `json:"saved_to,omitempty" jsonschema:"Where the file (or a folder's top-level items) was saved, once done"`
	LastError string   `json:"last_error,omitempty"`
	StartedAt string   `json:"started_at"`
}

// StatusOutput is share_status' output.
type StatusOutput struct {
	Shares   []ShareInfo   `json:"shares"`
	Receives []ReceiveInfo `json:"receives"`
}

// StopShareInput is stop_share's input.
type StopShareInput struct {
	ShareID string `json:"share_id" jsonschema:"The share_id from share_files (a receive_id cancels that download)"`
}

// StopResult is stop_share's output.
type StopResult struct {
	ID               string `json:"share_id"`
	Kind             string `json:"kind" jsonschema:"share or receive"`
	State            string `json:"state"`
	RecipientsServed int    `json:"recipients_served"`
}

// ReceiveShareInput is receive_share's input.
type ReceiveShareInput struct {
	Link      string `json:"link" jsonschema:"A Markdrop share link (https://markdrop.in/share/<id>) or just the id"`
	Directory string `json:"directory,omitempty" jsonschema:"Folder to save into (default ~/Downloads/Markdrop; created if missing). Existing files are never overwritten."`
}

// ReceiveShareOutput is receive_share's output.
type ReceiveShareOutput struct {
	ReceiveID string `json:"receive_id"`
	State     string `json:"state"`
	Directory string `json:"directory"`
}

// roomID mirrors _ROOM_ID in backend/app/routers/share.py.
var roomID = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

// ParseShareLink accepts https://markdrop.in/share/<id> (also www., any
// host in dev) or a bare id, and returns the id.
func ParseShareLink(link string) (string, error) {
	link = strings.TrimSpace(link)
	if link == "" {
		return "", fmt.Errorf("link is empty")
	}
	id := link
	if strings.Contains(link, "/") {
		raw := link
		if !strings.Contains(raw, "://") {
			raw = "https://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return "", fmt.Errorf("%q is not a Markdrop share link", link)
		}
		segs := strings.Split(strings.Trim(u.Path, "/"), "/")
		id = ""
		for i, s := range segs {
			if s == "share" && i+1 < len(segs) {
				id = segs[i+1]
				break
			}
		}
		if id == "" {
			return "", fmt.Errorf("%q is not a Markdrop share link (expected …/share/<id>)", link)
		}
	}
	if !roomID.MatchString(id) {
		return "", fmt.Errorf("%q is not a valid share id", id)
	}
	return id, nil
}
