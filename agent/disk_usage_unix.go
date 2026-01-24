//go:build !windows

package main

import "golang.org/x/sys/unix"

func getDiskUsage(path string) (DiskUsage, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return DiskUsage{}, err
	}

	// Calculate usage
	// Bavail is the number of blocks available to unprivileged users
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	used := (stat.Blocks - stat.Bfree) * uint64(stat.Bsize)

	return DiskUsage{
		Total: total,
		Free:  free,
		Used:  used,
	}, nil
}
