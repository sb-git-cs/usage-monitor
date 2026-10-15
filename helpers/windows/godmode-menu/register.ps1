# Registers the Windows 11 folder-background menu and removes the classic
# "Show more options" verb once that package is installed. Safe to run again.
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

function Fail($message) {
    try { Write-Log "failed: $message" } catch { }
    [Console]::Error.WriteLine($message)
    exit 1
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
    $roots = @(
        "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64",
        "C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64"
    )
    foreach ($root in $roots) {
        $path = Join-Path $root $tool
        if (Test-Path $path) { return $path }
    }
    return $null
}

function Stop-MenuSurrogate {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'dllhost.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        if ($proc.CommandLine -and $proc.CommandLine.IndexOf($Clsid, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $Shell | Out-Null
    $dll = Join-Path $Source "GodmodeMenu.dll"
    if (-not (Test-Path $dll)) { Fail "GodmodeMenu.dll is missing next to register.ps1" }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $dll).Hash
    $installed = Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue
    if ($installed -and (Test-Path $Stamp)) {
        $stamp = (Get-Content -Raw -Path $Stamp).Trim()
        if ($stamp -eq "$($installed.Version)|$hash") {
            Remove-ClassicMenu
            Write-Log "already installed $($installed.Version)"
            exit 0
        }
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

    $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
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
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
        $machinePeople = Get-ChildItem Cert:\LocalMachine\TrustedPeople -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if (-not $machinePeople) { Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null }
        $machineRoot = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if (-not $machineRoot) { Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null }
    }

    if (Test-Path $Layout) { Remove-Item -Recurse -Force $Layout }
    New-Item -ItemType Directory -Force -Path (Join-Path $Layout "Assets") | Out-Null
    Copy-Item $dll (Join-Path $Layout "GodmodeMenu.dll")
    $text = [IO.File]::ReadAllText($manifestPath)
    $text = $text.Replace('Publisher="CN=Usage Monitor"', ('Publisher="' + $cert.Subject + '"'))
    $text = $text.Replace(('Version="' + $versionText + '"'), ('Version="' + $version.ToString() + '"'))
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText((Join-Path $Layout "AppxManifest.xml"), $text, $utf8)

    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { Fail "csc.exe was not found" }
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

    $makeappx = Find-KitTool "makeappx.exe"
    $signtool = Find-KitTool "signtool.exe"
    if (-not $makeappx -or -not $signtool) { Fail "Windows SDK makeappx.exe or signtool.exe was not found" }
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
    exit 0
} catch {
    Fail $_.Exception.Message
}
