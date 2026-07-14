; Custom NSIS install/uninstall hooks for TMA Cloud.
;
; The Cloud Drive feature needs WinFsp (a signed kernel-mode filesystem
; driver) present on the machine. WinFsp cannot be xcopy-deployed, so if it
; is not already installed we run its redistributable MSI silently.
;
; Bundling: place the WinFsp redistributable as
;   electron/clouddrive-dist/winfsp.msi
; before building. It is copied to resources/clouddrive/winfsp.msi. If the MSI
; is not bundled, installation still succeeds and the Cloud Drive simply stays
; unavailable until the user installs WinFsp themselves.

!macro customInstall
  ; Already installed? WinFsp records its InstallDir in the registry.
  ReadRegStr $0 HKLM "SOFTWARE\WinFsp" "InstallDir"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\WinFsp" "InstallDir"
  ${EndIf}

  ${If} $0 == ""
    IfFileExists "$INSTDIR\resources\clouddrive\winfsp.msi" 0 winfsp_skip
      DetailPrint "Installing WinFsp (required for TMA Cloud Drive)..."
      ExecWait 'msiexec /i "$INSTDIR\resources\clouddrive\winfsp.msi" /qn /norestart' $1
      DetailPrint "WinFsp installer finished (exit code $1)."
    winfsp_skip:
  ${EndIf}
!macroend

!macro customUnInstall
  ; Leave WinFsp installed: other applications (e.g. sshfs-win, rclone) may
  ; depend on it. We only remove our own files.
!macroend
