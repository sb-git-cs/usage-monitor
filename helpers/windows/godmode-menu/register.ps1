# Registers the Windows 11 main folder-background menu and removes the classic
# "Show more options" verb once that package is installed. Safe to run again.
# The signed package and its public certificate ship next to this script, so the
# other PC does not need the Windows SDK. Trusting that certificate for the machine
# asks for administrator approval once (LocalMachine\TrustedPeople, never Trusted Root).
# The private key is not in this folder. -RebuildBundle refreshes the shipped package
# on a PC that already has the key and exits without installing.
param(
    [switch]$Elevated,
    [switch]$RebuildBundle
)

$ErrorActionPreference = "Stop"

$Name = "Shivam.UsageMonitor.Shell"
$Subject = "CN=Usage Monitor"
$Clsid = "{4C0E9B2A-7F51-4D63-A18E-6B5C3D9F2704}"
$Source = $PSScriptRoot
$Shell = Join-Path $env:LOCALAPPDATA "UsageMonitor\shell"
$Layout = Join-Path $Shell "pkg-layout"
$Msix = Join-Path $Shell "UsageMonitorShell.msix"
$Stamp = Join-Path $Shell "package-stamp.txt"
$Log = Join-Path $Shell "register.log"

function Write-Log($message) {
    $dir = Split-Path -Parent $Log
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Add-Content -Path $Log -Value $line -Encoding utf8
    Write-Output $message
}

# The elevated run's exit code does not survive the approval prompt, so it leaves a file.
function Write-ElevateResult($code) {
    if (-not $Elevated) { return }
    try {
        $dir = Split-Path -Parent $Log
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -Path (Join-Path $dir "elevate-result.txt") -Value "$code" -Encoding ascii
    } catch { }
}

function Fail($message) {
    try { Write-Log "failed: $message" } catch { }
    Write-ElevateResult 1
    [Console]::Error.WriteLine($message)
    exit 1
}

function Skip($message) {
    try { Write-Log "skipped: $message" } catch { }
    Write-ElevateResult 2
    [Console]::Error.WriteLine($message)
    exit 2
}

function Exit-Ok {
    Write-ElevateResult 0
    exit 0
}

