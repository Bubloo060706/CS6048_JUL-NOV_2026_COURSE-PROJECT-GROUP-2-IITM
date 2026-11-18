$ErrorActionPreference = "Stop"

Write-Host "`n=== WebRTC Project Verification ===" -ForegroundColor Cyan

if (-not (Test-Path ".\package.json")) {
    throw "Run this script from the WebRTC project root."
}

Write-Host "`n[1/4] Checking browser JavaScript syntax..."
node --check .\public\adaptation-controller.js
if ($LASTEXITCODE -ne 0) { throw "Adaptation controller syntax check failed." }
node --check .\public\app.js
if ($LASTEXITCODE -ne 0) { throw "Browser app syntax check failed." }
node --check .\server.js
if ($LASTEXITCODE -ne 0) { throw "Server syntax check failed." }
Write-Host "PASS" -ForegroundColor Green

Write-Host "`n[2/4] Running controller unit tests..."
npm test
if ($LASTEXITCODE -ne 0) { throw "Controller unit tests failed." }
Write-Host "PASS" -ForegroundColor Green

Write-Host "`n[3/4] Checking Python analysis syntax..."
python -m py_compile .\analysis\analyze.py
if ($LASTEXITCODE -ne 0) { throw "Python analysis syntax check failed." }
Write-Host "PASS" -ForegroundColor Green

Write-Host "`n[4/4] Checking Git whitespace (if Git is initialized)..."
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -eq 0) {
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw "Git diff check failed." }
    git status --short
    Write-Host "PASS" -ForegroundColor Green
} else {
    Write-Host "SKIP: Git repository not initialized." -ForegroundColor Yellow
}

Write-Host "`nVerification complete." -ForegroundColor Green
