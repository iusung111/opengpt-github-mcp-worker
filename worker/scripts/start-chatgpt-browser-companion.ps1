param(
	[string]$JobId = "",

	[string]$AppOrigin = "https://opengpt-github-mcp-worker.iusung111.workers.dev",

	[string]$BearerToken = "",

	[string]$QueueToken = "",

	[int]$CdpPort = 9222,

	[string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",

	[string]$ProfileDir = "",

	[switch]$DryRun
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
$chatUrl = "https://chatgpt.com/"
$consoleUrl = "$AppOrigin/gui/"

function Normalize-Token([string]$Value) {
	if ([string]::IsNullOrWhiteSpace($Value)) {
		return ""
	}
	$trimmed = $Value.Trim()
	if ($trimmed.Length -ge 2) {
		$first = $trimmed.Substring(0, 1)
		$last = $trimmed.Substring($trimmed.Length - 1, 1)
		if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'") -or ($first -eq '`' -and $last -eq '`')) {
			return $trimmed.Substring(1, $trimmed.Length - 2).Trim()
		}
	}
	return $trimmed
}

if ([string]::IsNullOrWhiteSpace($BearerToken) -and [string]::IsNullOrWhiteSpace($QueueToken)) {
	if ($env:OPEN_GPT_BEARER_TOKEN) {
		$BearerToken = $env:OPEN_GPT_BEARER_TOKEN
	} elseif ($env:QUEUE_API_TOKEN) {
		$QueueToken = $env:QUEUE_API_TOKEN
	}
}

$BearerToken = Normalize-Token $BearerToken
$QueueToken = Normalize-Token $QueueToken

if ([string]::IsNullOrWhiteSpace($BearerToken) -and [string]::IsNullOrWhiteSpace($QueueToken) -and -not $DryRun) {
	$BearerToken = Read-Host "Bearer token (press Enter to skip)"
	if ([string]::IsNullOrWhiteSpace($BearerToken)) {
		$QueueToken = Read-Host "Queue token (press Enter to skip)"
	}
	$BearerToken = Normalize-Token $BearerToken
	$QueueToken = Normalize-Token $QueueToken
}

function Show-AuthHelpAndExit {
	Write-Host ""
	Write-Host "No operator token was provided." -ForegroundColor Yellow
	Write-Host "Browser companion control requires either a bearer token or a queue token." -ForegroundColor Yellow
	Write-Host ""
	Write-Host "Fastest path:" -ForegroundColor Cyan
	Write-Host "1. Open the full-page console and sign in:" -ForegroundColor DarkGray
	Write-Host "   $consoleUrl" -ForegroundColor White
	Write-Host "2. In that browser tab, open DevTools Console and run:" -ForegroundColor DarkGray
	Write-Host "   localStorage.getItem('opengpt.run-console.token')" -ForegroundColor White
	Write-Host "3. Re-run this script with -BearerToken <value>" -ForegroundColor DarkGray
	Write-Host ""
	Write-Host "You can also set one of these env vars before running:" -ForegroundColor Cyan
	Write-Host "  `$env:OPEN_GPT_BEARER_TOKEN='...'" -ForegroundColor White
	Write-Host "  `$env:QUEUE_API_TOKEN='...'" -ForegroundColor White
	Write-Host ""
	try {
		Start-Process $consoleUrl | Out-Null
		Write-Host "Opened console login page in the default browser." -ForegroundColor Green
	} catch {
		Write-Host "Could not automatically open the console URL. Open it manually." -ForegroundColor Yellow
	}
	exit 1
}

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
} elseif (-not $DryRun) {
	Show-AuthHelpAndExit
}

if (-not [string]::IsNullOrWhiteSpace($JobId)) {
	Write-Host "Ignoring -JobId because the browser companion now operates console-wide." -ForegroundColor Yellow
}

Write-Host "Prepared global browser companion" -ForegroundColor Green
Write-Host "Profile: $ProfileDir" -ForegroundColor DarkGray
Write-Host "App origin: $AppOrigin" -ForegroundColor DarkGray
Write-Host "CDP URL: $cdpUrl" -ForegroundColor DarkGray
Write-Host "Auth mode: $(if (-not [string]::IsNullOrWhiteSpace($BearerToken)) { 'bearer-token' } elseif (-not [string]::IsNullOrWhiteSpace($QueueToken)) { 'queue-token' } else { 'missing (dry-run only)' })" -ForegroundColor DarkGray
Write-Host "Companion command: npm $($companionArgs -join ' ')" -ForegroundColor DarkGray

if ($DryRun) {
	Write-Host "Dry run only. No browser or companion process was started." -ForegroundColor Yellow
	exit 0
}

Write-Host "Starting Edge with remote debugging on $cdpUrl" -ForegroundColor Cyan
Start-Process -FilePath $EdgePath -ArgumentList @(
	"--remote-debugging-port=$CdpPort",
	"--user-data-dir=$ProfileDir",
	$chatUrl
)

Start-Sleep -Seconds 3

Write-Host "Launching global browser companion" -ForegroundColor Green

npm @companionArgs
