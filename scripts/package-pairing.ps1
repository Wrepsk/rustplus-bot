param([string]$NodeVersion = '22.23.3')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build the Windows helper on Windows or use the GitHub workflow.' }
if ($NodeVersion -notmatch '^22\.\d+\.\d+$') { throw 'Choose a Node 22 release such as 22.23.3.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifacts = Join-Path $root 'artifacts'
$cache = Join-Path $artifacts 'cache'
$staging = Join-Path $artifacts ('pairing-build-' + [Guid]::NewGuid().ToString('N'))
$bundle = Join-Path $staging 'RustPlus Pairing'
$app = Join-Path $bundle 'app'
[IO.Directory]::CreateDirectory($cache) | Out-Null
[IO.Directory]::CreateDirectory($app) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
try {
    Push-Location $root
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    } finally { Pop-Location }

    $archiveName = "node-v$NodeVersion-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/v$NodeVersion"
    Write-Host "Downloading/verifying the official Node $NodeVersion Windows runtime..."
    $checksums = Invoke-RestMethod -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 60
    $checksumLine = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $archiveName") })
    if (@($checksumLine).Count -ne 1 -or $checksumLine -notmatch '^([a-f0-9]{64})\s+') {
        throw 'Could not find the official Windows runtime checksum.'
    }
    $expectedHash = $Matches[1]
    $nodeArchive = Join-Path $cache $archiveName
    if (!(Test-Path -LiteralPath $nodeArchive)) {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $nodeArchive -TimeoutSec 300
    }
    if ((Get-Sha256 $nodeArchive) -ne $expectedHash) {
        throw 'Node download checksum mismatch. Delete the cached runtime ZIP and try again.'
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($nodeArchive)
    try {
        foreach ($file in @('node.exe', 'LICENSE')) {
            $entry = $zip.GetEntry("node-v$NodeVersion-win-x64/$file")
            if (!$entry) { throw 'The official Node archive is missing a required file.' }
            $destination = if ($file -eq 'LICENSE') { Join-Path $app 'NODE-LICENSE.txt' } else { Join-Path $app $file }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
        }
    } finally { $zip.Dispose() }

    # Explicit allowlist: never copy the working tree, .env, data, private keys,
    # credentials, source maps, or a developer's existing registration file.
    Copy-Item -LiteralPath (Join-Path $root 'package.json'), (Join-Path $root 'package-lock.json') -Destination $app
    [IO.Directory]::CreateDirectory((Join-Path $app 'pairing')) | Out-Null
    foreach ($file in @('helper.js', 'crypto.js', 'schema.js')) {
        Copy-Item -LiteralPath (Join-Path $root "dist/pairing/$file") -Destination (Join-Path $app 'pairing')
    }
    Copy-Item -LiteralPath (Join-Path $root 'desktop/pair.ps1') -Destination $app
    Copy-Item -LiteralPath (Join-Path $root 'desktop/RustPlus Pairing.cmd'), (Join-Path $root 'desktop/READ ME.txt') -Destination $bundle
    Write-Host 'Installing locked production dependencies into the isolated bundle...'
    & npm.cmd ci --omit=dev --ignore-scripts --prefix $app --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Could not install locked helper dependencies.' }

    # The upstream CLI listens on all interfaces. Restrict its short-lived login
    # callback to this PC. Refuse to silently patch an unknown library version.
    $cli = Join-Path $app 'node_modules/@liamcottle/rustplus.js/cli/index.js'
    $cliText = [IO.File]::ReadAllText($cli)
    $original = 'server = app.listen(port, async () => {'
    if (($cliText.Split(@($original), [StringSplitOptions]::None)).Count -ne 2) {
        throw 'The upstream pairing CLI changed; review its callback binding before packaging.'
    }
    $profileFlag = "'--user-data-dir=/tmp/temporary-chrome-profile-dir-rustplus',"
    if (!$cliText.Contains($profileFlag)) { throw 'Review the upstream Chrome profile before packaging.' }
    # chrome-launcher creates and cleans a unique temporary profile by default.
    # Remove upstream's Unix-specific hardcoded path for Windows portability.
    $cliText = $cliText.Replace($profileFlag, '')
    [IO.File]::WriteAllText($cli, $cliText.Replace($original, "server = app.listen(port, '127.0.0.1', async () => {"))

    # Start the actual bundled Node, not a globally installed Node. Synthetic
    # credentials ensure this smoke check never opens Chrome or contacts Steam.
    $smoke = Join-Path $staging 'smoke'
    [IO.Directory]::CreateDirectory($smoke) | Out-Null
    $smokeScript = @'
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pairingChallenge, decryptPairing } = require('./pairing/crypto');
const cli = join(__dirname, 'node_modules/@liamcottle/rustplus.js/cli/index.js');
const cliHelp = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
if (cliHelp.status !== 0 || !cliHelp.stdout.includes('fcm-register')) {
  console.error('The bundled upstream registration CLI could not load.');
  console.error('Exit:', cliHelp.status, 'Spawn error:', cliHelp.error?.code || 'none');
  console.error((cliHelp.stderr || '').slice(0, 2000));
  process.exit(1);
}
const challenge = pairingChallenge();
const credentials = { androidId: '123456789', securityToken: '987654321' };
const file = join(process.argv[2], 'test-pairing.json');
writeFileSync(file, JSON.stringify({ fcm_credentials: { gcm: credentials } }));
const result = spawnSync(process.env.SystemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'pair.ps1'),
   '-SmokeTest', '-Code', challenge.code, '-ConfigFile', file],
  { encoding: 'utf8', timeout: 30000, windowsHide: true });
