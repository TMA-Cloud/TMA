package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

var globalConfig *Config

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

func saveConfig(config *Config) error {
	configPath := filepath.Join(getExecutableDir(), configFile)
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0644)
}
