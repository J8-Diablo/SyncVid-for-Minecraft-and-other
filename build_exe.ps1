Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

$specFile = Join-Path $projectRoot "SyncVid.spec"
if (-not (Test-Path $specFile)) {
    throw "SyncVid.spec introuvable."
}

$launch = Get-PythonLaunch
Write-Host "Python:" $launch.Exe ($launch.Prefix -join " ")

# Install/refresh dependencies
Invoke-Python -Launch $launch -ArgList @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Python -Launch $launch -ArgList @("-m", "pip", "install", "-r", (Join-Path $projectRoot "requirements.txt"))
Invoke-Python -Launch $launch -ArgList @("-m", "pip", "install", "pyinstaller")

$buildDir = Join-Path $projectRoot "build"
$distDir = Join-Path $projectRoot "dist"
foreach ($path in @($buildDir, $distDir)) {
    if (Test-Path $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

Invoke-Python -Launch $launch -ArgList @("-m", "PyInstaller", "--clean", "--noconfirm", "SyncVid.spec")

$builtExe = Join-Path $distDir "SyncVid.exe"
if (-not (Test-Path $builtExe)) {
    throw "Build terminee mais dist\SyncVid.exe est introuvable."
}

Write-Host ""
Write-Host "Built: $builtExe"
