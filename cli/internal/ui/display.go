// Package ui provides terminal display helpers for the markdrop CLI.
package ui

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/mdp/qrterminal/v3"
	"github.com/schollz/progressbar/v3"
)

var (
	Bold   = color.New(color.Bold)
	Green  = color.New(color.FgGreen, color.Bold)
	Yellow = color.New(color.FgYellow)
	Red    = color.New(color.FgRed, color.Bold)
	Cyan   = color.New(color.FgCyan)
	Dim    = color.New(color.Faint)
)

// PrintSendReady prints the styled info box shown to the sender.
func PrintSendReady(fileName, fileSize, roomID, shareURL string) {
	width := 50
	line := strings.Repeat("─", width)

	fmt.Println()
	Cyan.Printf("  ╭%s╮\n", line)
	Cyan.Print("  │")
	Bold.Printf("  markdrop · P2P File Share%-*s", width-27, "")
	Cyan.Println("│")
	Cyan.Printf("  │%s│\n", strings.Repeat(" ", width))
	Cyan.Print("  │  ")
	fmt.Printf("%-8s", "File")
	Bold.Printf(": %-*s", width-12, truncate(fileName+" ("+fileSize+")", width-12))
	Cyan.Println("│")
	Cyan.Print("  │  ")
	fmt.Printf("%-8s", "Room")
	Bold.Printf(": %-*s", width-12, truncate(roomID, width-12))
	Cyan.Println("│")
	Cyan.Print("  │  ")
	fmt.Printf("%-8s", "URL")
	Bold.Printf(": %-*s", width-12, truncate(shareURL, width-12))
	Cyan.Println("│")
	Cyan.Printf("  │%s│\n", strings.Repeat(" ", width))
	Cyan.Printf("  ╰%s╯\n", line)
	fmt.Println()
}

// PrintQR prints a QR code of the share URL to the terminal.
func PrintQR(url string) {
	fmt.Println("  Scan to open on mobile:")
	fmt.Println()
	qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stdout)
	fmt.Println()
}

// NewProgressBar creates a styled progress bar for file transfer.
func NewProgressBar(total int64, description string) *progressbar.ProgressBar {
	return progressbar.NewOptions64(
		total,
		progressbar.OptionSetDescription("  "+description),
		progressbar.OptionSetWriter(os.Stderr),
		progressbar.OptionShowBytes(true),
		progressbar.OptionSetWidth(30),
		progressbar.OptionThrottle(65*time.Millisecond),
		progressbar.OptionShowCount(),
		progressbar.OptionOnCompletion(func() {
			fmt.Fprint(os.Stderr, "\n")
		}),
		progressbar.OptionSpinnerType(14),
		progressbar.OptionFullWidth(),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "█",
			SaucerHead:    "█",
			SaucerPadding: "░",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)
}

// Spinner shows an animated spinner with a message and returns a stop function.
func Spinner(msg string) func() {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	stop := make(chan struct{})
	go func() {
		i := 0
		for {
			select {
			case <-stop:
				fmt.Printf("\r%s\r", strings.Repeat(" ", len(msg)+5))
				return
			default:
				Dim.Printf("\r  %s %s", frames[i%len(frames)], msg)
				time.Sleep(80 * time.Millisecond)
				i++
			}
		}
	}()
	return func() { close(stop); time.Sleep(90 * time.Millisecond) }
}

// Success prints a green success line.
func Success(msg string) {
	Green.Printf("  ✓ %s\n", msg)
}

// Info prints an informational line.
func Info(msg string) {
	Dim.Printf("  %s\n", msg)
}

// Warn prints a yellow warning.
func Warn(msg string) {
	Yellow.Printf("  ⚠ %s\n", msg)
}

// Fatal prints a red error and exits.
func Fatal(msg string) {
	Red.Fprintf(os.Stderr, "\n  ✗ %s\n\n", msg)
	os.Exit(1)
}

// truncate shortens a string to maxLen, appending "…" if needed.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen < 4 {
		return s[:maxLen]
	}
	return s[:maxLen-1] + "…"
}
