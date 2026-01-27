package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	logSetupOnce sync.Once
	logFilePath  string
	logFileMu    sync.Mutex
	logFile      *os.File
)

// initLogging configures the standard logger to write to both stdout and a log file
// located next to the agent binary and config JSON. It also performs a simple
// size-based rotation to keep the log files small and bounded.
func initLogging() {
	logSetupOnce.Do(func() {
		log.SetFlags(log.LstdFlags | log.Lmsgprefix | log.LUTC)
		log.SetPrefix("[tma-agent] ")

		dir := getExecutableDir()
		logFilePath = filepath.Join(dir, logFileName)

		// Rotate once on startup before opening the file.
		if err := rotateLogFile(logFilePath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to rotate log file: %v\n", err)
		}

		if err := openOrReopenLogFile(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to open log file: %v\n", err)
			return
		}

		// Periodic rotation for long-running services (safe on Windows too).
		go func() {
			ticker := time.NewTicker(10 * time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				if err := rotateOpenLogFileIfNeeded(); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: log rotation failed: %v\n", err)
				}
			}
		}()

		log.Printf("Logging initialized. Writing to %s", logFilePath)
	})
}

func openOrReopenLogFile() error {
	logFileMu.Lock()
	defer logFileMu.Unlock()

	if logFilePath == "" {
		return fmt.Errorf("log file path is not set")
	}

	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}

	file, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	logFile = file
	log.SetOutput(io.MultiWriter(os.Stdout, logFile))
	return nil
}

// rotateOpenLogFileIfNeeded safely rotates the active log file while the agent is running.
// It temporarily routes logs to stdout during rotation to avoid writing to a closed file.
func rotateOpenLogFileIfNeeded() error {
	logFileMu.Lock()
	defer logFileMu.Unlock()

	if logFilePath == "" {
		return nil
	}

	info, err := os.Stat(logFilePath)
	if err != nil {
		// If the file vanished, recreate it.
		if os.IsNotExist(err) {
			file, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
			if err != nil {
				return err
			}
			if logFile != nil {
				_ = logFile.Close()
			}
			logFile = file
			log.SetOutput(io.MultiWriter(os.Stdout, logFile))
			return nil
		}
		return err
	}

	if info.Size() < maxLogSize {
		return nil
	}

	// Ensure no writes go to the file while we rotate it.
	log.SetOutput(os.Stdout)

	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}

	if err := rotateLogFile(logFilePath); err != nil {
		// Best-effort: reopen the log file even if rotation failed.
		file, openErr := os.OpenFile(logFilePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if openErr == nil {
			logFile = file
			log.SetOutput(io.MultiWriter(os.Stdout, logFile))
		} else {
			log.SetOutput(os.Stdout)
		}
		return err
	}

	file, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		log.SetOutput(os.Stdout)
		return err
	}

	logFile = file
	log.SetOutput(io.MultiWriter(os.Stdout, logFile))
	return nil
}

// rotateLogFile renames the current log file when it grows too large and cleans
// up older rotated files, keeping a small bounded history.
func rotateLogFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		// No log file yet.
		return nil
	}

	if info.Size() < maxLogSize {
		return nil
	}

	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	timestamp := time.Now().Format("20060102-150405")
	rotated := fmt.Sprintf("%s-%s%s", base, timestamp, ext)

	if err := os.Rename(path, rotated); err != nil {
		return err
	}

	// Clean up old rotated files, keeping only the most recent ones.
	pattern := fmt.Sprintf("%s-*%s", base, ext)
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}

	sort.Slice(matches, func(i, j int) bool {
		infoI, _ := os.Stat(matches[i])
		infoJ, _ := os.Stat(matches[j])
		if infoI == nil || infoJ == nil {
			return matches[i] > matches[j]
		}
		return infoI.ModTime().After(infoJ.ModTime())
	})

	for i := maxLogBackups; i < len(matches); i++ {
		_ = os.Remove(matches[i])
	}

	return nil
}
