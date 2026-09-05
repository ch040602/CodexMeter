$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $projectDirectory 'installed\win-unpacked\Codex Meter.exe'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'Pack the app with npm run pack before registering startup.'
}

$taskName = 'CodexMeter'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$previousRun = (Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).$taskName
$backupFile = Join-Path $projectDirectory 'installed\startup-before.json'
if ($previousRun -and !(Test-Path -LiteralPath $backupFile)) {
    @{ RegistryPath = $runKey; Name = $taskName; Value = $previousRun } |
        ConvertTo-Json | Set-Content -LiteralPath $backupFile -Encoding UTF8
}

# Run in the signed-in desktop session so both the tray and windows are visible.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$trigger.Delay = 'PT20S'
$action = New-ScheduledTaskAction -Execute $executable -WorkingDirectory (Split-Path -Parent $executable)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -Priority 4 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Show Codex Meter 20 seconds after this user signs in; retry error exits.' -Force | Out-Null

# Remove only the legacy entry for this same executable, after registration succeeds.
if ($previousRun -and $previousRun.Trim('"') -eq $executable) {
    Remove-ItemProperty -LiteralPath $runKey -Name $taskName
}

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
