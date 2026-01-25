package main

import (
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type program struct {
	exit chan struct{}
}

type Config struct {
	Port         string   `json:"port"`
	Token        string   `json:"token"`
	Paths        []string `json:"paths"`
	WebhookURL   string   `json:"webhookUrl,omitempty"`
	WebhookToken string   `json:"webhookToken,omitempty"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type FileInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	IsDir   bool      `json:"isDir"`
	ModTime time.Time `json:"modTime"`
}

type DiskUsage struct {
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
	Used  uint64 `json:"used"`
}

type ListResponse struct {
	Files []FileInfo `json:"files"`
	Path  string     `json:"path"`
}

type WatcherManager struct {
	watcher      *fsnotify.Watcher
	watchedPaths map[string]bool
	webhookURL   string
	webhookToken string
	mu           sync.RWMutex
}
