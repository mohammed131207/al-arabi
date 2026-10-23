@echo off
rem Al-Arabi restaurant: start the server (if not running) and open the cashier screen
cd /d "%~dp0"
where node >/dev/null 2>/dev/null || (echo Node.js is not installed. Download it from https://nodejs.org then run this file again. & pause & exit /b 1)
if not exist node_modules (echo Installing libraries, first time only... & call npm install --omit=dev)
if not exist data mkdir data
curl -sf -o nul http://localhost:3030/api/public/menu && goto open
start "Al-Arabi server - do not close" /min node server\index.js
set tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
curl -sf -o nul http://localhost:3030/api/public/menu && goto open
if %tries% lss 20 goto wait
echo The server did not start. Open the "Al-Arabi server" window to see the error.
pause
exit /b 1
:open
rem --kiosk-printing prints straight to the default printer without the print dialog
start "" msedge --app=http://localhost:3030/cashier --kiosk-printing --start-maximized --no-first-run --user-data-dir="%~dp0data\edge"
