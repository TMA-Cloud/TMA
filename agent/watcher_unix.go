//go:build !windows
// +build !windows

package main

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// flockExclusiveUnix uses unix.Flock for exclusive non-blocking lock
func (wm *WatcherManager) flockExclusiveUnix(fd int) error {
	err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	if err != nil {
		// EWOULDBLOCK means file is locked by another process (still being written)
		if err == unix.EWOULDBLOCK {
			return fmt.Errorf("file is locked")
		}
		return err
	}
	return nil
}

// flockUnlockUnix releases the lock using unix.Flock
func (wm *WatcherManager) flockUnlockUnix(fd int) {
	unix.Flock(fd, unix.LOCK_UN)
}
