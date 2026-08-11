# Smoke test for a deployed AI Codebase Assistant instance.
#
# Usage:
#   .\smoke-test.ps1 -BaseUrl "https://your-service.onrender.com"
#   .\smoke-test.ps1 -BaseUrl "http://localhost:4000"
#
# Exercises the critical end-to-end path against a real running
# backend: auth -> import -> ready -> knowledge graph -> architecture
# intelligence -> /graph/ask (both response modes) -> authorization ->
# cleanup. Fast, repeatable, deterministic - this is a health check for
# a deployment, not a substitute for the unit/integration/evaluation/E2E
# suites, which is why every assertion here checks structural shape
# (does this respond, does it look like the real contract) rather than
# exact content (see README.md alongside this script for more).

param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    # A genuinely small repo - the current schema default for
    # MAX_REPO_FILES is actually 3000 (verified directly against
    # env.ts during the Milestone 3 retrospective, not assumed from an
    # older comment), but kept small anyway on purpose: a smoke test
    # should stay fast, and a large repository's import time has never
    # been measured in this project, so it's an unknown, not a safe
    # assumption for a script meant to run quickly after every deploy.
    [string]$TestRepo = "https://github.com/sindresorhus/is-fullwidth-code-point",

    [int]$HttpTimeoutSeconds = 30,
    [int]$ImportTimeoutSeconds = 180,
    [int]$SseTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
Import-Module "$PSScriptRoot/smoke-test-lib.psm1" -Force

$script:failures = @()
$script:token = $null
$script:repositoryId = $null

function Test-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "`n--- $Name ---" -ForegroundColor Cyan
    try {
        & $Action
        Write-Host "PASS: $Name" -ForegroundColor Green
    } catch {
        $safeMessage = Format-SafeErrorMessage -Operation $Name -RawMessage $_.Exception.Message
        Write-Host $safeMessage -ForegroundColor Red
        $script:failures += $Name
    }
}

# Runs the whole smoke test inside try/finally specifically so cleanup
# (deleting the test repository) happens even if a LATER step throws an
# exception that somehow escapes Test-Step's own internal try/catch -
# Test-Step already prevents most failures from propagating, but this
# is a second, defensive layer for anything genuinely unexpected,
# matching the explicit "cleanup must happen even when an earlier test
# step fails" requirement rather than relying on Test-Step alone.
try {

Test-Step "Liveness check (/health/live)" {
    $response = Invoke-RestMethod -Uri "$BaseUrl/health/live" -TimeoutSec $HttpTimeoutSeconds
    if ($response.status -ne "ok") { throw "Expected status 'ok', got '$($response.status)'" }
}

Test-Step "Readiness check (/health/ready)" {
    $response = Invoke-RestMethod -Uri "$BaseUrl/health/ready" -TimeoutSec $HttpTimeoutSeconds
    if ($response.status -ne "ready") { throw "Expected status 'ready', got '$($response.status)' - check MongoDB connectivity" }
}

Test-Step "Unauthenticated requests are correctly rejected" {
    $rejected = $false
    try {
        Invoke-RestMethod -Uri "$BaseUrl/api/repositories" -Method Get -TimeoutSec $HttpTimeoutSeconds
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) { $rejected = $true }
    }
    if (-not $rejected) { throw "Expected HTTP 401 for an unauthenticated request, but it was not rejected" }
}

Test-Step "Register a smoke-test account" {
    # A fresh, disposable identity per run, not a reused credential -
    # matches "do not hardcode passwords/tokens" and keeps this
    # repeatable without depending on any pre-existing account.
    $email = "smoke-test-$(Get-Random)@example.com"
    $body = @{ email = $email; password = "Password123" } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/auth/register" -Method Post -ContentType "application/json" -Body $body -TimeoutSec $HttpTimeoutSeconds
    if (-not $response.accessToken) { throw "No accessToken in response" }
    $script:token = $response.accessToken
}

