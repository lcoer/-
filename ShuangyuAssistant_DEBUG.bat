@echo off
setlocal
for %%I in ("%~dp0.") do set "PROJ=%%~fI"
set "EXE=%PROJ%\node_modules\electron\dist\electron.exe"
echo ShuangyuAssistant DEBUG launcher
echo Project: %PROJ%
if not exist "%EXE%" (
  echo [ERROR] electron.exe not found. Please run: npm ci
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
cd /d "%PROJ%"
rem Never kill unrelated Electron applications or delete user logs.
"%EXE%" "%PROJ%"
echo Application exit code: %ERRORLEVEL%
pause
