//go:build !unix

package peer

import "errors"

func mkfifo(string) error { return errors.New("no fifos here") }
