package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/markdrop/cli/internal/files"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func newLoginCmd() *cobra.Command {
	var token string
	c := &cobra.Command{
		Use:   "login",
		Short: "Save an API token for upload, replace, versions, restore and info",
		Long: `Save a Markdrop API token on this computer (readable only by you, mode 0600),
so the file commands work without MARKDROP_TOKEN.

  Create a token at https://markdrop.in/settings/tokens, then run
  ` + "`markdrop login`" + ` and paste it (or pass --token, or pipe it in).
  MARKDROP_TOKEN and --token still take precedence over the saved token.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			errw := cmd.ErrOrStderr()
			tok := strings.TrimSpace(token)
			if tok == "" {
				var err error
				if tok, err = readToken(cmd.InOrStdin(), errw); err != nil {
					return err
				}
			}
			if tok == "" {
				return errors.New("no token given; create one at " + files.TokensURL)
			}
			client := &files.Client{Base: flagServer, Token: tok, UserAgent: "markdrop-cli/" + version, Attempts: 2}
			email, err := client.Me(cmdContext(cmd))
			switch {
			case files.IsStatus(err, http.StatusUnauthorized):
				return fmt.Errorf("that token was rejected by %s; create a new one at %s", flagServer, files.TokensURL)
			case err != nil:
				fmt.Fprintf(errw, "  Couldn't check the token (%v); saving it anyway.\n", err)
			}
			path, err := files.SaveToken(tok)
			if err != nil {
				return fmt.Errorf("could not save the token: %w", err)
			}
			if email != "" {
				fmt.Fprintf(errw, "  ✓ Logged in as %s. Token saved to %s\n", email, path)
			} else {
				fmt.Fprintf(errw, "  ✓ Token saved to %s\n", path)
			}
			if os.Getenv(files.TokenEnv) != "" {
				fmt.Fprintf(errw, "  Note: %s is set and takes precedence over the saved token.\n", files.TokenEnv)
			}
			return nil
		},
	}
	c.Flags().StringVar(&token, "token", "", "the API token (default: prompt, or read from stdin)")
	return c
}

func newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget the API token saved by markdrop login",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			had, err := files.DeleteToken()
			if err != nil {
				return err
			}
			if had {
				fmt.Fprintln(cmd.ErrOrStderr(), "  ✓ Saved token removed. (Delete it on markdrop.in too if it leaked.)")
			} else {
				fmt.Fprintln(cmd.ErrOrStderr(), "  No saved token.")
			}
			return nil
		},
	}
}

// readToken prompts without echo on a terminal, or reads one line from a pipe.
func readToken(in io.Reader, errw io.Writer) (string, error) {
	if f, ok := in.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprintf(errw, "  Paste your API token (from %s): ", files.TokensURL)
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(errw)
		return strings.TrimSpace(string(b)), err
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimSpace(line), nil
}
