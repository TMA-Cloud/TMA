package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/kardianos/service"
)

func (p *program) Start(s service.Service) error {
	p.exit = make(chan struct{})
	go func() {
		handleStart()
		close(p.exit)
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	// Stop config watcher when service stops
	stopConfigWatcher()
	if p.exit != nil {
		close(p.exit)
	}
	return nil
}

func handleUniversalInstall(s service.Service, svcConfig *service.Config) error {
	// Stop immediately if service exists
	if _, err := s.Status(); err == nil {
		return fmt.Errorf("service is already installed.\n  - Use 'tma-agent update' to upgrade.\n  - Use 'tma-agent uninstall' to remove it first")
	}

	targetExePath, targetConfigDir := getInstallPaths()

	currentExe, err := getCurrentExecutable()
	if err != nil {
		return err
	}

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

	if err := setExecutablePermissions(targetExePath); err != nil {
		return err
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

func handleUniversalUpdate(s service.Service) error {
	targetExePath, targetConfigDir := getInstallPaths()

	currentExe, err := getCurrentExecutable()
	if err != nil {
		return err
	}

	if currentExe == targetExePath {
		return fmt.Errorf("cannot update from the installed location.\nPlease download the new version to a different folder and run 'tma-agent update' from there")
	}

	fmt.Println("Initiating update...")
	fmt.Printf("Target location: %s\n", targetExePath)

	fmt.Println("Stopping service...")
	if err := s.Stop(); err != nil {
		fmt.Printf("Warning during stop (might not be running): %v\n", err)
	}
	time.Sleep(1 * time.Second)

	// Backup/Prepare old binary
	if runtime.GOOS == "windows" {
		oldPath := targetExePath + ".old"
		os.Remove(oldPath) // Remove previous backup if exists
		if err := os.Rename(targetExePath, oldPath); err != nil {
			return fmt.Errorf("failed to move old binary (is the service stopped?): %v", err)
		}
	} else {
		if err := os.Remove(targetExePath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to remove old binary: %v", err)
		}
	}

	fmt.Println("Copying new version...")
	if err := copyFile(currentExe, targetExePath); err != nil {
		// Attempt rollback (rename .old back)
		if runtime.GOOS == "windows" {
			os.Rename(targetExePath+".old", targetExePath)
		}
		return fmt.Errorf("failed to copy new binary: %v", err)
	}

	if err := setExecutablePermissions(targetExePath); err != nil {
		return err
	}

	// DO NOT touch the config file here to preserve user settings
	fmt.Printf("Existing configuration at %s preserved.\n", filepath.Join(targetConfigDir, configFile))

	fmt.Println("Restarting service...")
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to restart service: %v", err)
	}

	if runtime.GOOS == "windows" {
		fmt.Println("Update complete. You can delete this updater file.")
	} else {
		os.Remove(currentExe)
		fmt.Println("Update complete. Cleaned up source binary.")
	}

	return nil
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
