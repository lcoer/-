@echo off
setlocal
for %%I in ("%~dp0.") do set "PROJ=%%~fI"
set "EXE=%PROJ%\node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo [ERROR] electron.exe not found. Please run: npm ci
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
start "" /D "%PROJ%" "%EXE%" "%PROJ%"
exit /b 0
