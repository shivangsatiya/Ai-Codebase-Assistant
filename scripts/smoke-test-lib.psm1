
# Testable helper functions for the smoke test - deliberately separated
# from smoke-test.ps1 itself, since "add appropriate tests for the
# smoke-test helper logic" requires something with real, injectable
# inputs (no live HTTP calls, no real waiting) for Pester to exercise.
# smoke-test.ps1 dot-sources this file and uses these functions for its
# actual orchestration; the functions themselves know nothing about
# BaseUrl, tokens, or any specific endpoint.

function ConvertFrom-SseChunk {
    <#
    .SYNOPSIS
    Parses a raw SSE text block into an array of event objects.
    .DESCRIPTION
    Pure parsing - no I/O. Matches the real, verified backend contract
    (data: {"token":"..."}, event: done, event: error) exactly as
    confirmed in Milestone 3b's own frontend SSE parser. A malformed
    event (unparseable JSON, an unrecognized shape) is skipped, not
    thrown - matching the same real tolerance the frontend's own parser
    has, since a single bad event shouldn't be treated as a fatal
    stream failure when real tokens are still arriving.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$RawText
    )

    $events = @()
    $blocks = $RawText -split "`n`n"

    foreach ($block in $blocks) {
        if ([string]::IsNullOrWhiteSpace($block)) { continue }

        $lines = $block -split "`n"
        $eventLine = $lines | Where-Object { $_ -like "event: *" } | Select-Object -First 1
        $dataLine = $lines | Where-Object { $_ -like "data: *" } | Select-Object -First 1

        if (-not $dataLine) { continue }

        $eventType = if ($eventLine) { $eventLine.Substring(7).Trim() } else { "message" }
        $rawData = $dataLine.Substring(6)

        try {
            $data = $rawData | ConvertFrom-Json -ErrorAction Stop
        } catch {
            continue
        }

        if ($eventType -eq "done") {
            $events += [PSCustomObject]@{ Type = "done" }
        } elseif ($eventType -eq "error") {
            $message = if ($data.message) { $data.message } else { "The response was interrupted." }
            $events += [PSCustomObject]@{ Type = "error"; Message = $message }
        } elseif ($data.token -is [string]) {
            $events += [PSCustomObject]@{ Type = "token"; Text = $data.token }
        }
    }

    # Explicitly wrapped in @() - a real bug found from actually running
    # the tests, not assumed correct: PowerShell silently unwraps a
    # single-element array into a bare scalar when a function returns
    # it, and a bare scalar has no .Count property at all. This forces
    # array context regardless of whether $events ends up empty, one
    # item, or many.
    return @($events)
}

function Get-SseAccumulatedText {
    <#
    .SYNOPSIS
    Reduces a parsed event array down to the accumulated token text,
    plus whether the stream reached a real 'done' or 'error' state.
    #>
    param([Parameter(Mandatory = $true)][array]$Events)

    $text = ($Events | Where-Object { $_.Type -eq "token" } | ForEach-Object { $_.Text }) -join ""
    # @() wrapping is required here too, for the same reason as
    # ConvertFrom-SseChunk's return value - Where-Object matching
    # exactly one item unwraps to a bare scalar with no .Count
    # property, which a real test run proved (the "concatenates real
    # token events" test has exactly one 'done' event, and failed on
    # ReachedDone before this fix).
    $reachedDone = @($Events | Where-Object { $_.Type -eq "done" }).Count -gt 0
    $errorEvent = $Events | Where-Object { $_.Type -eq "error" } | Select-Object -First 1

    return [PSCustomObject]@{
        Text        = $text
        ReachedDone = $reachedDone
        ErrorMessage = if ($errorEvent) { $errorEvent.Message } else { $null }
    }
}

function Wait-ForCondition {
    <#
    .SYNOPSIS
    Generic, injectable polling helper - takes scriptblocks rather than
    a hardcoded endpoint, so Pester can test real timeout/terminal-state
    behavior using a fake, instantly-returning check instead of a real
    HTTP call and real waiting.
    .PARAMETER Check
    Scriptblock returning the current state (any object).
    .PARAMETER IsSuccess
    Scriptblock taking the current state, returning $true when polling should stop successfully.
    .PARAMETER IsFailure
    Scriptblock taking the current state, returning $true when polling should stop with a terminal failure.
    #>
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Check,
        [Parameter(Mandatory = $true)][scriptblock]$IsSuccess,
        [Parameter(Mandatory = $true)][scriptblock]$IsFailure,
        [int]$TimeoutSeconds = 180,
        [int]$IntervalSeconds = 5,
        [scriptblock]$Sleep = { param($seconds) Start-Sleep -Seconds $seconds }
    )

    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        $state = & $Check
        if (& $IsSuccess $state) {
            return [PSCustomObject]@{ Succeeded = $true; TimedOut = $false; FinalState = $state }
        }
        if (& $IsFailure $state) {
            return [PSCustomObject]@{ Succeeded = $false; TimedOut = $false; FinalState = $state }
        }
        & $Sleep $IntervalSeconds
        $elapsed += $IntervalSeconds
    }

    return [PSCustomObject]@{ Succeeded = $false; TimedOut = $true; FinalState = $null }
}

function Format-SafeErrorMessage {
    <#
    .SYNOPSIS
    Formats a diagnostic error message, stripping anything that looks
    like an Authorization header or bearer token before it's ever
    written to console output - "never print secret values" applied
    structurally, not left to every call site to remember individually.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$RawMessage
    )

    $redacted = $RawMessage -replace '(?i)(Authorization:\s*Bearer\s+)[^\s"]+', '$1[REDACTED]'
    $redacted = $redacted -replace '(?i)("accessToken"\s*:\s*")[^"]+(")', '$1[REDACTED]$2'
    $redacted = $redacted -replace '(?i)("refreshToken"\s*:\s*")[^"]+(")', '$1[REDACTED]$2'

    return "[FAIL] $Operation`n$redacted"
}

Export-ModuleMember -Function ConvertFrom-SseChunk, Get-SseAccumulatedText, Wait-ForCondition, Format-SafeErrorMessage -ErrorAction SilentlyContinue
