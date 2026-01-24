//go:build windows

package main

import "golang.org/x/sys/windows"

func getDiskUsage(path string) (DiskUsage, error) {
	var freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes uint64

	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return DiskUsage{}, err
	}

	if err := windows.GetDiskFreeSpaceEx(pathPtr, &freeBytesAvailable, &totalNumberOfBytes, &totalNumberOfFreeBytes); err != nil {
		return DiskUsage{}, err
	}

	return DiskUsage{
		Total: totalNumberOfBytes,
		Free:  freeBytesAvailable,
		Used:  totalNumberOfBytes - freeBytesAvailable,
	}, nil
}
