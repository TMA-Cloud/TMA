package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

var watcherManager *WatcherManager

func (wm *WatcherManager) watchEvents() {
	for {
		select {
		case event, ok := <-wm.watcher.Events:
			if !ok {
				return
			}
			wm.handleFileEvent(event)
		case err, ok := <-wm.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("File watcher error: %v", err)
		}
	}
}

func (wm *WatcherManager) handleFileEvent(event fsnotify.Event) {
	wm.mu.RLock()
	webhookURL := wm.webhookURL
	webhookToken := wm.webhookToken
	wm.mu.RUnlock()

	if webhookURL == "" {
		return // No webhook configured
	}

	// Get file info (single stat call)
	info, err := os.Stat(event.Name)
	var isDir bool
	var size int64
	var modTime time.Time
	if err == nil {
		isDir = info.IsDir()
		size = info.Size()
		modTime = info.ModTime()
	} else {
		modTime = time.Now()
	}

	// Determine event type and handle directory watching
	var eventType string
	switch {
	case event.Op&fsnotify.Create != 0:
		eventType = "create"
		// Auto-watch new directories
		if err == nil && isDir {
			wm.mu.Lock()
			if !wm.watchedPaths[event.Name] {
				if addErr := wm.watcher.Add(event.Name); addErr == nil {
					wm.watchedPaths[event.Name] = true
				}
			}
			wm.mu.Unlock()
		}
	case event.Op&fsnotify.Write != 0:
		eventType = "write"
	case event.Op&fsnotify.Remove != 0:
		eventType = "remove"
		// Remove from watched paths if it was a directory
		wm.mu.Lock()
		delete(wm.watchedPaths, event.Name)
		wm.mu.Unlock()
	case event.Op&fsnotify.Rename != 0:
		eventType = "rename"
	case event.Op&fsnotify.Chmod != 0:
		eventType = "chmod"
	default:
		return // Unknown event type, skip
	}

	// Send webhook notification asynchronously (non-blocking)
	go wm.sendWebhook(webhookURL, webhookToken, eventType, event.Name, isDir, size, modTime)
}

func (wm *WatcherManager) sendWebhook(webhookURL, webhookToken, eventType, filePath string, isDir bool, size int64, modTime time.Time) {
	payload := map[string]interface{}{
		"event":   eventType,
		"path":    filePath,
		"isDir":   isDir,
		"size":    size,
		"modTime": modTime,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Printf("Failed to marshal webhook payload: %v", err)
		return
	}

	req, err := http.NewRequest("POST", webhookURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("Failed to create webhook request: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	if webhookToken != "" {
		req.Header.Set("Authorization", "Bearer "+webhookToken)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Failed to send webhook notification: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		log.Printf("Webhook returned error status: %d", resp.StatusCode)
	}
}

func (wm *WatcherManager) addWatchPath(path string) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	if wm.watchedPaths[path] {
		return nil // Already watching
	}

	// Add the path to watcher
	if err := wm.watcher.Add(path); err != nil {
		return err
	}
	wm.watchedPaths[path] = true

	// Recursively add all existing subdirectories
	// New directories will be auto-added via Create events
	return filepath.Walk(path, func(walkPath string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() || walkPath == path {
			return nil
		}
		if addErr := wm.watcher.Add(walkPath); addErr != nil {
			log.Printf("Warning: Failed to watch subdirectory %s: %v", walkPath, addErr)
		} else {
			wm.watchedPaths[walkPath] = true
		}
		return nil
	})
}

func (wm *WatcherManager) removeWatchPath(path string) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()

	// Remove path and all subdirectories
	for watchedPath := range wm.watchedPaths {
		rel, err := filepath.Rel(path, watchedPath)
		if err == nil && !strings.HasPrefix(rel, "..") {
			wm.watcher.Remove(watchedPath)
			delete(wm.watchedPaths, watchedPath)
		}
	}

	return nil
}

func (wm *WatcherManager) setWebhook(url, token string) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	wm.webhookURL = url
	wm.webhookToken = token
}

func watchHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	var req struct {
		Path         string `json:"path"`
		WebhookURL   string `json:"webhookUrl,omitempty"`
		WebhookToken string `json:"webhookToken,omitempty"`
	}

	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Path == "" {
		sendError(w, http.StatusBadRequest, "path is required")
		return
	}

	// Validate and resolve path
	fullPath, info, ok := validatePathAndStat(w, req.Path)
	if !ok {
		return
	}

	if !info.IsDir() {
		sendError(w, http.StatusBadRequest, "Path must be a directory")
		return
	}

	// Update webhook settings if provided
	if req.WebhookURL != "" {
		watcherManager.setWebhook(req.WebhookURL, req.WebhookToken)
	}

	// Add to watcher
	if err := watcherManager.addWatchPath(fullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to watch path: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, map[string]string{
		"status": "watching",
		"path":   fullPath,
	})
}

func unwatchHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	var req struct {
		Path string `json:"path"`
	}

	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Path == "" {
		sendError(w, http.StatusBadRequest, "path is required")
		return
	}

	// Validate and resolve path
	fullPath, err := validateAndResolvePath(req.Path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Remove from watcher
	if err := watcherManager.removeWatchPath(fullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to unwatch path: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, map[string]string{
		"status": "unwatched",
		"path":   fullPath,
	})
}
