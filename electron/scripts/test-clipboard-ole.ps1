# Test clipboard: run immediately after copying.
# Supports: Outlook (right-click attachment -> Copy), Snipping Tool / screenshots, Explorer (file copy).
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if (-not $data) { Write-Host "Clipboard is empty or inaccessible"; exit 1 }
Write-Host "=== Clipboard formats ==="
$data.GetFormats() | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "--- OLE / Outlook attachments ---"
Write-Host "  FileGroupDescriptorW:" $data.GetDataPresent("FileGroupDescriptorW")
Write-Host "  FileGroupDescriptor:" $data.GetDataPresent("FileGroupDescriptor")
Write-Host "  FileContents:" $data.GetDataPresent("FileContents")
if ($data.GetDataPresent("FileGroupDescriptorW")) {
    $ms = $data.GetData("FileGroupDescriptorW")
    Write-Host "  FileGroupDescriptorW stream length:" $ms.Length
}
if ($data.GetDataPresent("FileContents")) {
    $fc = $data.GetData("FileContents")
    Write-Host "  FileContents type:" $fc.GetType().Name
    if ($fc -is [System.IO.MemoryStream]) { Write-Host "  FileContents stream length:" $fc.Length }
}
Write-Host ""
Write-Host "--- Image (Snipping Tool, screenshots) ---"
Write-Host "  Bitmap/Image:" $data.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)
if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) { Write-Host "  Image size:" $img.Width "x" $img.Height; $img.Dispose() }
}
Write-Host ""
Write-Host "--- File paths (Explorer / desktop copy) ---"
Write-Host "  FileDrop:" $data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)
if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $paths = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
    $paths | ForEach-Object { Write-Host "  " $_ }
}
