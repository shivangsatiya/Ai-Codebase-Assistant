
# Pester tests for smoke-test-lib.psm1.
#
# IMPORTANT, HONEST LIMITATION: PowerShell/Pester is not available in
# the sandbox this file was authored in (not present via apt, and
# Microsoft's package sources aren't in the allowed network domains).
# These tests were written with the same care as any other test in
# this project, mirroring patterns already confirmed working in the
# original smoke-test.ps1, but they have NOT been executed here. Per
# the task's own explicit instruction not to fabricate verification,
# this is stated plainly rather than silently assumed passing. Running
# Invoke-Pester against this file in a real PowerShell environment is
# a required, outstanding step before this can honestly be called
# verified.

BeforeAll {
    Import-Module "$PSScriptRoot/smoke-test-lib.psm1" -Force
}

Describe "ConvertFrom-SseChunk" {
    It "parses a real token event correctly" {
        $result = @(ConvertFrom-SseChunk -RawText "data: {`"token`":`"Hello`"}`n`n")
        $result.Count | Should -Be 1
        $result[0].Type | Should -Be "token"
        $result[0].Text | Should -Be "Hello"
    }

    It "parses multiple token events plus a done event, in order" {
        $raw = "data: {`"token`":`"Hello`"}`n`ndata: {`"token`":`" world`"}`n`nevent: done`ndata: {}`n`n"
        $result = @(ConvertFrom-SseChunk -RawText $raw)
        $result.Count | Should -Be 3
        $result[0].Type | Should -Be "token"
        $result[1].Type | Should -Be "token"
        $result[2].Type | Should -Be "done"
    }

    It "parses a real error event with its message" {
        $raw = "event: error`ndata: {`"message`":`"The response was interrupted. Please try again.`"}`n`n"
        $result = @(ConvertFrom-SseChunk -RawText $raw)
        $result.Count | Should -Be 1
        $result[0].Type | Should -Be "error"
        $result[0].Message | Should -Be "The response was interrupted. Please try again."
    }

    It "skips a malformed event (invalid JSON) without throwing, and still returns subsequent valid events - matching the real backend parser's own tolerance" {
        $raw = "data: not-valid-json`n`ndata: {`"token`":`"still works`"}`n`n"
        $result = @(ConvertFrom-SseChunk -RawText $raw)
        $result.Count | Should -Be 1
        $result[0].Type | Should -Be "token"
        $result[0].Text | Should -Be "still works"
    }

    It "returns an empty array for an empty input, rather than throwing" {
        $result = @(ConvertFrom-SseChunk -RawText "")
        $result.Count | Should -Be 0
    }
}

Describe "Get-SseAccumulatedText" {
    It "concatenates real token events into the final answer text, in order" {
        $events = @(
            [PSCustomObject]@{ Type = "token"; Text = "Because " },
            [PSCustomObject]@{ Type = "token"; Text = "of X." },
            [PSCustomObject]@{ Type = "done" }
        )
        $result = Get-SseAccumulatedText -Events $events
        $result.Text | Should -Be "Because of X."
        $result.ReachedDone | Should -Be $true
        $result.ErrorMessage | Should -Be $null
    }

    It "correctly reports a stream that never reached done - a real interruption, not a false positive" {
        $events = @([PSCustomObject]@{ Type = "token"; Text = "partial" })
        $result = Get-SseAccumulatedText -Events $events
        $result.Text | Should -Be "partial"
        $result.ReachedDone | Should -Be $false
    }

    It "surfaces the real error message distinctly, while still preserving whatever partial text arrived" {
        $events = @(
            [PSCustomObject]@{ Type = "token"; Text = "partial answer" },
            [PSCustomObject]@{ Type = "error"; Message = "Interrupted." }
        )
        $result = Get-SseAccumulatedText -Events $events
        $result.Text | Should -Be "partial answer"
        $result.ErrorMessage | Should -Be "Interrupted."
    }
}

Describe "Wait-ForCondition" {
    It "returns Succeeded when the check reaches a real success state, without waiting the full timeout" {
        $script:callCount = 0
        $check = { $script:callCount++; return $script:callCount }
        $result = Wait-ForCondition -Check $check -IsSuccess { param($s) $s -ge 3 } -IsFailure { param($s) $false } `
            -TimeoutSeconds 100 -IntervalSeconds 1 -Sleep { param($seconds) }
        $result.Succeeded | Should -Be $true
        $result.TimedOut | Should -Be $false
    }

    It "returns a terminal failure (not a timeout) the moment a real failure state is reached" {
        $check = { return "failed" }
        $result = Wait-ForCondition -Check $check -IsSuccess { param($s) $s -eq "ready" } -IsFailure { param($s) $s -eq "failed" } `
            -TimeoutSeconds 100 -IntervalSeconds 1 -Sleep { param($seconds) }
        $result.Succeeded | Should -Be $false
        $result.TimedOut | Should -Be $false
    }

    It "never hangs indefinitely - reports TimedOut when neither success nor failure is ever reached, using an injected instant Sleep so this test itself runs quickly, not in real wall-clock seconds" {
        $check = { return "still-processing" }
        $result = Wait-ForCondition -Check $check -IsSuccess { param($s) $s -eq "ready" } -IsFailure { param($s) $s -eq "failed" } `
            -TimeoutSeconds 10 -IntervalSeconds 5 -Sleep { param($seconds) }
        $result.Succeeded | Should -Be $false
        $result.TimedOut | Should -Be $true
    }
}

Describe "Format-SafeErrorMessage" {
    It "redacts a real bearer token from an Authorization header, never printing the actual secret value" {
        $raw = "Request failed. Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123"
        $result = Format-SafeErrorMessage -Operation "Test call" -RawMessage $raw
        $result | Should -Not -Match "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        $result | Should -Match "\[REDACTED\]"
    }

    It "redacts a real accessToken field from a JSON response body" {
        $raw = '{"accessToken":"secret-token-value-here","userId":"123"}'
        $result = Format-SafeErrorMessage -Operation "Test call" -RawMessage $raw
        $result | Should -Not -Match "secret-token-value-here"
        $result | Should -Match "userId"
    }

    It "preserves genuinely useful, non-secret diagnostic information unchanged" {
        $raw = "HTTP 500 Internal Server Error"
        $result = Format-SafeErrorMessage -Operation "Graph retrieval" -RawMessage $raw
        $result | Should -Match "Graph retrieval"
        $result | Should -Match "HTTP 500"
    }
}
