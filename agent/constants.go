package main

const (
	defaultPort   = "8080"
	maxUploadSize = 10 << 30 // 10GB
	configFile    = "tma-agent.json"
	logFileName   = "tma-agent.log"
	maxLogSize    = 5 * 1024 * 1024 // 5MB per log file
	maxLogBackups = 3               // number of rotated log files to keep
	version       = "1.0.2"         // Agent version
)
