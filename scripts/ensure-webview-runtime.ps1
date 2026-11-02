param([string]$Out = 'ci-results/webview-runtime.json')
$ErrorActionPreference = 'Stop'
$taskTemp = [IO.Path]::GetFullPath($env:REVQORA_TEST_TMP)
if (-not [IO.Path]::IsPathRooted($env:REVQORA_TEST_TMP)) { throw 'An absolute isolated temp root is required' }
foreach ($key in @('TEMP','TMP','TMPDIR')) {
  if ([IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable($key)) -ne $taskTemp) { throw 'All temporary directories must use the isolated root' }
}
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
function Runtime-Versions {
  $roots = @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:ProgramFiles\Microsoft\EdgeWebView\Application", "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application")
  foreach ($root in $roots) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $browser = Join-Path $dir.FullName 'msedgewebview2.exe'
      if (Test-Path -LiteralPath $browser) {
        try {
          $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($browser).FileVersion
          if ($version -match '(\d+\.\d+\.\d+\.\d+)') { @{path=$dir.FullName;version=$Matches[1]} }
        } catch { Write-Warning "Cannot inspect an existing WebView2 version folder: $($dir.FullName)" }
      }
    }
  }
}
$timer = [Diagnostics.Stopwatch]::StartNew()
$report = [ordered]@{before=@(Runtime-Versions);after=@();exitCode=$null;elapsedMs=0;installerSha256=$null}
$installer = Join-Path $taskTemp ("webview-bootstrap-" + [guid]::NewGuid().ToString('N') + '.exe')
$failure = $null
try {
  # Folder presence is insufficient: the runner's 156.0.4314.50 hung before
  # initialization; a signed Evergreen refresh to .58 passed on both OS images.
  Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft WebView2 bootstrapper signature validation failed' }
  $report.installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
  $installed = Start-Process -FilePath $installer -ArgumentList '/silent','/install' -WindowStyle Hidden -Wait -PassThru
  $report.exitCode = $installed.ExitCode
  if ($installed.ExitCode -notin @(0,3010)) { throw "Evergreen preparation failed: $($installed.ExitCode)" }
  $report.after = @(Runtime-Versions)
  if (-not @($report.after | Where-Object { [version]$_.version -ge [version]'156.0.4314.58' }).Count) { throw 'The tested CI runtime baseline 156.0.4314.58 or newer is unavailable after installation' }
} catch {
  $failure = $_
  $report.failure = $_.Exception.Message
} finally {
  $timer.Stop(); $report.elapsedMs = $timer.ElapsedMilliseconds
  if (Test-Path -LiteralPath $installer) {
    try {
      $resolved = (Resolve-Path -LiteralPath $installer).Path
      if ((Split-Path -Parent $resolved) -ne $taskTemp) { throw 'Unowned bootstrapper cleanup path' }
      Remove-Item -LiteralPath $resolved -Force
    } catch { $report.cleanupFailure = $_.Exception.Message }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent ([IO.Path]::GetFullPath($Out))) | Out-Null
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out
  Write-Output ($report | ConvertTo-Json -Compress -Depth 5)
}
if ($failure) { throw $failure }
if ($report.cleanupFailure) { throw $report.cleanupFailure }
