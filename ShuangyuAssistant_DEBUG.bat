@echo off
setlocal
set "PROJ=D:\Damn\shuangyu-assistant"
set "EXE=%PROJ%\node_modules\electron\dist\electron.exe"
set "LOG=%APPDATA%\shuangyu-assistant\main.log"

echo ============================================
echo   ShuangyuAssistant - DEBUG launcher
echo ============================================
echo Project : %PROJ%
echo Electron: %EXE%
echo.

if not exist "%EXE%" (
  echo [ERROR] electron.exe not found. Please run: npm install
  pause
  exit /b 1
)

echo [1/4] Cleaning any leftover electron processes...
taskkill /F /IM electron.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo [2/4] Cleaning cache + log...
if exist "%LOG%" del /q "%LOG%" >nul 2>&1

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
cd /d "%PROJ%"

echo [3/4] Launching...
start "" /D "%PROJ%" "%EXE%" "%PROJ%"

echo [4/4] Waiting 8 seconds...
ping -n 9 127.0.0.1 >nul

echo.
echo ---------- startup log ----------
if exist "%LOG%" (type "%LOG%") else (echo [WARN] no log file written)
echo ----------------------------------
echo.
tasklist /FI "IMAGENAME eq electron.exe" | findstr /I electron.exe >nul
if errorlevel 1 (echo [FAIL] electron.exe is NOT running) else (echo [OK] electron.exe IS running)
echo.
echo Path to full log:
echo %LOG%
echo.
echo Press any key to close this window.
pause >nul
exit /b 0
