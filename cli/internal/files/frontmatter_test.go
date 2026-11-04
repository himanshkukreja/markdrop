package files

import (
	"strings"
	"testing"
)

func TestApplyPageProps(t *testing.T) {
	cases := []struct {
		name    string
		md      string
		changes map[string]any
		want    string
	}{
		{"adds a block", "# Hi\n", map[string]any{"icon": "🚀"}, "---\nicon: 🚀\n---\n# Hi\n"},
		{"replaces in place, keeps unknown keys", "---\ntags: a, b\nicon: 📝\nfont: serif\n---\nBody\n",
			map[string]any{"icon": "🚀", "cover": "gallery:dusk"},
			"---\ntags: a, b\nicon: 🚀\nfont: serif\ncover: gallery:dusk\n---\nBody\n"},
		{"a default value removes the key", "---\nfull_width: true\ncover_y: 30\n---\nB",
			map[string]any{"full_width": false, "cover_y": 50.0}, "B"},
		{"clearing the last key drops the block", "---\nicon: 🚀\n---\nBody", map[string]any{"icon": nil}, "Body"},
		{"booleans and numbers", "x", map[string]any{"locked": true, "allow_export": false, "cover_y": 33.4},
			"---\ncover_y: 33\nlocked: true\nallow_export: false\n---\nx"},
		{"an https cover is quoted (it has a colon)", "", map[string]any{"cover": "https://example.com/a.png"},
			"---\ncover: \"https://example.com/a.png\"\n---\n"},
		{"asset refs are not quoted", "", map[string]any{"cover": "asset:abcdef123456"},
			"---\ncover: asset:abcdef123456\n---\n"},
		{"duplicate keys collapse", "---\nicon: a\nicon: b\n---\n", map[string]any{"icon": "c"}, "---\nicon: c\n---\n"},
		{"unknown block kept when nothing changes", "---\nfoo: bar\n---\nx", map[string]any{"icon": nil}, "---\nfoo: bar\n---\nx"},
	}
	for _, c := range cases {
		got, err := ApplyPageProps(c.md, c.changes)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
}

func TestValidatePageProps(t *testing.T) {
	bad := []map[string]any{
		{"colour": "red"},
		{"font": "comic"},
		{"cover": "gallery:Dusk!"},
		{"cover": "http://insecure.example/a.png"},
		{"cover": "https://" + strings.Repeat("a", 2001)},
		{"icon": "https://example.com/i.png"},
		{"icon": strings.Repeat("x", 17)},
		{"cover_y": 101.0},
		{"locked": "yes"},
	}
	for _, b := range bad {
		if _, err := ValidatePageProps(b); err == nil {
			t.Errorf("accepted %v", b)
		}
	}
	good := map[string]any{"icon": "asset:abcdefgh", "cover": "https://x.test/a.png", "font": "mono", "cover_y": 0.0}
	if _, err := ValidatePageProps(good); err != nil {
		t.Error(err)
	}
}

func TestJoinBlocksAndStrip(t *testing.T) {
	if got := JoinBlocks("# A\n\n\n", "\n- b\n"); got != "# A\n\n- b\n" {
		t.Errorf("join %q", got)
	}
	if got := JoinBlocks("", "x"); got != "x\n" {
		t.Errorf("join empty %q", got)
	}
	if got := StripFrontMatter("---\nicon: x\n---\nBody"); got != "Body" {
		t.Errorf("strip %q", got)
	}
	if got := StripFrontMatter("Body\n---\n"); got != "Body\n---\n" {
		t.Errorf("strip without front matter %q", got)
	}
}

func TestDispositionName(t *testing.T) {
	for in, want := range map[string]string{
		`attachment; filename="notes.md"`:            "notes.md",
		`attachment; filename*=UTF-8''r%C3%A9sum.md`: "résum.md",
		`attachment; filename="../../etc/passwd"`:    "passwd",
		`attachment; filename=".bashrc"`:             "",
		``:                                           "",
	} {
		if got := dispositionName(in); got != want {
			t.Errorf("dispositionName(%q) = %q, want %q", in, got, want)
		}
	}
}