Test-Step "Import a small public repository" {
    $body = @{ githubUrl = $TestRepo } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/repositories" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $script:token" } -Body $body -TimeoutSec $HttpTimeoutSeconds
    if (-not $response.repositoryId) { throw "No repositoryId in response" }
    $script:repositoryId = $response.repositoryId
}

Test-Step "Poll until the import reaches 'ready' (timeout: ${ImportTimeoutSeconds}s)" {
    $result = Wait-ForCondition `
        -Check { Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId" -Headers @{ Authorization = "Bearer $script:token" } -TimeoutSec $HttpTimeoutSeconds } `
        -IsSuccess { param($s) $s.status -eq "ready" } `
        -IsFailure { param($s) $s.status -eq "failed" } `
        -TimeoutSeconds $ImportTimeoutSeconds -IntervalSeconds 5

    if ($result.TimedOut) { throw "Import did not reach 'ready' within $ImportTimeoutSeconds seconds - last poll never returned a terminal state" }
    if (-not $result.Succeeded) { throw "Import failed: $($result.FinalState.errorMessage)" }
}

$script:graphRootNodeId = $null
Test-Step "Knowledge graph is ready (a real, separate state machine from repository status)" {
    # Repository status reaching 'ready' does NOT guarantee the graph
    # also reached 'ready' - verified directly in
    # repository-import.service.ts: graph generation is awaited and can
    # fail non-fatally BEFORE the repository itself is marked ready.
    # Checked explicitly and separately here, not assumed.
    $graph = Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId/graph" -Headers @{ Authorization = "Bearer $script:token" } -TimeoutSec $HttpTimeoutSeconds
    if ($graph.status -ne "ready") { throw "Expected graph status 'ready', got '$($graph.status)'" }
    $graphNodes = @($graph.nodes)
    if ($graphNodes.Count -eq 0) { throw "Graph has zero nodes - a real repository should have at least the synthesized root" }
    if ($null -eq $graph.edges) { throw "Graph response is missing an edges field entirely" }

    $root = $graphNodes | Where-Object { $_.type -eq "repository" } | Select-Object -First 1
    if (-not $root) { throw "No repository-type root node found - violates the graph's own 'exactly one root' invariant" }
    $script:graphRootNodeId = $root.id
}

Test-Step "Architecture Intelligence: cycle detection returns a real, valid result" {
    $result = Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId/graph/analysis/cycle-detection" -Headers @{ Authorization = "Bearer $script:token" } -TimeoutSec $HttpTimeoutSeconds
    if ($null -eq $result.result.cycleCount) { throw "Response is missing cycleCount - not a real cycle-detection result shape" }
    if ($null -eq $result.result.cycles) { throw "Response is missing the cycles array" }
}

Test-Step "/graph/ask - deterministic path (Pure Graph, immediate JSON, no AI)" {
    $body = @{ question = "What does this repository depend on?"; nodeId = $script:graphRootNodeId } | ConvertTo-Json
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/repositories/$script:repositoryId/graph/ask" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $script:token" } -Body $body -TimeoutSec $HttpTimeoutSeconds
    if ($response.Headers["Content-Type"] -notmatch "application/json") { throw "Expected a JSON response, got Content-Type: $($response.Headers['Content-Type'])" }
    $parsed = $response.Content | ConvertFrom-Json
    if ($parsed.category -ne "pure_graph") { throw "Expected category 'pure_graph', got '$($parsed.category)'" }
}

