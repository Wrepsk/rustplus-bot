param(
    [switch]$SmokeTest,
    [string]$Code = '',
    [string]$ConfigFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$node = Join-Path $PSScriptRoot 'node.exe'
$helper = Join-Path $PSScriptRoot 'pairing\helper.js'
if (!(Test-Path -LiteralPath $node) -or !(Test-Path -LiteralPath $helper)) {
    throw 'Extract all files from the pairing ZIP before starting the helper.'
}
$dataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RustPlusDiscordPairing'
if (!$ConfigFile) {
    [IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
    $ConfigFile = Join-Path $dataDirectory 'rustplus.config.json'
} elseif (!$SmokeTest) {
    throw 'A custom registration path is only supported by the automated smoke test.'
}
$script:worker = $null
$script:result = ''
$script:failure = ''

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Link Rust+ to Discord'
$form.ClientSize = New-Object System.Drawing.Size(620, 515)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(245, 246, 248)

function Add-Label([string]$Text, [int]$Y, [int]$Height) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object Drawing.Point(22, $Y)
    $label.Size = New-Object Drawing.Size(576, $Height)
    $form.Controls.Add($label)
    return $label
}
$null = Add-Label '1. Run /pair start in Discord and paste the code below.' 20 28
$codeBox = New-Object System.Windows.Forms.TextBox
$codeBox.Location = New-Object Drawing.Point(22, 52)
$codeBox.Size = New-Object Drawing.Size(576, 28)
$codeBox.MaxLength = 200
$codeBox.Text = $Code
$form.Controls.Add($codeBox)

$again = New-Object System.Windows.Forms.CheckBox
$again.Text = 'Sign in again / use a different Steam account'
$again.Location = New-Object Drawing.Point(22, 88)
$again.Size = New-Object Drawing.Size(560, 28)
$form.Controls.Add($again)

$link = New-Object System.Windows.Forms.Button
$link.Text = 'Link account'
$link.Location = New-Object Drawing.Point(22, 124)
$link.Size = New-Object Drawing.Size(172, 38)
$form.Controls.Add($link)
$reset = New-Object System.Windows.Forms.Button
$reset.Text = 'Reset local registration'
$reset.Location = New-Object Drawing.Point(208, 124)
$reset.Size = New-Object Drawing.Size(230, 38)
$form.Controls.Add($reset)

$status = Add-Label '2. Click Link account. Sign in through Steam in the Chrome window. Google Chrome must be installed.' 176 62
$null = Add-Label '3. Copy the encrypted command below and send it in Discord.' 246 28
$output = New-Object System.Windows.Forms.TextBox
$output.Location = New-Object Drawing.Point(22, 278)
$output.Size = New-Object Drawing.Size(576, 96)
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$form.Controls.Add($output)
$copy = New-Object System.Windows.Forms.Button
$copy.Text = 'Copy Discord command'
$copy.Location = New-Object Drawing.Point(22, 388)
$copy.Size = New-Object Drawing.Size(230, 38)
$copy.Enabled = $false
$form.Controls.Add($copy)
$null = Add-Label 'When /pair status says listening, close this helper. Pair the server/devices in Rust, then use /pair inbox. Never share a password or raw registration file.' 441 60

function Stop-Pairing {
    if ($script:worker) {
        try {
            if (!$script:worker.HasExited) {
                # Windows does not propagate termination to children. Kill only
                # this helper's process tree, including the registration CLI.
                & "$env:SystemRoot\System32\taskkill.exe" /PID $script:worker.Id /T /F 2>&1 | Out-Null
            }
        } catch {
            # Start may have failed, or the process exited during cancellation.
        } finally {
            $script:worker.Dispose()
            $script:worker = $null
        }
    }
}

function Start-Pairing {
    if ($script:worker) { return }
    $value = $codeBox.Text.Trim()
    if ($value -cnotmatch '^[a-f0-9]{32}\.[A-Za-z0-9_-]{50,100}$') {
        $status.Text = 'Paste only the code from /pair start, then try again.'
        return
    }
    $output.Clear()
    $script:result = ''
    $script:failure = ''
    $copy.Enabled = $false
    $link.Enabled = $false
    $reset.Enabled = $false
    $again.Enabled = $false
    $codeBox.Enabled = $false
    $status.Text = 'Linking... Sign in on Steam in Chrome. This can take a few minutes. Close this helper to cancel.'
    try {
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $node
        # Paths end in filenames (never a trailing slash), and Windows filenames
        # cannot contain quotes. The public code has a strict allowlist above.
        $info.Arguments = '"' + $helper + '" --code ' + $value + ' --config "' + $ConfigFile + '" --minimal-config'
        if ($again.Checked) { $info.Arguments += ' --register' }
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.Encoding]::UTF8
        $info.StandardErrorEncoding = [Text.Encoding]::UTF8
        $script:worker = New-Object Diagnostics.Process
        $script:worker.StartInfo = $info
        $null = $script:worker.Start()
        # Drain both pipes asynchronously. Never display arbitrary child output:
        # accept only the encrypted command produced by our wrapper.
        $script:stdout = $script:worker.StandardOutput.ReadToEndAsync()
        $script:stderr = $script:worker.StandardError.ReadToEndAsync()
        $script:deadline = [DateTime]::UtcNow.AddMinutes(12)
    } catch {
        Stop-Pairing
        if ($SmokeTest) { throw }
        $status.Text = 'Could not start the helper. Extract all files and try again.'
        $link.Enabled = $true
        $reset.Enabled = $true
        $again.Enabled = $true
        $codeBox.Enabled = $true
    }
}

