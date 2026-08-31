$ErrorActionPreference = "Stop"
Write-Host "Dymov Survey - first Git upload"
Write-Host "================================"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git is not installed. Install Git for Windows first: https://git-scm.com/download/win" -ForegroundColor Yellow
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed. Install Node.js LTS first: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

Write-Host "[1/4] Validating survey..."
node .\scripts\validate.mjs
if ($LASTEXITCODE -ne 0) { throw "Survey validation failed. Nothing was uploaded." }

$remote = Read-Host "Paste the empty private Git repository URL (https://...)"
if ([string]::IsNullOrWhiteSpace($remote)) { throw "Repository URL is required." }

Write-Host "[2/4] Initializing Git..."
if (-not (Test-Path ".git")) { git init }
git branch -M main
git add .
$hasCommit = git rev-parse --verify HEAD 2>$null
if ($LASTEXITCODE -ne 0) { git commit -m "Initial Dymov survey Timeweb version" }
else { git commit -m "Prepare Dymov survey for Timeweb" 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host "No new files to commit." } }

Write-Host "[3/4] Configuring remote..."
$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) { git remote set-url origin $remote } else { git remote add origin $remote }

Write-Host "[4/4] Uploading..."
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw "Git push failed." }

Write-Host ""
Write-Host "DONE. Now connect this repository in Timeweb Cloud -> App Platform -> Dockerfile." -ForegroundColor Green
Read-Host "Press Enter to close"
