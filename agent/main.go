package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	mathrand "math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/kardianos/service"
)

const (
	defaultPort   = "8080"
	maxUploadSize = 10 << 30 // 10GB
	configFile    = "tma-agent.json"
	version       = "1.0.1" // Agent version
)

type program struct {
	exit chan struct{}
}

func (p *program) Start(s service.Service) error {
	p.exit = make(chan struct{})
	go func() {
		handleStart()
		close(p.exit)
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.exit != nil {
		close(p.exit)
	}
	return nil
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

type ListResponse struct {
	Files []FileInfo `json:"files"`
	Path  string     `json:"path"`
}

var globalConfig *Config

// File watcher state
type WatcherManager struct {
	watcher      *fsnotify.Watcher
	watchedPaths map[string]bool
	webhookURL   string
	webhookToken string
	mu           sync.RWMutex
}

var watcherManager *WatcherManager

func main() {
	svcConfig := &service.Config{
		Name:        "tma-agent",
		DisplayName: "TMA Drive Agent",
		Description: "Agent for passing mounted drives to the TMA app.",
		Arguments:   []string{"start"},
	}

	prg := &program{}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	command := os.Args[1]

	switch command {
	case "install":
		if err := handleUniversalInstall(s, svcConfig); err != nil {
			fmt.Printf("Installation failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service installed successfully!")
		return

	case "uninstall":
		s.Stop()
		if err := s.Uninstall(); err != nil {
			fmt.Printf("Failed to uninstall service: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service uninstalled successfully!")

		if err := handleUniversalUninstall(); err != nil {
			fmt.Printf("Warning during file cleanup: %v\n", err)
		}
		return

	case "service-start":
		err = s.Start()
		if err != nil {
			fmt.Printf("Failed to start service: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service started!")
		return

	case "service-stop":
		err = s.Stop()
		if err != nil {
			fmt.Printf("Failed to stop service: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service stopped!")
		return
	}

	switch command {
	case "add":
		handleAdd()
	case "start":
		if err := s.Run(); err != nil {
			log.Fatal(err)
		}
	case "list":
		handleList()
	case "remove":
		handleRemove()
	case "token":
		handleToken()
	default:
		fmt.Printf("Unknown command: %s\n\n", command)
		printUsage()
		os.Exit(1)
	}
}

// --- Installation Logic (Windows, Mac, Linux) ---
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

func handleUniversalInstall(s service.Service, svcConfig *service.Config) error {
	targetExePath, targetConfigDir := getInstallPaths()

	currentExe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %v", err)
	}
	currentExe, _ = filepath.EvalSymlinks(currentExe)

	if currentExe == targetExePath {
		return s.Install()
	}

	fmt.Printf("Installing agent to safe location: %s\n", targetExePath)

	if err := os.MkdirAll(targetConfigDir, 0755); err != nil {
		return fmt.Errorf("failed to create install directory: %v", err)
	}

	_ = s.Stop()

	if runtime.GOOS == "windows" {
		oldPath := targetExePath + ".old"
		os.Remove(oldPath)
		os.Rename(targetExePath, oldPath)
	} else {
		os.Remove(targetExePath)
	}

	if err := copyFile(currentExe, targetExePath); err != nil {
		return fmt.Errorf("failed to copy binary: %v", err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(targetExePath, 0755); err != nil {
			return fmt.Errorf("failed to set permissions: %v", err)
		}
	}

	currentConfigPath := filepath.Join(filepath.Dir(currentExe), configFile)
	targetConfigPath := filepath.Join(targetConfigDir, configFile)

	if _, err := os.Stat(currentConfigPath); err == nil {
		fmt.Printf("Copying config file to: %s\n", targetConfigPath)
		if err := copyFile(currentConfigPath, targetConfigPath); err != nil {
			return fmt.Errorf("failed to copy config: %v", err)
		}
		os.Remove(currentConfigPath)
	} else if _, err := os.Stat(targetConfigPath); os.IsNotExist(err) {
		fmt.Println("No existing config found. A new one will be created when the service starts.")
	}

	// Windows PATH addition
	if runtime.GOOS == "windows" {
		fmt.Println("Adding installation directory to System PATH...")
		addToWindowsPath(targetConfigDir)
	}

	// Cleanup Source
	if runtime.GOOS == "windows" {
		fmt.Println("NOTE: Installation complete. You can delete the installer file.")
	} else {
		os.Remove(currentExe)
		fmt.Println("Cleaned up source binary.")
	}

	svcConfig.Executable = targetExePath
	svcConfig.WorkingDirectory = targetConfigDir

	newS, err := service.New(&program{}, svcConfig)
	if err != nil {
		return err
	}

	return newS.Install()
}

func handleUniversalUninstall() error {
	targetExePath, targetConfigDir := getInstallPaths()

	if runtime.GOOS == "windows" {
		fmt.Println("Removing installation directory from System PATH...")
		removeFromWindowsPath(targetConfigDir)
	}

	targetConfigPath := filepath.Join(targetConfigDir, configFile)
	if err := os.Remove(targetConfigPath); err == nil {
		fmt.Printf("Removed config: %s\n", targetConfigPath)
	}

	if runtime.GOOS == "windows" {
		trashPath := targetExePath + ".old"

		_ = os.Remove(trashPath)

		if err := os.Rename(targetExePath, trashPath); err != nil {
			fmt.Printf("Warning: Could not rename binary: %v\n", err)
			fmt.Println("Please manually delete the folder: " + targetConfigDir)
		} else {
			fmt.Println("Binary marked for deletion.")

			psCommand := fmt.Sprintf(`
				Start-Sleep -Seconds 2;
				for($i=0; $i -lt 20; $i++) {
					try {
						Remove-Item -LiteralPath '%s' -Force -ErrorAction Stop;
						Remove-Item -LiteralPath '%s' -Force -Recurse -ErrorAction SilentlyContinue;
						break;
					} catch {
						Start-Sleep -Seconds 1;
					}
				}
			`, trashPath, targetConfigDir)

			exec.Command("powershell", "-Command", psCommand).Start()

			fmt.Println("Uninstall complete. Cleanup running in background...")
			os.Exit(0)
		}
	} else {
		if err := os.Remove(targetExePath); err == nil {
			fmt.Printf("Removed binary: %s\n", targetExePath)
		}
		os.Remove(targetConfigDir)
	}

	return nil
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

func printUsage() {
	fmt.Println("TMA Drive Agent - Standalone agent for passing mounted drives to the app")
	fmt.Println()
	fmt.Println("Management Commands:")
	fmt.Println("  tma-agent add --path <path>      Add a drive path")
	fmt.Println("  tma-agent remove --path <path>   Remove a drive path")
	fmt.Println("  tma-agent list                   List all added paths")
	fmt.Println("  tma-agent token                  Generate or show token")
	fmt.Println()
	fmt.Println("Service Commands (Run as Admin/Root):")
	fmt.Println("  tma-agent install                Install to system safe location")
	fmt.Println("  tma-agent uninstall              Remove service and files")
	fmt.Println("  tma-agent service-start          Start the background service")
	fmt.Println("  tma-agent service-stop           Stop the background service")
	fmt.Println()
	fmt.Println("Manual Run:")
	fmt.Println("  tma-agent start                  Run interactively (ctrl+c to stop)")
}

func getExecutableDir() string {
	ex, err := os.Executable()
	if err != nil {
		return "."
	}
	resolved, err := filepath.EvalSymlinks(ex)
	if err != nil {
		return filepath.Dir(ex)
	}
	return filepath.Dir(resolved)
}

func loadConfig() *Config {
	configPath := filepath.Join(getExecutableDir(), configFile)

	config := &Config{
		Port:  defaultPort,
		Token: "",
		Paths: []string{},
	}

	if data, err := os.ReadFile(configPath); err == nil {
		json.Unmarshal(data, config)
	}

	return config
}

func saveConfig(config *Config) error {
	configPath := filepath.Join(getExecutableDir(), configFile)
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0644)
}

func handleAdd() {
	addCmd := flag.NewFlagSet("add", flag.ExitOnError)
	path := addCmd.String("path", "", "Absolute path to the drive")
	addCmd.Parse(os.Args[2:])

	if *path == "" {
		fmt.Println("Error: --path is required")
		fmt.Println("Usage: tma-agent add --path <absolute_path>")
		os.Exit(1)
	}

	// Validate path
	cleanPath := filepath.Clean(*path)
	if !filepath.IsAbs(cleanPath) {
		fmt.Printf("Error: Path must be absolute: %s\n", cleanPath)
		os.Exit(1)
	}

	// Check if path exists
	info, err := os.Stat(cleanPath)
	if err != nil {
		fmt.Printf("Error: Path does not exist or is not accessible: %v\n", err)
		os.Exit(1)
	}

	if !info.IsDir() {
		fmt.Printf("Error: Path must be a directory: %s\n", cleanPath)
		os.Exit(1)
	}

	// Load config and add path
	config := loadConfig()

	// Check if path already exists
	for _, p := range config.Paths {
		if p == cleanPath {
			fmt.Printf("Path already added: %s\n", cleanPath)
			return
		}
	}

	config.Paths = append(config.Paths, cleanPath)

	if err := saveConfig(config); err != nil {
		fmt.Printf("Error: Failed to save config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Added path: %s\n", cleanPath)
}

func handleList() {
	config := loadConfig()

	if len(config.Paths) == 0 {
		fmt.Println("No paths added yet.")
		fmt.Println("Use 'tma-agent add --path <absolute_path>' to add a path")
		return
	}

	fmt.Println("Added drive paths:")
	for i, path := range config.Paths {
		// Check if path still exists
		if _, err := os.Stat(path); err != nil {
			fmt.Printf("  %d. %s (not accessible)\n", i+1, path)
		} else {
			fmt.Printf("  %d. %s\n", i+1, path)
		}
	}
}

func handleRemove() {
	removeCmd := flag.NewFlagSet("remove", flag.ExitOnError)
	path := removeCmd.String("path", "", "Absolute path to remove")
	removeCmd.Parse(os.Args[2:])

	if *path == "" {
		fmt.Println("Error: --path is required")
		fmt.Println("Usage: tma-agent remove --path <absolute_path>")
		os.Exit(1)
	}

	cleanPath := filepath.Clean(*path)
	config := loadConfig()

	// Remove path
	newPaths := []string{}
	found := false
	for _, p := range config.Paths {
		if p == cleanPath {
			found = true
			continue
		}
		newPaths = append(newPaths, p)
	}

	if !found {
		fmt.Printf("Path not found: %s\n", cleanPath)
		os.Exit(1)
	}

	config.Paths = newPaths

	if err := saveConfig(config); err != nil {
		fmt.Printf("Error: Failed to save config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed path: %s\n", cleanPath)
}

func handleToken() {
	tokenCmd := flag.NewFlagSet("token", flag.ExitOnError)
	generate := tokenCmd.Bool("generate", false, "Generate a new token")
	tokenCmd.Parse(os.Args[2:])

	config := loadConfig()

	if *generate || config.Token == "" {
		// Generate a new secure token using crypto/rand
		tokenBytes := make([]byte, 32)
		_, err := rand.Read(tokenBytes)
		if err != nil {
			// Fallback to math/rand if crypto/rand fails
			mathRand := mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
			for i := range tokenBytes {
				tokenBytes[i] = byte(mathRand.Intn(256))
			}
		}

		// Convert to hex string
		token := hex.EncodeToString(tokenBytes)

		// Save to config
		config.Token = token
		if err := saveConfig(config); err != nil {
			fmt.Printf("Error: Failed to save token: %v\n", err)
			os.Exit(1)
		}

		fmt.Println("Generated new token:")
		fmt.Println(token)
		fmt.Println()
		fmt.Println("Use this token in the app settings when configuring the agent.")
		fmt.Println("You can also start the agent with: tma-agent start -token", token)
	} else {
		// Show existing token
		fmt.Println("Current token:")
		fmt.Println(config.Token)
		fmt.Println()
		fmt.Println("Use this token in the app settings when configuring the agent.")
		fmt.Println("To generate a new token, use: tma-agent token -generate")
	}
}

func handleStart() {
	startCmd := flag.NewFlagSet("start", flag.ExitOnError)
	port := startCmd.String("port", "", "Port to listen on (default: 8080)")
	token := startCmd.String("token", "", "Authentication token (optional)")
	startCmd.Parse(os.Args[2:])

	config := loadConfig()

	// Override with command line flags if provided
	if *port != "" {
		config.Port = *port
	}
	if *token != "" {
		config.Token = *token
	}

	// Auto-generate token if not set and not provided via flag
	if config.Token == "" && *token == "" {
		// Generate a new secure token
		tokenBytes := make([]byte, 32)
		_, err := rand.Read(tokenBytes)
		if err != nil {
			// Fallback to math/rand if crypto/rand fails
			mathRand := mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
			for i := range tokenBytes {
				tokenBytes[i] = byte(mathRand.Intn(256))
			}
		}
		config.Token = hex.EncodeToString(tokenBytes)

		// Save the generated token
		if err := saveConfig(config); err != nil {
			log.Printf("WARNING: Failed to save generated token: %v", err)
		} else {
			log.Printf("Generated and saved authentication token")
			log.Printf("Token: %s", config.Token)
			log.Printf("Use this token in the app settings when configuring the agent")
		}
	}

	globalConfig = config

	// Initialize file watcher manager
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Fatalf("Failed to create file watcher: %v", err)
	}
	watcherManager = &WatcherManager{
		watcher:      watcher,
		watchedPaths: make(map[string]bool),
		webhookURL:   config.WebhookURL,
		webhookToken: config.WebhookToken,
	}

	// Start watching for file system events
	go watcherManager.watchEvents()

	// Setup routes
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/version", versionHandler)
	http.HandleFunc("/api/paths", authMiddleware(pathsHandler))
	http.HandleFunc("/api/list", authMiddleware(listHandler))
	http.HandleFunc("/api/read", authMiddleware(readHandler))
	http.HandleFunc("/api/write", authMiddleware(writeHandler))
	http.HandleFunc("/api/rename", authMiddleware(renameHandler))
	http.HandleFunc("/api/delete", authMiddleware(deleteHandler))
	http.HandleFunc("/api/stat", authMiddleware(statHandler))
	http.HandleFunc("/api/mkdir", authMiddleware(mkdirHandler))
	http.HandleFunc("/api/watch", authMiddleware(watchHandler))
	http.HandleFunc("/api/unwatch", authMiddleware(unwatchHandler))

	log.Printf("TMA Drive Agent starting on port %s", config.Port)
	if len(config.Paths) > 0 {
		log.Printf("Monitoring %d drive path(s)", len(config.Paths))
	} else {
		log.Println("WARNING: No drive paths added. Use 'tma-agent add --path <path>' to add paths")
	}
	if config.Token != "" {
		log.Println("Authentication token is configured")
	} else {
		log.Println("WARNING: Running without authentication token")
	}
	if config.WebhookURL != "" {
		log.Printf("Webhook notifications enabled: %s", config.WebhookURL)
	}
	log.Fatal(http.ListenAndServe(":"+config.Port, nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"agent": version})
}

func pathsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"paths": globalConfig.Paths,
	})
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// If no token is configured, allow all requests
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
	if r.Method != http.MethodGet {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return
	}

	// Validate and resolve absolute path
	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Check if path exists
	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Path not found: %v", err))
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ListResponse{
		Files: files,
		Path:  fullPath,
	})
}

func readHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Check if file exists
	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("File not found: %v", err))
		return
	}

	if info.IsDir() {
		sendError(w, http.StatusBadRequest, "Path is a directory, use /api/list instead")
		return
	}

	// Open and stream file
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
	if r.Method != http.MethodPost {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Limit request size
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	// Ensure parent directory exists (only if it doesn't exist)
	parentDir := filepath.Dir(fullPath)
	if _, err := os.Stat(parentDir); os.IsNotExist(err) {
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create parent directory: %v", err))
			return
		}
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "written",
		"path":   fullPath,
		"size":   written,
	})
}

func renameHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid request body: %v", err))
		return
	}

	if req.OldPath == "" || req.NewPath == "" {
		sendError(w, http.StatusBadRequest, "oldPath and newPath are required")
		return
	}

	// Validate and resolve paths
	oldFullPath, err := validateAndResolvePath(req.OldPath)
	if err != nil {
		sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid oldPath: %v", err))
		return
	}

	newFullPath, err := validateAndResolvePath(req.NewPath)
	if err != nil {
		sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid newPath: %v", err))
		return
	}

	// Check if old path exists
	_, err = os.Stat(oldFullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Old path not found: %v", err))
		return
	}

	// Check if new path already exists
	if _, err := os.Stat(newFullPath); err == nil {
		sendError(w, http.StatusConflict, "New path already exists")
		return
	}

	// Ensure parent directory of new path exists
	parentDir := filepath.Dir(newFullPath)
	if _, err := os.Stat(parentDir); os.IsNotExist(err) {
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create parent directory: %v", err))
			return
		}
	}

	// Perform OS-level rename (instant, even for large files)
	if err := os.Rename(oldFullPath, newFullPath); err != nil {
		sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to rename: %v", err))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "renamed",
		"oldPath": oldFullPath,
		"newPath": newFullPath,
	})
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Check if path exists
	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Path not found: %v", err))
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "deleted",
		"path":   fullPath,
	})
}

func statHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
		return
	}

	fullPath, err := validateAndResolvePath(path)
	if err != nil {
		sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Path not found: %v", err))
		return
	}

	fileInfo := FileInfo{
		Name:    filepath.Base(fullPath),
		Path:    fullPath,
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(fileInfo)
}

func mkdirHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		sendError(w, http.StatusBadRequest, "path parameter is required")
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "created",
		"path":   fullPath,
	})
}

// validateAndResolvePath validates and resolves an absolute path
// Also checks if the path is within any of the configured drive paths
func validateAndResolvePath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path is required")
	}

	// Clean the path
	cleanPath := filepath.Clean(path)

	// Must be an absolute path
	if !filepath.IsAbs(cleanPath) {
		return "", fmt.Errorf("path must be absolute")
	}

	// Prevent path traversal attempts
	if strings.Contains(cleanPath, "..") {
		return "", fmt.Errorf("path traversal not allowed")
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
	if globalConfig != nil && len(globalConfig.Paths) > 0 {
		allowed := false
		for _, drivePath := range globalConfig.Paths {
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

// File watching functions

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

	// Get file info first (single stat call)
	info, err := os.Stat(event.Name)
	isDir := false
	size := int64(0)
	modTime := time.Now()
	if err == nil {
		isDir = info.IsDir()
		size = info.Size()
		modTime = info.ModTime()
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
	if r.Method != http.MethodPost {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		Path         string `json:"path"`
		WebhookURL   string `json:"webhookUrl,omitempty"`
		WebhookToken string `json:"webhookToken,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendError(w, http.StatusBadRequest, "Invalid request body")
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

	// Check if it's a directory
	info, err := os.Stat(fullPath)
	if err != nil {
		sendError(w, http.StatusNotFound, fmt.Sprintf("Path not found: %v", err))
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "watching",
		"path":   fullPath,
	})
}

func unwatchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		sendError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req struct {
		Path string `json:"path"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendError(w, http.StatusBadRequest, "Invalid request body")
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "unwatched",
		"path":   fullPath,
	})
}
