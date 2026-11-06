param(
    [string]$HomeDirectory,
    [string]$StateDirectory,
    [string]$AgyBin,
    [switch]$CheckOnly,
    [switch]$SkipPluginRegistration
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This beta supports Windows only.' }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Install Node.js 22 or newer (including npm), restart the terminal, then retry.' }
$bootstrap = Join-Path $PSScriptRoot 'plugin/bootstrap.mjs'
if (-not (Test-Path -LiteralPath $bootstrap)) { throw 'Extract the complete release or clone the repository before running install.ps1.' }
$options = @()
if ($HomeDirectory) { $options += @('--home', [IO.Path]::GetFullPath($HomeDirectory)) }
if ($StateDirectory) { $options += @('--state', [IO.Path]::GetFullPath($StateDirectory)) }
if ($AgyBin) { $options += @('--agy-bin', [IO.Path]::GetFullPath($AgyBin)) }
& $node $bootstrap --doctor @options
if ($LASTEXITCODE -ne 0) { throw 'Environment check failed; resolve the reported errors before installing.' }
if ($CheckOnly) { return }
if (-not $SkipPluginRegistration) {
    $codex = Get-Command codex.exe,codex.cmd,codex.ps1 -ErrorAction SilentlyContinue | Select-Object -First 1
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $codex) { throw 'Codex CLI is required to register the Git marketplace. Install it first, or use -SkipPluginRegistration and add the source in the desktop.' }
    if (-not $git) { throw 'Git for Windows is required to add a Git marketplace. Install Git and retry.' }
}
& $node $bootstrap --install @options
if ($LASTEXITCODE -ne 0) { throw 'Runtime preparation failed. Registration was not attempted.' }
if (-not $SkipPluginRegistration) {
    & $codex.Source plugin marketplace add https://github.com/LingYzh/agent-dock.git --ref v1.1.0-beta.1 --json
    if ($LASTEXITCODE -ne 0) { throw 'Git marketplace registration failed. Runtime files are prepared; retry registration after fixing network access.' }
    & $codex.Source plugin add agent-dock@agent-dock --json
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed. Check codex plugin list and retry.' }
    & $codex.Source plugin list --marketplace agent-dock --json
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation readback failed.' }
}
Write-Output 'Agent Dock beta is prepared. Refresh the desktop plugin connection. Authenticate your selected Agent separately before sending tasks.'
