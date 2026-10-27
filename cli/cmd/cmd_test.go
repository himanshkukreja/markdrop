package cmd

import (
	"regexp"
	"testing"
)

func TestBuildShareURL(t *testing.T) {
	cases := []struct{ server, web, want string }{
		{defaultServer, "", "https://markdrop.in/share/abc123def0"},
		{"http://localhost:8080", "", "http://localhost:3000/share/abc123def0"},
		{"http://127.0.0.1:8097", "http://localhost:3198/", "http://localhost:3198/share/abc123def0"},
		{"http://127.0.0.1:8097", "", "http://127.0.0.1:8097/share/abc123def0"},
	}
	for _, c := range cases {
		if got := buildShareURL(c.server, c.web, "abc123def0"); got != c.want {
			t.Errorf("buildShareURL(%q,%q) = %q, want %q", c.server, c.web, got, c.want)
		}
	}
}

func TestParseRoomID(t *testing.T) {
	for in, want := range map[string]string{
		"https://markdrop.in/share/a3f7c12e01":  "a3f7c12e01",
		"https://www.markdrop.in/share/a3f7c12e": "a3f7c12e",
		" a3f7c12e01 ":                          "a3f7c12e01",
	} {
		if got, err := parseRoomID(in); err != nil || got != want {
			t.Errorf("parseRoomID(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "https://markdrop.in/d/x", "a/b", "abc"} {
		if _, err := parseRoomID(bad); err == nil {
			t.Errorf("parseRoomID(%q) accepted", bad)
		}
	}
}

func TestGeneratedIDs(t *testing.T) {
	if !regexp.MustCompile(`^[0-9a-f]{10}$`).MatchString(generateRoomID()) {
		t.Error("room id shape")
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(generateHostKey()) {
		t.Error("host key shape (the server wants 32-64 hex)")
	}
	if version != "0.5.0" {
		t.Errorf("default version %q", version)
	}
}
