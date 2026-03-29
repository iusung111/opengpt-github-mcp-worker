param(
	[string]$JobId = "",

	[string]$AppOrigin = "https://opengpt-github-mcp-worker.iusung111.workers.dev",

	[string]$BearerToken = "",

	[string]$QueueToken = "",

	[int]$CdpPort = 9222,

	[string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",

	[string]$ProfileDir = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $EdgePath)) {
	throw "Edge executable not found at: $EdgePath"
}

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
	$ProfileDir = Join-Path $env:TEMP "opengpt-chatgpt-edge-profile"
}

if (-not (Test-Path $ProfileDir)) {
	New-Item -ItemType Directory -Path $ProfileDir | Out-Null
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$cdpUrl = "http://127.0.0.1:$CdpPort"

Write-Host "Starting Edge with remote debugging on $cdpUrl" -ForegroundColor Cyan
Start-Process -FilePath $EdgePath -ArgumentList @(
	"--remote-debugging-port=$CdpPort",
	"--user-data-dir=$ProfileDir",
	"https://chatgpt.com/"
)

Start-Sleep -Seconds 3

$companionArgs = @(
	"run",
	"browser:companion",
	"--",
	"--app-origin", $AppOrigin,
	"--cdp-url", $cdpUrl
)

if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
	$companionArgs += @("--bearer-token", $BearerToken)
} elseif (-not [string]::IsNullOrWhiteSpace($QueueToken)) {
	$companionArgs += @("--queue-token", $QueueToken)
} else {
	throw "Provide either -BearerToken or -QueueToken."
}

if (-not [string]::IsNullOrWhiteSpace($JobId)) {
	Write-Host "Ignoring -JobId because the browser companion now operates console-wide." -ForegroundColor Yellow
}

Write-Host "Launching global browser companion" -ForegroundColor Green
Write-Host "Profile: $ProfileDir" -ForegroundColor DarkGray
Write-Host "App origin: $AppOrigin" -ForegroundColor DarkGray

npm @companionArgs
