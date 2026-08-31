$ErrorActionPreference = "Stop"
Write-Host "Dymov Survey - first Git upload (fixed)"
Write-Host "========================================"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git is not installed. Install Git for Windows first: https://git-scm.com/download/win" -ForegroundColor Yellow
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed. Install Node.js LTS first: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

Write-Host "[1/5] Validating survey..."
& node .\scripts\validate.mjs
if ($LASTEXITCODE -ne 0) { throw "Survey validation failed. Nothing was uploaded." }

Write-Host "[2/5] Checking Git identity..."
$gitName = (& git config user.name 2>$null)
$gitEmail = (& git config user.email 2>$null)
if ([string]::IsNullOrWhiteSpace($gitName)) {
    $gitName = Read-Host "Enter your name for Git commits (for example: Darya Vasileva)"
    if ([string]::IsNullOrWhiteSpace($gitName)) { throw "Git user name is required." }
    & git config user.name $gitName
}
if ([string]::IsNullOrWhiteSpace($gitEmail)) {
    $gitEmail = Read-Host "Enter your email for Git commits"
    if ([string]::IsNullOrWhiteSpace($gitEmail)) { throw "Git email is required." }
    & git config user.email $gitEmail
}
Write-Host "Git identity: $gitName <$gitEmail>"

$existingRemote = ""
try {
    $existingRemote = (& git remote get-url origin 2>$null)
} catch {
    $existingRemote = ""
}

if ([string]::IsNullOrWhiteSpace($existingRemote)) {
    $remote = Read-Host "Paste the empty private Git repository URL (https://...)"
    if ([string]::IsNullOrWhiteSpace($remote)) { throw "Repository URL is required." }
} else {
    Write-Host "Existing remote: $existingRemote"
    $useExisting = Read-Host "Use this repository? (Y/n)"
    if ([string]::IsNullOrWhiteSpace($useExisting) -or $useExisting -match '^[Yy]$') {
        $remote = $existingRemote
    } else {
        $remote = Read-Host "Paste the empty private Git repository URL (https://...)"
        if ([string]::IsNullOrWhiteSpace($remote)) { throw "Repository URL is required." }
    }
}

Write-Host "[3/5] Preparing Git repository..."
if (-not (Test-Path ".git")) {
    & git init
    if ($LASTEXITCODE -ne 0) { throw "git init failed." }
}
& git branch -M main
if ($LASTEXITCODE -ne 0) { throw "Could not set main branch." }
& git add .
if ($LASTEXITCODE -ne 0) { throw "git add failed." }

# Avoid PowerShell treating normal stderr from an empty repository as a fatal error.
$hasHead = $false
$headCheck = Start-Process -FilePath "git" -ArgumentList @("rev-parse", "--verify", "HEAD") -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\dymov_git_head_out.txt" -RedirectStandardError "$env:TEMP\dymov_git_head_err.txt"
if ($headCheck.ExitCode -eq 0) { $hasHead = $true }

if (-not $hasHead) {
    Write-Host "Creating first commit..."
    & git commit -m "Initial Dymov survey Timeweb version"
    if ($LASTEXITCODE -ne 0) { throw "Initial git commit failed." }
} else {
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host "No new files to commit."
    } else {
        & git commit -m "Update Dymov survey Timeweb version"
        if ($LASTEXITCODE -ne 0) { throw "Git commit failed." }
    }
}

Write-Host "[4/5] Configuring GitHub repository..."
$originExists = $false
$originCheck = Start-Process -FilePath "git" -ArgumentList @("remote", "get-url", "origin") -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\dymov_git_origin_out.txt" -RedirectStandardError "$env:TEMP\dymov_git_origin_err.txt"
if ($originCheck.ExitCode -eq 0) { $originExists = $true }
if ($originExists) {
    & git remote set-url origin $remote
} else {
    & git remote add origin $remote
}
if ($LASTEXITCODE -ne 0) { throw "Could not configure Git remote." }

Write-Host "[5/5] Uploading to GitHub..."
Write-Host "If GitHub asks you to sign in, complete the browser sign-in and return to this window." -ForegroundColor Cyan
& git push -u origin main
if ($LASTEXITCODE -ne 0) { throw "Git push failed. Send me the text shown above this line." }

Write-Host ""
Write-Host "SUCCESS. Project uploaded to GitHub." -ForegroundColor Green
Write-Host "Repository: $remote"
Write-Host "Next: Timeweb Cloud -> App Platform -> Create app -> Dockerfile -> connect this repository." -ForegroundColor Green
Read-Host "Press Enter to close"
