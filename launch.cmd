@echo off
setlocal

rem Node/npm are installed under fnm on this machine.
set "PATH=C:\Users\arrec\AppData\Roaming\fnm\node-versions\v22.23.5\installation;%PATH%"
rem This PC defaults NODE_ENV to production; the dev server needs development.
set "NODE_ENV=development"
cd /d "C:\Users\arrec\OneDrive\Documents\AI\Mock-examizerF"

rem AI is configured via .env.local (OpenAI-compatible endpoint).
rem This launcher no longer starts Unsloth Desktop.

rem If port 3000 is already listening, only open the browser.
netstat -ano | findstr /C:":3000 " | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  start "Mock examizerF server" cmd /c "npm run dev -- -p 3000"
  ping -n 6 127.0.0.1 >nul
)

start "" "http://localhost:3000"
endlocal
