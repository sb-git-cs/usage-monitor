# Install Claude Code, Codex, Antigravity (agy), and Grok Build if missing,
# then start Usage Monitor. Safe to re-run: already-installed CLIs are skipped.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $extra = @(
    (Join-Path $env:USERPROFILE ".local\bin"),
    (Join-Path $env:LOCALAPPDATA "agy\bin"),
    (Join-Path $env:USERPROFILE ".grok\bin"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin")
  )
  $parts = @()
  foreach ($chunk in @($machine, $user) + $extra) {
    if ($chunk) { $parts += $chunk }
  }
  $env:Path = ($parts -join ";")
}

function Test-Cli([string]$Name) {
  Refresh-Path
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return $true }
  $candidates = @(
    (Join-Path $env:USERPROFILE ".local\bin\$Name.exe"),
    (Join-Path $env:LOCALAPPDATA "agy\bin\$Name.exe"),
    (Join-Path $env:USERPROFILE ".grok\bin\$Name.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\$Name.exe")
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $true }
  }
  return $false
}

function Invoke-RemoteInstaller([string]$Url) {
  $cmd = "Invoke-RestMethod -Uri '$Url' | Invoke-Expression"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $cmd
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "installer exited $LASTEXITCODE"
  }
}

function Install-Cli {
  param(
    [string]$Name,
    [string]$Label,
    [string]$Url
  )
  if (Test-Cli $Name) {
    Write-Host "OK  $Label already installed"
    return $true
  }
  Write-Host ">>  Installing $Label ..."
  try {
    Invoke-RemoteInstaller $Url
    Refresh-Path
    if (Test-Cli $Name) {
      Write-Host "OK  $Label installed"
      return $true
    }
    Write-Host "WARN  $Label installer finished but '$Name' is not on PATH yet. Open a new terminal after setup."
    return $false
  } catch {
    Write-Host "FAIL $Label : $($_.Exception.Message)"
    return $false
  }
}

Write-Host "Usage Monitor setup"
Write-Host "Repo: $Root"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ is required. Install it from https://nodejs.org/ then re-run."
  exit 1
}

$nodeVer = (node -v).TrimStart("v")
$major = [int]($nodeVer.Split(".")[0])
if ($major -lt 20) {
  Write-Host "Node.js $nodeVer found. Need 20 or newer."
  exit 1
}

if (-not (Test-Path (Join-Path $Root "node_modules\electron"))) {
  Write-Host ">>  npm install (Usage Monitor)"
  npm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "OK  Usage Monitor dependencies present"
}

Write-Host ""
Write-Host "Installing coding CLIs (skips any already present)"
$okClaude = Install-Cli -Name "claude" -Label "Claude Code" -Url "https://claude.ai/install.ps1"
$okCodex  = Install-Cli -Name "codex"  -Label "Codex"       -Url "https://chatgpt.com/codex/install.ps1"
$okAgy    = Install-Cli -Name "agy"    -Label "Antigravity (Gemini)" -Url "https://antigravity.google/cli/install.ps1"
$okGrok   = Install-Cli -Name "grok"   -Label "Grok Build"  -Url "https://x.ai/cli/install.ps1"

Write-Host ""
Write-Host "CLI status"
Write-Host ("  claude  " + $(if ($okClaude -or (Test-Cli "claude")) { "ready" } else { "missing" }))
Write-Host ("  codex   " + $(if ($okCodex  -or (Test-Cli "codex"))  { "ready" } else { "missing" }))
Write-Host ("  agy     " + $(if ($okAgy    -or (Test-Cli "agy"))    { "ready" } else { "missing" }))
Write-Host ("  grok    " + $(if ($okGrok   -or (Test-Cli "grok"))   { "ready" } else { "missing" }))
Write-Host ""
Write-Host "Sign in once per tool (opens a browser):"
Write-Host "  claude"
Write-Host "  codex login"
Write-Host "  agy"
Write-Host "  grok"
Write-Host ""
Write-Host ">>  Starting Usage Monitor"
npm start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Usage Monitor is running. Quit from the right-click menu on chips or the flyout."
