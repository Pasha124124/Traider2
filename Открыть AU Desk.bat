@echo off
setlocal
set "URL=http://127.0.0.1:4174"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required to start AU Desk.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

rem Always start this checkout on its own port so an older process cannot serve stale code.
rem --use-system-ca lets Node trust the Russian Trusted Root CA (used by T-Bank API certificates).
start "AU Desk server - close this window to stop" /min cmd /c "cd /d ""%~dp0"" && set PORT=4174 && node --use-system-ca server.js"

for /L %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto open_site
  timeout /t 1 /nobreak >nul
)

echo AU Desk did not start on port 4174. Check that the port is available.
pause
exit /b 1

:open_site
start "" "%URL%/"
exit /b 0
