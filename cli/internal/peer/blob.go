package peer

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
)

// ShareMeta is what a sender tells the signalling server about a share so it
// can be listed for the signed-in owner (backend/app/services/share_event.py).
type ShareMeta struct {
	Name  string // file name (for several files, the name recipients see)
	Size  int64  // total bytes
	Mime  string
	Token string // MARKDROP_TOKEN (an mdk_ API token) or "" for anonymous
	Count int    // number of files
}

// blobPayload keeps the browser's key order: {n,s,m,t,c}.
type blobPayload struct {
	N string  `json:"n"`
	S int64   `json:"s"`
	M string  `json:"m"`
	T *string `json:"t"`
	C int     `json:"c"`
}

// EncodeShareMeta encodes meta exactly as encodeShareMeta in
// frontend/src/lib/webrtc.ts does: JSON {n,s,m,t,c} (t null when anonymous),
// UTF-8, base64url without padding. It rides on the offer as field `x`; the
// server logs it and strips it before relaying the offer.
func EncodeShareMeta(meta ShareMeta) string {
	p := blobPayload{N: meta.Name, S: meta.Size, M: meta.Mime, C: meta.Count}
	if meta.Token != "" {
		t := meta.Token
		p.T = &t
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // JSON.stringify leaves <, > and & alone
	_ = enc.Encode(p)
	return base64.RawURLEncoding.EncodeToString(bytes.TrimRight(buf.Bytes(), "\n"))
}
