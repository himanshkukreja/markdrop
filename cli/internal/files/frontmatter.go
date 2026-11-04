package files

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Page properties live in the page's Markdown as front matter (the server's
// services/page_props.py, which this mirrors):
//
//	---
//	icon: 🚀                  # an emoji, or asset:<id> (an image uploaded to the page)
//	cover: asset:<id>         # or gallery:<name>, or an https URL
//	cover_y: 35               # 0 (top) .. 100 (bottom); default 50
//	full_width: true
//	small_text: true
//	font: serif               # default | serif | mono
//	locked: true
//	allow_export: false
//	---
//
// ApplyPageProps writes changes into that block and keeps every other line
// (unknown keys too) where it was, so a page round-trips byte for byte.

// PagePropKeys are the page's own properties, in the order they are written.
var PagePropKeys = []string{"icon", "cover", "cover_y", "full_width", "small_text", "font", "locked", "allow_export"}

// PageFonts are the values font takes.
var PageFonts = []string{"default", "serif", "mono"}

var pagePropDefaults = map[string]any{
	"icon": nil, "cover": nil, "cover_y": 50, "full_width": false, "small_text": false, "font": "default",
	"locked": false, "allow_export": true,
}

var (
	reAssetRef   = regexp.MustCompile(`^asset:([A-Za-z0-9_-]{8,64})$`)
	reGalleryRef = regexp.MustCompile(`^gallery:([a-z0-9][a-z0-9-]{0,39})$`)
	reFMLine     = regexp.MustCompile(`^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$`)
	reHTTPSURL   = regexp.MustCompile(`^https://[^\s"'<>()]{1,2000}$`)
)

const maxFrontMatterLines = 60

// IsPagePropKey reports whether k is one of PagePropKeys.
func IsPagePropKey(k string) bool {
	for _, x := range PagePropKeys {
		if x == k {
			return true
		}
	}
	return false
}

// splitFrontMatter returns the front-matter lines and the body; ok is false
// when the Markdown has no front matter.
func splitFrontMatter(md string) (lines []string, body string, ok bool) {
	if !strings.HasPrefix(md, "---\n") && !strings.HasPrefix(md, "---\r\n") {
		return nil, md, false
	}
	all := strings.Split(md, "\n")
	for i := 1; i < len(all) && i < maxFrontMatterLines+2; i++ {
		if l := strings.TrimRight(all[i], "\r"); l == "---" || l == "..." {
			out := make([]string, 0, i-1)
			for _, ln := range all[1:i] {
				out = append(out, strings.TrimRight(ln, "\r"))
			}
			return out, strings.Join(all[i+1:], "\n"), true
		}
	}
	return nil, md, false
}

// ValidatePageProps checks changes (a nil value clears a key) and returns
// them normalised: booleans, cover_y as an int, gallery names lower-case.
func ValidatePageProps(changes map[string]any) (map[string]any, error) {
	clean := map[string]any{}
	for k, v := range changes {
		if !IsPagePropKey(k) {
			return nil, fmt.Errorf("unknown page property %q; known: %s", k, strings.Join(PagePropKeys, ", "))
		}
		if v == nil {
			clean[k] = nil
			continue
		}
		switch k {
		case "full_width", "small_text", "locked", "allow_export":
			b, ok := v.(bool)
			if !ok {
				return nil, fmt.Errorf("%s must be true or false", k)
			}
			clean[k] = b
		case "cover_y":
			var f float64
			switch n := v.(type) {
			case int:
				f = float64(n)
			case float64:
				f = n
			default:
				return nil, fmt.Errorf("cover_y must be a number from 0 (top) to 100 (bottom)")
			}
			if f < 0 || f > 100 || math.IsNaN(f) {
				return nil, fmt.Errorf("cover_y must be a number from 0 (top) to 100 (bottom)")
			}
			clean[k] = int(math.Round(f))
		case "font":
			s, _ := v.(string)
			ok := false
			for _, f := range PageFonts {
				ok = ok || s == f
			}
			if !ok {
				return nil, fmt.Errorf("font must be one of %s", strings.Join(PageFonts, ", "))
			}
			clean[k] = s
		case "icon":
			s, _ := v.(string)
			if !validIcon(s) {
				return nil, fmt.Errorf("icon must be an emoji (a few characters) or asset:<id> of an image uploaded to the page")
			}
			clean[k] = s
		case "cover":
			s, _ := v.(string)
			if !reAssetRef.MatchString(s) && !reGalleryRef.MatchString(s) && !reHTTPSURL.MatchString(s) {
				return nil, fmt.Errorf("cover must be asset:<id> (an image uploaded to the page), gallery:<name> " +
					"(a built-in cover, e.g. gallery:dusk) or an https:// image address")
			}
			clean[k] = s
		}
	}
	return clean, nil
}

