package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/fsnotify/fsnotify"
	"github.com/kardianos/service"
)

func main() {
	svcConfig := &service.Config{
		Name:        "tma-agent",
		DisplayName: "TMA Drive Agent",
		Description: "Agent for passing mounted drives",
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

	case "update":
		if err := handleUniversalUpdate(s); err != nil {
			fmt.Printf("Update failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service updated and restarted successfully!")

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

	case "service-start":
		if err := s.Start(); err != nil {
			fmt.Printf("Failed to start service: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service started!")

	case "service-stop":
		if err := s.Stop(); err != nil {
			fmt.Printf("Failed to stop service: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service stopped!")

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

func handleStart() {
	startCmd := flag.NewFlagSet("start", flag.ExitOnError)
	port := startCmd.String("port", "", "Port to listen on (default: 8080)")
	token := startCmd.String("token", "", "Authentication token (optional)")
	startCmd.Parse(os.Args[2:])

	config := loadConfig()

	// Override flags if provided
	if *port != "" {
		config.Port = *port
	}
	if *token != "" {
		config.Token = *token
	}

	// Auto-generate token
	if config.Token == "" && *token == "" {
		config.Token = generateToken()

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
	http.HandleFunc("/api/usage", authMiddleware(usageHandler))
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
