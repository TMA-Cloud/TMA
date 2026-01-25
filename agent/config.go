package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

var (
	globalConfig   *Config
	configMu       sync.RWMutex
	configWatcher  *fsnotify.Watcher
	configWatchMu  sync.Mutex
	lastConfigLoad time.Time
)

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
		if err := json.Unmarshal(data, config); err != nil {
			// If config file is corrupted, use defaults
			config.Port = defaultPort
			config.Token = ""
			config.Paths = []string{}
		}
	}

	return config
}

// reloadConfig reloads the configuration from disk and updates globalConfig
// This is thread-safe and should be called when config might have changed
func reloadConfig() {
	configMu.Lock()
	oldWebhookURL := ""
	oldWebhookToken := ""
	if globalConfig != nil {
		oldWebhookURL = globalConfig.WebhookURL
		oldWebhookToken = globalConfig.WebhookToken
	}
	globalConfig = loadConfig()
	lastConfigLoad = time.Now()
	configMu.Unlock()

	// Update watcher manager webhook settings if they changed
	if watcherManager != nil {
		if globalConfig.WebhookURL != oldWebhookURL || globalConfig.WebhookToken != oldWebhookToken {
			watcherManager.setWebhook(globalConfig.WebhookURL, globalConfig.WebhookToken)
		}
	}
}

// startConfigWatcher starts watching the config file for changes
// When the config file is modified, it automatically reloads the config
func startConfigWatcher() error {
	configWatchMu.Lock()
	defer configWatchMu.Unlock()

	// Close existing watcher if any
	if configWatcher != nil {
		configWatcher.Close()
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	configPath := filepath.Join(getExecutableDir(), configFile)
	configDir := filepath.Dir(configPath)

	// Watch the directory containing the config file
	// This is more reliable than watching the file directly on some systems
	if err := watcher.Add(configDir); err != nil {
		watcher.Close()
		return err
	}

	configWatcher = watcher

	// Start goroutine to handle config file changes
	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				// Check if the event is for our config file
				if event.Name == configPath {
					// Handle write/create/rename events (file save operations)
					if event.Op&fsnotify.Write != 0 || event.Op&fsnotify.Create != 0 || event.Op&fsnotify.Rename != 0 {
						// Small delay to ensure file write is complete
						// Some editors use atomic writes (rename), so we need to wait
						time.Sleep(100 * time.Millisecond)
						reloadConfig()
						log.Printf("Config file changed, reloaded configuration")
					}
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log.Printf("Config watcher error: %v", err)
			}
		}
	}()

	return nil
}

// stopConfigWatcher stops watching the config file
func stopConfigWatcher() {
	configWatchMu.Lock()
	defer configWatchMu.Unlock()

	if configWatcher != nil {
		configWatcher.Close()
		configWatcher = nil
	}
}

// getConfig returns a copy of the current global config
// This is thread-safe and always returns the latest config
func getConfig() *Config {
	configMu.RLock()
	defer configMu.RUnlock()

	// If globalConfig is nil, load it
	if globalConfig == nil {
		configMu.RUnlock()
		configMu.Lock()
		if globalConfig == nil {
			globalConfig = loadConfig()
		}
		configMu.Unlock()
		configMu.RLock()
	}

	// Return a copy to avoid race conditions
	config := &Config{
		Port:         globalConfig.Port,
		Token:        globalConfig.Token,
		Paths:        make([]string, len(globalConfig.Paths)),
		WebhookURL:   globalConfig.WebhookURL,
		WebhookToken: globalConfig.WebhookToken,
	}
	copy(config.Paths, globalConfig.Paths)
	return config
}

func saveConfig(config *Config) error {
	configPath := filepath.Join(getExecutableDir(), configFile)
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	err = os.WriteFile(configPath, data, 0644)
	if err != nil {
		return err
	}

	// If service is running, the config watcher will automatically reload
	// But we can also update immediately if globalConfig exists
	configMu.Lock()
	if globalConfig != nil {
		globalConfig = loadConfig()
		lastConfigLoad = time.Now()
	}
	configMu.Unlock()

	return nil
}