function Check-Pairing {
    if (!$script:worker) { return }
    if ([DateTime]::UtcNow -gt $script:deadline) {
        $script:failure = 'Sign-in timed out. Run /pair start again for a fresh code and retry.'
        Stop-Pairing
    } elseif (!$script:worker.HasExited -or !$script:stdout.IsCompleted -or !$script:stderr.IsCompleted) {
        return
    } else {
        $exitCode = $script:worker.ExitCode
        $text = $script:stdout.GetAwaiter().GetResult()
        $null = $script:stderr.GetAwaiter().GetResult()
        # Use case-sensitive regex matching: Windows PowerShell's default
        # culture-sensitive -match can reject ASCII base64 on Turkish PCs.
        $command = [regex]::Match($text, '(?m)^/pair import data:([a-f0-9]{32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\r?$')
        if ($exitCode -eq 0 -and $command.Success) {
            $script:result = '/pair import data:' + $command.Groups[1].Value
        } else {
            $script:failure = 'Linking failed. Check Chrome, internet access and popup permissions. Get a new code from /pair start. Try Sign in again if needed.'
            if ($SmokeTest) {
                [Console]::Error.WriteLine('Synthetic helper exit: ' + $exitCode + '; stdout length: ' + $text.Length)
            }
        }
        Stop-Pairing
    }
    $link.Enabled = $true
    $reset.Enabled = $true
    $again.Enabled = $true
    $codeBox.Enabled = $true
    if ($script:result) {
        $output.Text = $script:result
        $copy.Enabled = $true
        $status.Text = 'Ready! Click Copy Discord command, paste it into Discord, and send. Then check /pair status.'
    } else {
        $status.Text = $script:failure
    }
}

$link.Add_Click({ Start-Pairing })
$copy.Add_Click({
    try {
        [Windows.Forms.Clipboard]::SetText($script:result)
        $status.Text = 'Copied! Paste the command into Discord and send it before your code expires.'
    } catch {
        $output.SelectAll()
        $output.Focus()
        $status.Text = 'Clipboard is busy. Select the command and press Ctrl+C, then paste into Discord.'
    }
})
$reset.Add_Click({
    if ([Windows.Forms.MessageBox]::Show('Remove the saved local registration? You will need to sign in again. This does not unlink Discord.', 'Reset registration', 'YesNo', 'Question') -eq 'Yes') {
        try {
            if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile }
            $again.Checked = $true
            $output.Clear()
            $script:result = ''
            $copy.Enabled = $false
            $status.Text = 'Local registration removed. Get a fresh /pair start code and link again.'
        } catch {
            $status.Text = 'Could not remove the registration file. Close other helpers and retry.'
        }
    }
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({ Check-Pairing })
$form.Add_FormClosing({ Stop-Pairing })
try {
    if ($SmokeTest) {
        # Exercise the real compiled helper/runtime and UI state without opening
        # a window, launching Chrome, contacting Steam or changing the clipboard.
        if (!(Test-Path -LiteralPath $ConfigFile)) { throw 'Synthetic registration required.' }
        Start-Pairing
        $limit = [DateTime]::UtcNow.AddSeconds(20)
        while ($script:worker -and [DateTime]::UtcNow -lt $limit) {
            Start-Sleep -Milliseconds 50
            Check-Pairing
        }
        if (!$script:result -or !$copy.Enabled) { throw ('Desktop pairing smoke test failed: ' + $status.Text) }
        Write-Output $script:result
    } else {
        $timer.Start()
        $null = $form.ShowDialog()
    }
} finally {
    $timer.Stop()
    Stop-Pairing
    $timer.Dispose()
    $form.Dispose()
}
