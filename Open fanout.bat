@echo off
rem Starts fanout from this folder. Installs what it needs the first time.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo fanout needs Node.js 22 or newer. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Setting up fanout for the first time...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Setup failed. Check the internet connection and run this again.
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" .
