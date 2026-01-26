//go:build windows
// +build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// flockExclusiveUnix uses LockFileEx on Windows for file locking
func (wm *WatcherManager) flockExclusiveUnix(fd int) error {
	// Windows: Use LockFileEx for file locking
	// LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
	handle := windows.Handle(fd)
	var overlapped windows.Overlapped

	err := windows.LockFileEx(
		handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, // reserved
		0, // low-order 32 bits of file size
		0, // high-order 32 bits of file size
		&overlapped,
	)
	if err != nil {
		// ERROR_LOCK_VIOLATION (33) means file is locked by another process
		if err == windows.ERROR_LOCK_VIOLATION {
			return fmt.Errorf("file is locked")
		}
		return err
	}
	return nil
}

// flockUnlockUnix releases the lock on Windows
func (wm *WatcherManager) flockUnlockUnix(fd int) {
	handle := windows.Handle(fd)
	var overlapped windows.Overlapped
	windows.UnlockFileEx(
		handle,
		0, // reserved
		0, // low-order 32 bits of file size
		0, // high-order 32 bits of file size
		&overlapped,
	)
}