func validIcon(s string) bool {
	if reAssetRef.MatchString(s) {
		return true
	}
	if s == "" || len([]rune(s)) > 16 || strings.ContainsAny(s, "\n") || strings.TrimSpace(s) != s {
		return false
	}
	low := strings.ToLower(s)
	return !strings.HasPrefix(low, "http:") && !strings.HasPrefix(low, "https:") && !strings.HasPrefix(low, "javascript:")
}

func formatPropValue(key string, v any) string {
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(x)
	}
	text := fmt.Sprint(v)
	if text != strings.TrimSpace(text) ||
		(strings.Contains(text, ":") && !reAssetRef.MatchString(text) && !reGalleryRef.MatchString(text)) ||
		strings.HasPrefix(text, "#") || strings.HasPrefix(text, "'") || strings.HasPrefix(text, `"`) ||
		strings.HasPrefix(text, "-") || strings.HasPrefix(text, "[") || strings.HasPrefix(text, "{") {
		return `"` + strings.ReplaceAll(text, `"`, "'") + `"`
	}
	return text
}

func isDefaultProp(key string, v any) bool {
	d := pagePropDefaults[key]
	if v == nil {
		return true
	}
	return d != nil && fmt.Sprint(d) == fmt.Sprint(v)
}

// ApplyPageProps returns md with changes written into its front matter (a nil
// or default value removes the key). Other keys and lines keep their place;
// the block goes away when nothing is left in it.
func ApplyPageProps(md string, changes map[string]any) (string, error) {
	changes, err := ValidatePageProps(changes)
	if err != nil {
		return "", err
	}
	lines, body, had := splitFrontMatter(md)
	seen := map[string]bool{}
	var out []string
	for _, line := range lines {
		m := reFMLine.FindStringSubmatch(line)
		if m != nil {
			if v, ok := changes[m[1]]; ok {
				if seen[m[1]] {
					continue
				}
				seen[m[1]] = true
				if !isDefaultProp(m[1], v) {
					out = append(out, m[1]+": "+formatPropValue(m[1], v))
				}
				continue
			}
		}
		out = append(out, line)
	}
	for _, k := range PagePropKeys {
		if v, ok := changes[k]; ok && !seen[k] && !isDefaultProp(k, v) {
			out = append(out, k+": "+formatPropValue(k, v))
		}
	}
	empty := true
	for _, l := range out {
		if strings.TrimSpace(l) != "" {
			empty = false
			break
		}
	}
	if empty {
		if had {
			return body, nil
		}
		return md, nil
	}
	if had {
		return "---\n" + strings.Join(out, "\n") + "\n---\n" + body, nil
	}
	return "---\n" + strings.Join(out, "\n") + "\n---\n" + md, nil
}

// StripFrontMatter returns the page's Markdown without its front matter.
func StripFrontMatter(md string) string {
	_, body, _ := splitFrontMatter(md)
	return body
}

// JoinBlocks appends block to md the way the server's append does: blank
// lines between, one newline at the end.
func JoinBlocks(md, block string) string {
	var chunks []string
	for _, p := range []string{md, block} {
		if t := strings.Trim(p, "\n"); t != "" {
			chunks = append(chunks, t)
		}
	}
	return strings.Join(chunks, "\n\n") + "\n"
}