Test-Step "/graph/ask - AI/SSE path (streamed answer, timeout: ${SseTimeoutSeconds}s)" {
    $body = @{ question = "Explain what this repository does."; nodeId = $script:graphRootNodeId } | ConvertTo-Json
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/repositories/$script:repositoryId/graph/ask" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $script:token" } -Body $body -TimeoutSec $SseTimeoutSeconds
    if ($response.Headers["Content-Type"] -notmatch "text/event-stream") { throw "Expected an SSE stream, got Content-Type: $($response.Headers['Content-Type'])" }

    $events = @(ConvertFrom-SseChunk -RawText $response.Content)
    $accumulated = Get-SseAccumulatedText -Events $events

    # Zero parseable events, or the stream never reaching a real
    # terminal state at all, is a genuine infrastructure failure - the
    # SSE mechanics themselves are broken, not just an upstream LLM
    # call. This still fails hard.
    if ($events.Count -eq 0) { throw "Stream produced zero parseable events - check server logs" }
    if (-not $accumulated.ReachedDone -and -not $accumulated.ErrorMessage) {
        throw "AI stream failed after receiving $($accumulated.Text.Length) characters. Reason: stream never reached a 'done' OR a real 'error' event before the connection closed."
    }

    # A real, well-formed 'error' event is different: it proves the
    # endpoint, routing, auth, and SSE mechanics all genuinely work -
    # the stream opened correctly and the backend's own error handling
    # reported the failure cleanly, exactly as designed. Only the
    # underlying LLM call itself failed, which can be a real but
    # external, transient cause (e.g. a third-party provider's rate
    # limit - confirmed live during this project's own development,
    # not hypothetical). Treated as a warning, not a hard failure -
    # this is genuinely different from the AI pipeline being broken.
    if ($accumulated.ErrorMessage) {
        Write-Host "WARNING: the AI stream opened and behaved correctly, but the underlying answer failed: $($accumulated.ErrorMessage)" -ForegroundColor Yellow
        Write-Host "This does not fail the smoke test - it confirms the SSE mechanics and error handling both work correctly. If this keeps happening, check whether the LLM provider account has a real, ongoing issue (e.g. a rate limit or billing problem)." -ForegroundColor Yellow
        return
    }

    if ($accumulated.Text.Length -eq 0) { throw "Stream reached 'done' but produced no token content at all" }
}

Test-Step "Authorization: a second user cannot access this repository (anti-enumeration)" {
    # Verified directly during the Milestone 3 retrospective:
    # getOwnedRepositoryOrThrow never distinguishes "doesn't exist" from
    # "exists but isn't yours" - both return an identical 404. This
    # asserts that REAL, intentional behavior, not a guessed status
    # code (e.g. 403), since a 403 would itself leak that the resource
    # exists.
    $otherEmail = "smoke-test-other-$(Get-Random)@example.com"
    $otherBody = @{ email = $otherEmail; password = "Password123" } | ConvertTo-Json
    $otherResponse = Invoke-RestMethod -Uri "$BaseUrl/api/auth/register" -Method Post -ContentType "application/json" -Body $otherBody -TimeoutSec $HttpTimeoutSeconds
    $otherToken = $otherResponse.accessToken

    $rejected = $false
    try {
        Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId" -Headers @{ Authorization = "Bearer $otherToken" } -TimeoutSec $HttpTimeoutSeconds
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) { $rejected = $true }
    }
    if (-not $rejected) { throw "Expected HTTP 404 (real anti-enumeration behavior) when a different user requests this repository" }
}

} finally {
    if ($script:repositoryId -and $script:token) {
        Test-Step "Cleanup: delete the smoke-test repository" {
            Invoke-RestMethod -Uri "$BaseUrl/api/repositories/$script:repositoryId" -Method Delete -Headers @{ Authorization = "Bearer $script:token" } -TimeoutSec $HttpTimeoutSeconds
        }
    } else {
        Write-Host "`n--- Cleanup ---" -ForegroundColor Cyan
        Write-Host "SKIPPED: no repository was successfully created, nothing to clean up." -ForegroundColor Yellow
    }
    # The disposable smoke-test accounts (both the primary and the
    # second user created for the authorization check) are intentionally
    # NOT deleted: the real API has no user-deletion endpoint at all
    # (verified directly - only repository deletion exists), so
    # inventing a destructive workaround around a real, honest API gap
    # is exactly what section 13 explicitly warns against. Documented
    # here and in README.md as a real, known limitation instead.
}

Write-Host "`n===================================" -ForegroundColor Cyan
$failureList = @($script:failures)
if ($failureList.Count -eq 0) {
    Write-Host "ALL SMOKE TESTS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($failureList.Count) SMOKE TEST(S) FAILED:" -ForegroundColor Red
    $failureList | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
