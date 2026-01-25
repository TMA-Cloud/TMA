package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func printUsage() {
	fmt.Println("TMA Drive Agent - Standalone agent for passing mounted drives")
	fmt.Println()
	fmt.Println("Management Commands:")
	fmt.Println("  tma-agent add --path <path>      Add a drive path")
	fmt.Println("  tma-agent remove --path <path>   Remove a drive path")
	fmt.Println("  tma-agent list                   List all added paths")
	fmt.Println("  tma-agent token                  Generate or show token")
	fmt.Println()
	fmt.Println("Service Commands (Run as Admin/Root):")
	fmt.Println("  tma-agent install                Install to system safe location")
	fmt.Println("  tma-agent update                 Update installed agent with this binary")
	fmt.Println("  tma-agent uninstall              Remove service and files")
	fmt.Println("  tma-agent service-start          Start the background service")
	fmt.Println("  tma-agent service-stop           Stop the background service")
	fmt.Println()
	fmt.Println("Manual Run:")
	fmt.Println("  tma-agent start                  Run interactively (ctrl+c to stop)")
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

	// Remove path using efficient slice filtering
	originalLen := len(config.Paths)
	config.Paths = filterPaths(config.Paths, cleanPath)

	if len(config.Paths) == originalLen {
		fmt.Printf("Path not found: %s\n", cleanPath)
		os.Exit(1)
	}

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
		token := generateToken()

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
		fmt.Println("Current token:")
		fmt.Println(config.Token)
		fmt.Println()
		fmt.Println("Use this token in the app settings when configuring the agent.")
		fmt.Println("To generate a new token, use: tma-agent token -generate")
	}
}