function Remove-ClassicMenu {
    $keys = @(
        "HKCU\Software\Classes\Directory\Background\shell\UsageMonitor.Godmode",
        "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell\UsageMonitor.Godmode.claude",
        "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell\UsageMonitor.Godmode.codex",
        "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell\UsageMonitor.Godmode.grok",
        "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell\UsageMonitor.Godmode.gemini",
        "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell\UsageMonitor.Godmode.cursor"
    )
    foreach ($key in $keys) {
        # A missing key prints to stderr. PowerShell would treat that as a failure.
        & cmd.exe /d /c "reg delete `"$key`" /f >nul 2>&1"
    }
}

function Find-KitTool($tool) {
    $bin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $dirs = Get-ChildItem -Path $bin -Directory -Filter "10.*" -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending
    foreach ($dir in $dirs) {
        $path = Join-Path $dir.FullName "x64\$tool"
        if (Test-Path $path) { return $path }
    }
    return $null
}

function Test-MachineTrust($thumbprint) {
    foreach ($store in @("Cert:\LocalMachine\TrustedPeople", "Cert:\LocalMachine\Root")) {
        if (Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumbprint }) { return $true }
    }
    return $false
}

function Stop-MenuSurrogate {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'dllhost.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        if ($proc.CommandLine -and $proc.CommandLine.IndexOf($Clsid, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The non-elevated run starts this same script elevated and waits. A cancelled prompt
# exits 2 so the app can ask again next launch instead of filing a classic menu.
function Request-Elevation {
    if ($Elevated) { Fail "the menu package is still not trusted after administrator approval" }
    Write-Log "requesting administrator approval for the main right-click menu"
    $result = Join-Path $Shell "elevate-result.txt"
    if (Test-Path $result) { Remove-Item -Force $result }
    try {
        $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arg -Verb RunAs -Wait | Out-Null
    } catch {
        Skip "administrator approval is required once to add the menu to the main right-click menu"
    }
    if (Test-Path $result) {
        $text = (Get-Content -Raw -Path $result).Trim()
        Remove-Item -Force $result -ErrorAction SilentlyContinue
        if ($text -match '^\d+$') { exit ([int]$text) }
    }
    Skip "administrator approval is required once to add the menu to the main right-click menu"
}

function Install-Bundled($msixPath, $cerPath) {
    $published = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cerPath
    if (-not (Test-MachineTrust $published.Thumbprint)) {
        if (-not (Test-Admin)) { Request-Elevation }
        Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    }
    Stop-MenuSurrogate
    Add-AppxPackage -Path $msixPath -ForceUpdateFromAnyVersion
    $got = Get-AppxPackage -Name $Name
    if (-not $got) { Fail "the package did not install" }
    Set-Content -Path $Stamp -Value "$($got.Version)|$hash" -Encoding ascii
    Remove-ClassicMenu
    Write-Log "installed $($got.Version) on the main right-click menu"
}

# Packs and signs the menu into this folder. Uses the key already in Cert:\CurrentUser\My.
# Does not write a .pfx and does not install the package.
function Build-Bundle {
    $makeappx = Find-KitTool "makeappx.exe"
    $signtool = Find-KitTool "signtool.exe"
    if (-not $makeappx -or -not $signtool) { Fail "the Windows SDK packaging tools are not installed, so the menu package cannot be built" }
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { Fail "csc.exe was not found" }
    $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $cert) { Fail "the Usage Monitor signing certificate is not in this user's certificate store" }
    $layout = Join-Path $env:TEMP "um-godmode-layout"
    if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
    New-Item -ItemType Directory -Force -Path (Join-Path $layout "Assets") | Out-Null
    Copy-Item (Join-Path $Source "GodmodeMenu.dll") (Join-Path $layout "GodmodeMenu.dll")
    $manifestText = [IO.File]::ReadAllText((Join-Path $Source "AppxManifest.xml"))
    if ($manifestText -notmatch 'Version="([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)"') { Fail "manifest has no version" }
    $manifestText = $manifestText.Replace('Publisher="CN=Usage Monitor"', ('Publisher="' + $cert.Subject + '"'))
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifestText, $utf8)
    & $csc /nologo /target:exe /out:"$(Join-Path $layout 'UsageMonitorShell.exe')" (Join-Path $Source "UsageMonitorShell.cs")
    if ($LASTEXITCODE -ne 0) { Fail "could not compile UsageMonitorShell.exe" }
    Add-Type -AssemblyName System.Drawing
    function New-Logo($path, $size) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 36, 36, 36))
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bmp.Dispose()
    }
    New-Logo (Join-Path $layout "Assets\StoreLogo.png") 50
    New-Logo (Join-Path $layout "Assets\Square150x150Logo.png") 150
    New-Logo (Join-Path $layout "Assets\Square44x44Logo.png") 44
    $packed = Join-Path $layout "UsageMonitorShell.msix"
    & $makeappx pack /d $layout /p $packed /o
    if ($LASTEXITCODE -ne 0) { Fail "makeappx failed" }
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $packed
    if ($LASTEXITCODE -ne 0) { Fail "signtool failed" }
    Copy-Item $packed (Join-Path $Source "UsageMonitorShell.msix") -Force
    $cerOut = Join-Path $Source "UsageMonitorShell.cer"
    if (Test-Path $cerOut) { Remove-Item -Force $cerOut }
    Export-Certificate -Cert $cert -FilePath $cerOut | Out-Null
    Remove-Item -Recurse -Force $layout
}

try {
    New-Item -ItemType Directory -Force -Path $Shell | Out-Null
    $dll = Join-Path $Source "GodmodeMenu.dll"
    if (-not (Test-Path $dll)) { Fail "GodmodeMenu.dll is missing next to register.ps1" }
    if ($RebuildBundle) {
        Build-Bundle
        Write-Log "built bundled package"
        Exit-Ok
    }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $dll).Hash
    $installed = Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue
    if ($installed -and (Test-Path $Stamp)) {
        $stamp = (Get-Content -Raw -Path $Stamp).Trim()
        if ($stamp -eq "$($installed.Version)|$hash") {
            Remove-ClassicMenu
            Write-Log "already installed $($installed.Version)"
            Exit-Ok
        }
    }

    $bundledMsix = Join-Path $Source "UsageMonitorShell.msix"
    $bundledCer = Join-Path $Source "UsageMonitorShell.cer"
    if ((Test-Path $bundledMsix) -and (Test-Path $bundledCer)) {
        Install-Bundled $bundledMsix $bundledCer
        Exit-Ok
    }

    $manifestPath = Join-Path $Source "AppxManifest.xml"
    $manifestText = [IO.File]::ReadAllText($manifestPath)
    if ($manifestText -notmatch 'Version="([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)"') { Fail "manifest has no version" }
    $versionText = $Matches[1]
    $version = [version]$versionText
    if ($installed) {
        $current = [version]$installed.Version
        if ($current -ge $version) {
            $version = [version]::new($current.Major, $current.Minor, $current.Build, $current.Revision + 1)
        }
    }

    # Check everything this PC needs before creating or trusting a certificate.
    $makeappx = Find-KitTool "makeappx.exe"
    $signtool = Find-KitTool "signtool.exe"
    if (-not $makeappx -or -not $signtool) { Skip "the Windows SDK packaging tools (makeappx.exe, signtool.exe) are not installed" }
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { Skip "csc.exe was not found" }
    $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $cert -or -not (Test-MachineTrust $cert.Thumbprint)) {
        if (-not (Test-Admin)) { Request-Elevation }
    }
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -CertStoreLocation Cert:\CurrentUser\My -FriendlyName "Usage Monitor Shell" -NotAfter (Get-Date).AddYears(5)
    }
    $cer = Join-Path $Shell "UsageMonitorShell.cer"
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    $trusted = Get-ChildItem Cert:\CurrentUser\TrustedPeople -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if (-not $trusted) {
        Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
    }
    # Trusted People on the machine is enough to install a sideloaded package; the
    # certificate is never added to the Trusted Root store.
    if ((Test-Admin) -and -not (Test-MachineTrust $cert.Thumbprint)) {
        Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    }

    if (Test-Path $Layout) { Remove-Item -Recurse -Force $Layout }
    New-Item -ItemType Directory -Force -Path (Join-Path $Layout "Assets") | Out-Null
    Copy-Item $dll (Join-Path $Layout "GodmodeMenu.dll")
    $text = [IO.File]::ReadAllText($manifestPath)
    $text = $text.Replace('Publisher="CN=Usage Monitor"', ('Publisher="' + $cert.Subject + '"'))
    $text = $text.Replace(('Version="' + $versionText + '"'), ('Version="' + $version.ToString() + '"'))
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $Layout "AppxManifest.xml"), $text, $utf8)

    & $csc /nologo /target:exe /out:"$(Join-Path $Layout 'UsageMonitorShell.exe')" (Join-Path $Source "UsageMonitorShell.cs")
    if ($LASTEXITCODE -ne 0) { Fail "could not compile UsageMonitorShell.exe" }

    Add-Type -AssemblyName System.Drawing
    function New-Logo($path, $size) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 36, 36, 36))
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bmp.Dispose()
    }
    New-Logo (Join-Path $Layout "Assets\StoreLogo.png") 50
    New-Logo (Join-Path $Layout "Assets\Square150x150Logo.png") 150
    New-Logo (Join-Path $Layout "Assets\Square44x44Logo.png") 44

    & $makeappx pack /d $Layout /p $Msix /o
    if ($LASTEXITCODE -ne 0) { Fail "makeappx failed" }
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $Msix
    if ($LASTEXITCODE -ne 0) { Fail "signtool failed" }

    Stop-MenuSurrogate
    Add-AppxPackage -Path $Msix -ForceUpdateFromAnyVersion
    $installed = Get-AppxPackage -Name $Name
    if (-not $installed) { Fail "the package did not install" }
    Set-Content -Path $Stamp -Value "$($installed.Version)|$hash" -Encoding ascii
    Remove-ClassicMenu
    Write-Log "installed $($installed.Version)"
    Exit-Ok
} catch {
    Fail $_.Exception.Message
}
