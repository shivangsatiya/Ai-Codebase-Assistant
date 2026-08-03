# Smoke test for a deployed AI Codebase Assistant instance.
#
# Usage:
#   .\smoke-test.ps1 -BaseUrl "https://your-service.onrender.com"
#
# Exercises the exact same flow verified manually throughout local
# development (health checks -> register -> import -> chat), against a
# real deployed URL, so "deployment verification" is a repeatable script
# instead of a one-time manual check that's never run again after the
# first deploy.

param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string]$TestRepo = "https://github.com/lukeed/klona",

    [int]$ImportTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$failures = @()

function Test-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "`n--- $Name ---" -ForegroundColor Cyan
    try {
        & $Action
        Write-Host "PASS: $Name" -ForegroundColor Green
    } catch {
        Write-Host "FAIL: $Name" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        $script:failures += $Name
    }
}

Test-Step "Liveness check (/health/live)" {
    $response = Invoke-RestMethod -Uri "$BaseUrl/health/live"
    if ($response.status -ne "ok") { throw "Expected status 'ok', got '$($response.status)'" }
}

Test-Step "Readiness check (/health/ready)" {
    $response = Invoke-RestMethod -Uri "$BaseUrl/health/ready"
    if ($response.status -ne "ready") { throw "Expected status 'ready', got '$($response.status)' - check MongoDB connectivity" }
}

$script:token = $null
Test-Step "Register a smoke-test account" {
    $email = "smoke-test-$(Get-Random)@example.com"
    $body = @{ email = $email; password = "Password123" } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/auth/register" -Method Post -ContentType "application/json" -Body $body
    if (-not $response.accessToken) { throw "No accessToken in response" }
    $script:token = $response.accessToken
}

$script:repositoryId = $null
Test-Step "Import a small public repository" {
    $body = @{ githubUrl = $TestRepo } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/repositories" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $script:token" } -Body $body
    if (-not $response.repositoryId) { throw "No repositoryId in response" }
    $script:repositoryId = $response.repositoryId
}

Test-Step "Poll until the import reaches 'ready' (timeout: ${ImportTimeoutSeconds}s)" {
    $elapsed = 0
    $pollIntervalSeconds = 5
    while ($elapsed -lt $ImportTimeoutSeconds) {
        $status = Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId" -Headers @{ Authorization = "Bearer $script:token" }
        if ($status.status -eq "ready") { return }
        if ($status.status -eq "failed") { throw "Import failed: $($status.errorMessage)" }
        Start-Sleep -Seconds $pollIntervalSeconds
        $elapsed += $pollIntervalSeconds
    }
    throw "Import did not reach 'ready' within $ImportTimeoutSeconds seconds"
}

$script:chatId = $null
Test-Step "Start a chat" {
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId/chats" -Method Post -Headers @{ Authorization = "Bearer $script:token" }
    if (-not $response.chatId) { throw "No chatId in response" }
    $script:chatId = $response.chatId
}

Test-Step "Ask a question and get a real streamed answer" {
    $body = @{ message = "What does this repository do?" } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/chats/$script:chatId/messages" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $script:token" } -Body $body
    if ($response -notmatch '"token"') { throw "Response did not contain any streamed tokens - check server logs" }
    if ($response -match 'event: error') { throw "Chat stream reported an error - check server logs" }
}

Write-Host "`n===================================" -ForegroundColor Cyan
if ($failures.Count -eq 0) {
    Write-Host "ALL SMOKE TESTS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($failures.Count) SMOKE TEST(S) FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
