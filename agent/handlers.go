package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func healthHandler(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, http.StatusOK, map[string]string{"agent": version})
}

func pathsHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	sendJSON(w, http.StatusOK, map[string]interface{}{
		"paths": globalConfig.Paths,
	})
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// If no token, allow all requests
		if globalConfig.Token == "" {
			next(w, r)
			return
		}

		// Check Authorization header
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			sendError(w, http.StatusUnauthorized, "Missing Authorization header")
			return
		}

		// Extract token from "Bearer <token>" or just "<token>"
		requestToken := strings.TrimSpace(authHeader)
		requestToken = strings.TrimPrefix(requestToken, "Bearer ")

		if requestToken != globalConfig.Token {
			sendError(w, http.StatusUnauthorized, "Invalid token")
			return
		}

		next(w, r)
	}
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, info, ok := validatePathAndStat(w, path)
	if !ok {
		return
	}

	if !info.IsDir() {
		sendError(w, http.StatusBadRequest, "Path is not a directory")
		return
	}

	// Read directory
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to read directory: %v", err))
		return
	}

	files := make([]FileInfo, 0, len(entries))
	for _, entry := range entries {
		entryPath := filepath.Join(fullPath, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}

		files = append(files, FileInfo{
			Name:    entry.Name(),
			Path:    entryPath,
			Size:    info.Size(),
			IsDir:   entry.IsDir(),
			ModTime: info.ModTime(),
		})
	}

	sendJSON(w, http.StatusOK, ListResponse{
		Files: files,
		Path:  fullPath,
	})
}

func readHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, info, ok := validatePathAndStat(w, path)
	if !ok {
		return
	}

	if info.IsDir() {
		sendError(w, http.StatusBadRequest, "Path is a directory, use /api/list instead")
		return
	}

	file, err := os.Open(fullPath)
	if err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to open file: %v", err))
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filepath.Base(fullPath)))
	io.Copy(w, file)
}

func writeHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Limit request size
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	// Ensure parent directory exists
	if err := ensureParentDir(fullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create parent directory: %v", err))
		return
	}

	// Create file
	file, err := os.Create(fullPath)
	if err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create file: %v", err))
		return
	}
	defer file.Close()

	// Copy request body to file
	written, err := io.Copy(file, r.Body)
	if err != nil {
		os.Remove(fullPath)
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to write file: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, map[string]interface{}{
		"status": "written",
		"path":   fullPath,
		"size":   written,
	})
}

func renameHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}

	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.OldPath == "" || req.NewPath == "" {
		sendError(w, http.StatusBadRequest, "oldPath and newPath are required")
		return
	}

	// Validate and resolve paths
	oldFullPath, _, ok := validatePathAndStat(w, req.OldPath)
	if !ok {
		return
	}

	newFullPath, err := validateAndResolvePath(req.NewPath)
	if err != nil {
		sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid newPath: %v", err))
		return
	}

	// Check if new path already exists
	if _, err := os.Stat(newFullPath); err == nil {
		sendError(w, http.StatusConflict, "New path already exists")
		return
	}

	// Ensure parent directory of new path exists
	if err := ensureParentDir(newFullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create parent directory: %v", err))
		return
	}

	// Perform OS-level rename (instant, even for large files)
	if err := os.Rename(oldFullPath, newFullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to rename: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "renamed",
		"oldPath": oldFullPath,
		"newPath": newFullPath,
	})
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodDelete) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, info, ok := validatePathAndStat(w, path)
	if !ok {
		return
	}

	// Delete file or directory
	if info.IsDir() {
		if err := os.RemoveAll(fullPath); err != nil {
			sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to delete directory: %v", err))
			return
		}
	} else {
		if err := os.Remove(fullPath); err != nil {
			sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to delete file: %v", err))
			return
		}
	}

	sendJSON(w, http.StatusOK, map[string]string{
		"status": "deleted",
		"path":   fullPath,
	})
}

func statHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, info, ok := validatePathAndStat(w, path)
	if !ok {
		return
	}

	fileInfo := FileInfo{
		Name:    filepath.Base(fullPath),
		Path:    fullPath,
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
	}

	sendJSON(w, http.StatusOK, fileInfo)
}

func mkdirHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Check if directory already exists
	if info, err := os.Stat(fullPath); err == nil {
		if !info.IsDir() {
			sendError(w, http.StatusBadRequest, "Path exists but is not a directory")
			return
		}
		// Directory already exists, return success
	} else if os.IsNotExist(err) {
		// Create directory
		if err := os.MkdirAll(fullPath, 0755); err != nil {
			sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create directory: %v", err))
			return
		}
	} else {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to check directory: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, map[string]string{
		"status": "created",
		"path":   fullPath,
	})
}

func usageHandler(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	path, ok := getPathParam(w, r)
	if !ok {
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	usage, err := getDiskUsage(fullPath)
	if err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to get disk usage: %v", err))
		return
	}

	sendJSON(w, http.StatusOK, usage)
}
