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
    $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'plugin/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $releaseRef = "v$($package.version)"
    $marketplaceUrl = 'https://github.com/LingYzh/agent-dock.git'
    $inventoryJson = & $codex.Source plugin marketplace list --json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the existing marketplace registrations; no registration was changed.' }
    $inventory = ($inventoryJson -join "`n") | ConvertFrom-Json
    $existingMarketplace = $inventory.marketplaces | Where-Object { $_.name -eq 'agent-dock' } | Select-Object -First 1
    if ($existingMarketplace -and ($existingMarketplace.marketplaceSource.sourceType -ne 'git' -or $existingMarketplace.marketplaceSource.source.TrimEnd('/') -notin @($marketplaceUrl, 'https://github.com/LingYzh/agent-dock'))) {
        throw 'The agent-dock marketplace points to a different source. Inspect it and explicitly remove or rename that registration before retrying.'
    }
    # Verify the new tag before replacing a working registration. Session state
    # lives outside both the Git snapshot and the installed plugin cache.
    & $git.Source ls-remote --exit-code $marketplaceUrl "refs/tags/$releaseRef" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The target release tag could not be verified. Check network access; no registration was changed.' }
}
& $node $bootstrap --install @options
if ($LASTEXITCODE -ne 0) { throw 'Runtime preparation failed. Registration was not attempted.' }
if (-not $SkipPluginRegistration) {
    if ($existingMarketplace) {
        & $codex.Source plugin marketplace remove agent-dock --json
        if ($LASTEXITCODE -ne 0) { throw 'Could not replace the old Git marketplace registration.' }
    }
    & $codex.Source plugin marketplace add $marketplaceUrl --ref $releaseRef --json
    if ($LASTEXITCODE -ne 0) { throw 'Git marketplace registration failed. Runtime files are prepared; retry registration after fixing network access.' }
    & $codex.Source plugin add agent-dock@agent-dock --json
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed. Check codex plugin list and retry.' }
    & $codex.Source plugin list --marketplace agent-dock --json
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation readback failed.' }
}
Write-Output 'Agent Dock beta is prepared. Refresh the desktop plugin connection. Authenticate your selected Agent separately before sending tasks.'
