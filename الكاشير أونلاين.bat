@echo off
rem Al-Arabi online cashier: opens the Render site with direct printing to the default printer
start "" msedge --app=https://al-arabi-79b5.onrender.com/cashier --kiosk-printing --start-maximized --no-first-run --user-data-dir="%~dp0data\edge-online"
