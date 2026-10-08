@echo off
setlocal
set "PROJ=D:\Damn\shuangyu-assistant"
set "EXE=%PROJ%\node_modules\electron\dist\electron.exe"
set "LOG=%APPDATA%\shuangyu-assistant\main.log"

if not exist "%EXE%" (
  echo [ERROR] electron.exe not found. Please run: npm install
  pause
  exit /b 1
)

rem Clear env vars that could make Electron run in pure Node mode.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

rem Remove stale logs so the DEBUG view is not confusing.
if exist "%LOG%" del /q "%LOG%" >nul 2>&1
cd /d "%PROJ%"

rem Pass ONLY the app directory. All GPU / sandbox switches are set inside
rem electron/main.js via app.commandLine.appendSwitch. If Chromium switches
rem are placed BEFORE the app path, electron.exe reports "bad option" and
rem exits immediately (the black-window flash).
start "" /D "%PROJ%" "%EXE%" "%PROJ%"

exit /b 0
