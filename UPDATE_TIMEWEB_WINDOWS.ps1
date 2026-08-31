$ErrorActionPreference = "Stop"
Write-Host "Dymov Survey - publish an update to Timeweb"
Write-Host "============================================"

if (-not (Test-Path ".git")) { throw "This folder is not connected to Git. Run FIRST_PUSH_TO_GIT_WINDOWS.ps1 first." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is not installed." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed." }

Write-Host "[1/3] Validating survey..."
node .\scripts\validate.mjs
if ($LASTEXITCODE -ne 0) { throw "Survey validation failed. Update blocked." }

$message = Read-Host "Short update description (or press Enter)"
if ([string]::IsNullOrWhiteSpace($message)) { $message = "Update Dymov survey" }

Write-Host "[2/3] Creating commit..."
git add .
git commit -m $message
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nothing changed. No deployment is needed." -ForegroundColor Yellow
    exit 0
}

Write-Host "[3/3] Pushing..."
git push
if ($LASTEXITCODE -ne 0) { throw "Git push failed." }

Write-Host ""
Write-Host "DONE. If Timeweb autodeploy is enabled, deployment will start automatically." -ForegroundColor Green
Read-Host "Press Enter to close"
