package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	mathrand "math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	return err
}

// validateAndResolvePath validates and resolves an absolute path
// Also checks if the path is within any of the configured drive paths
func validateAndResolvePath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path is required")
	}

	// Clean the path (removes ".." and normalizes)
	cleanPath := filepath.Clean(path)

	// Must be an absolute path
	if !filepath.IsAbs(cleanPath) {
		return "", fmt.Errorf("path must be absolute")
	}

	// Resolve the absolute path (follows symlinks)
	resolvedPath, err := filepath.EvalSymlinks(cleanPath)
	if err != nil {
		// If symlink resolution fails, use the cleaned path
		// This allows the path to be validated even if it doesn't exist yet (for write operations)
		resolvedPath = cleanPath
	}

	// Ensure the resolved path is still absolute
	if !filepath.IsAbs(resolvedPath) {
		return "", fmt.Errorf("resolved path is not absolute")
	}

	// Check if path is within any of the configured drive paths
	// Config is auto-updated by config watcher, just get current config
	config := getConfig()
	if config != nil && len(config.Paths) > 0 {
		allowed := false
		for _, drivePath := range config.Paths {
			// Check if resolved path is within this drive path
			rel, err := filepath.Rel(drivePath, resolvedPath)
			if err == nil && !strings.HasPrefix(rel, "..") {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", fmt.Errorf("path is not within any configured drive path")
		}
	}

	return resolvedPath, nil
}

func sendError(w http.ResponseWriter, statusCode int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}

// sendJSON sends a JSON response with the given status code
func sendJSON(w http.ResponseWriter, statusCode int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(data)
}

// Windows Path Helpers
func addToWindowsPath(pathToAdd string) {
	cmd := fmt.Sprintf(
		`$path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine'); `+
			`if ($path -notlike '*%s*') { `+
			`[System.Environment]::SetEnvironmentVariable('Path', $path + ';%s', 'Machine') `+
			`}`, pathToAdd, pathToAdd)
	exec.Command("powershell", "-Command", cmd).Run()
}

func removeFromWindowsPath(pathToRemove string) {
	cmd := fmt.Sprintf(
		`$path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine'); `+
			`$newPath = $path.Replace(';%s', ''); `+
			`[System.Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')`,
		pathToRemove)
	exec.Command("powershell", "-Command", cmd).Run()
}

func getInstallPaths() (string, string) {
	if runtime.GOOS == "windows" {
		progFiles := os.Getenv("ProgramFiles")
		if progFiles == "" {
			progFiles = "C:\\Program Files"
		}
		installDir := filepath.Join(progFiles, "TMA Drive Agent")
		return filepath.Join(installDir, "tma-agent.exe"), installDir
	}
	return "/usr/local/bin/tma-agent", "/usr/local/bin"
}

// generateToken generates a secure random token
func generateToken() string {
	tokenBytes := make([]byte, 32)
	_, err := rand.Read(tokenBytes)
	if err != nil {
		// Fallback to math/rand if crypto/rand fails
		mathRand := mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
		for i := range tokenBytes {
			tokenBytes[i] = byte(mathRand.Intn(256))
		}
	}
	return hex.EncodeToString(tokenBytes)
}

// requireMethod validates that the request uses the specified HTTP method
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return false
	}
	return true
}

// getPathParam extracts and validates the "path" query parameter
func getPathParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return "", false
	}
	return path, true
}

// ensureParentDir ensures the parent directory of the given path exists
func ensureParentDir(path string) error {
	parentDir := filepath.Dir(path)
	if _, err := os.Stat(parentDir); os.IsNotExist(err) {
		return os.MkdirAll(parentDir, 0755)
	}
	return nil
}

// validatePathAndStat validates a path and returns its FileInfo
func validatePathAndStat(w http.ResponseWriter, path string) (string, os.FileInfo, bool) {
	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return "", nil, false
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Path not found: %v", err))
		return "", nil, false
	}

	return fullPath, info, true
}

// getCurrentExecutable returns the current executable path with symlinks resolved
func getCurrentExecutable() (string, error) {
	currentExe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to get executable path: %v", err)
	}
	// Try to resolve symlinks, but continue with original path if it fails
	if resolved, err := filepath.EvalSymlinks(currentExe); err == nil {
		currentExe = resolved
	}
	return currentExe, nil
}

// setExecutablePermissions sets executable permissions on Unix systems
func setExecutablePermissions(path string) error {
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0755); err != nil {
			return fmt.Errorf("failed to set permissions: %v", err)
		}
	}
	return nil
}

// decodeJSONBody decodes JSON request body and handles errors
func decodeJSONBody(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		sendError(w, http.StatusBadRequest, "Invalid request body")
		return false
	}
	return true
}

// filterPaths removes the specified path from the slice efficiently
func filterPaths(paths []string, removePath string) []string {
	result := make([]string, 0, len(paths))
	for _, p := range paths {
		if p != removePath {
			result = append(result, p)
		}
	}
	return result
}
