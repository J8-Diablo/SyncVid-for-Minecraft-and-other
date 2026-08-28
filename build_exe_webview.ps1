Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Build script for the WebView2 (pywebview) variant.
# Does NOT touch the PySide6 build (gui.py / SyncVid.spec / build_exe.ps1).

function Get-PythonLaunch {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @{ Exe = "python"; Prefix = @() }
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @{ Exe = "py"; Prefix = @("-3") }
    }
    throw "Python launcher introuvable. Installez Python puis relancez."
}

function Invoke-Python {
    param(
        [Parameter(Mandatory = $true)] [hashtable]$Launch,
        [Parameter(Mandatory = $true)] [string[]]$ArgList
    )
    & $Launch.Exe @($Launch.Prefix + $ArgList)
    if ($LASTEXITCODE -ne 0) {
        throw "Commande Python echouee: $($Launch.Exe) $($Launch.Prefix + $ArgList -join ' ')"
    }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$specFile = Join-Path $projectRoot "SyncVid-WebView.spec"
if (-not (Test-Path $specFile)) {
    throw "SyncVid-WebView.spec introuvable."
}

$launch = Get-PythonLaunch
Write-Host "Python:" $launch.Exe ($launch.Prefix -join " ")

# Install the WebView2 build dependencies (backend + pywebview + pyinstaller).
# This is intentionally an inline list so the original requirements.txt
# stays untouched for the PySide6 build.
Invoke-Python -Launch $launch -ArgList @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Python -Launch $launch -ArgList @(
    "-m", "pip", "install",
    "fastapi>=0.110.0",
    "uvicorn[standard]>=0.27.0",
    "python-socketio>=5.11.0",
    "python-multipart>=0.0.9",
    "pywebview>=5.0",
    "pythonnet>=3.0.3",
    "pyinstaller"
)

$buildDir = Join-Path $projectRoot "build-webview"
$distDir = Join-Path $projectRoot "dist-webview"
foreach ($path in @($buildDir, $distDir)) {
    if (Test-Path $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

Invoke-Python -Launch $launch -ArgList @(
    "-m", "PyInstaller",
    "--clean", "--noconfirm",
    "--distpath", $distDir,
    "--workpath", $buildDir,
    "SyncVid-WebView.spec"
)

$builtExe = Join-Path $distDir "SyncVid-WebView.exe"
if (-not (Test-Path $builtExe)) {
    throw "Build terminee mais $builtExe est introuvable."
}

$sizeMb = [math]::Round(((Get-Item $builtExe).Length / 1MB), 1)

Write-Host ""
Write-Host "Built: $builtExe ($sizeMb MB)"
Write-Host "Requires Microsoft Edge WebView2 Runtime on target machine."
