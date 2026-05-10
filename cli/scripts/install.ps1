# markdrop Windows installer
# Run in PowerShell:
#   irm https://markdrop.in/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo    = "himanshkukreja/markdrop"
$Binary  = "markdrop"
$ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"

Write-Host ""
Write-Host "  markdrop installer" -ForegroundColor Cyan
Write-Host "  https://markdrop.in" -ForegroundColor DarkGray
Write-Host ""

# ── Detect architecture ───────────────────────────────────────────────────────

$Arch = switch ($Env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported architecture: $Env:PROCESSOR_ARCHITECTURE" }
}

# ── Fetch latest release tag ──────────────────────────────────────────────────

Write-Host "  Fetching latest release…" -ForegroundColor DarkGray
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "User-Agent" = "markdrop-installer" }
$Tag     = $Release.tag_name
$Version = $Tag.TrimStart("v")

Write-Host "  Version  : $Tag"
Write-Host "  Platform : windows/$Arch"

# ── Build download URL ────────────────────────────────────────────────────────

$Filename   = "${Binary}_${Version}_windows_${Arch}.zip"
$DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Filename"

Write-Host "  Download : $DownloadUrl"
Write-Host ""

# ── Download and extract ──────────────────────────────────────────────────────

$Tmp     = [System.IO.Path]::Combine($Env:TEMP, "markdrop-install")
$ZipPath = "$Tmp\$Filename"
$ExePath = "$Tmp\${Binary}.exe"

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

Write-Host "  Downloading…" -ForegroundColor DarkGray
Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing

Write-Host "  Extracting…" -ForegroundColor DarkGray
Expand-Archive -Path $ZipPath -DestinationPath $Tmp -Force

if (-not (Test-Path $ExePath)) {
    throw "Binary not found in archive. Expected: ${Binary}.exe"
}

# ── Install to a directory on PATH ───────────────────────────────────────────

# Prefer %LOCALAPPDATA%\markdrop (always writable, no UAC needed).
$InstallDir = "$Env:LOCALAPPDATA\markdrop"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$Dest = "$InstallDir\${Binary}.exe"
Copy-Item -Path $ExePath -Destination $Dest -Force

Write-Host "  Installed to: $Dest"

# Add to user PATH if not already present.
$UserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable(
        "PATH",
        "$UserPath;$InstallDir",
        "User"
    )
    Write-Host ""
    Write-Host "  Added $InstallDir to your PATH." -ForegroundColor DarkGray
    Write-Host "  Restart your terminal for the change to take effect." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  ✓ markdrop $Tag installed!" -ForegroundColor Green
Write-Host "  Run: markdrop --help" -ForegroundColor DarkGray
Write-Host ""

# Clean up temp files.
Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