const data = /\/pair import data:([\w.-]+)/.exec(result.stdout || '')?.[1];
if (result.status !== 0 || !data || result.stdout.includes(credentials.securityToken) ||
    JSON.stringify(decryptPairing(challenge.privateKey, data)) !== JSON.stringify(credentials)) {
  console.error('Bundled runtime / Windows UI smoke test failed. No credentials were used.');
  // This subprocess is restricted to a synthetic saved registration. Its
  // diagnostics can therefore be shown without exposing a real pairing file.
  console.error('Exit:', result.status, 'Spawn error:', result.error?.code || 'none');
  console.error((result.stderr || '').slice(0, 3000));
  process.exit(1);
}
console.log('Bundled Node + Windows UI + encrypted import smoke test passed (synthetic credentials).');
'@
    $smokePath = Join-Path $app 'smoke.cjs'
    [IO.File]::WriteAllText($smokePath, $smokeScript)
    & (Join-Path $app 'node.exe') $smokePath $smoke
    if ($LASTEXITCODE -ne 0) { throw 'The packaged helper did not pass its smoke test.' }
    Remove-Item -LiteralPath $smokePath

    @{
        node = $NodeVersion
        nodeArchiveSha256 = $expectedHash
        rustplus = '2.5.0'
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        upstreamPatch = 'Loopback-only login callback; chrome-launcher temporary profile'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'build-info.json') -Encoding UTF8
    $output = Join-Path $artifacts 'RustPlus-Pairing-Windows-x64.zip'
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output }
    Write-Host 'Creating the downloadable ZIP...'
    # Include only the public bundle. Synthetic test files are its sibling and
    # never enter the archive, even temporarily.
    [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $output, [IO.Compression.CompressionLevel]::Optimal, $true)
    $hash = Get-Sha256 $output
    "$hash  RustPlus-Pairing-Windows-x64.zip" | Set-Content -LiteralPath "$output.sha256" -Encoding ASCII
    Write-Host "Ready: $output"
    Write-Host "SHA256: $hash"
} finally {
    # Keep the reusable verified runtime download, remove only this build's
    # generated directory after checking its resolved absolute location.
    if (Test-Path -LiteralPath $staging) {
        $resolved = (Resolve-Path -LiteralPath $staging).Path
        if (!$resolved.StartsWith($artifacts + [IO.Path]::DirectorySeparatorChar) -or
            [IO.Path]::GetFileName($resolved) -notmatch '^pairing-build-[a-f0-9]{32}$') {
            throw 'Unsafe staging cleanup path.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
