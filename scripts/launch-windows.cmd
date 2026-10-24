@echo off
setlocal
cd /d "%~dp0.."
set "EASI_NODE=node"
if exist "%CD%\runtime\node.exe" set "EASI_NODE=%CD%\runtime\node.exe"
"%EASI_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) === 24 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo EASI Store requires Node.js 24. Install it from https://nodejs.org/ or use a portable package with its runtime included.
  pause
  exit /b 1
)
if not exist node_modules goto prepare
if not exist dist\public\index.html goto prepare
goto ready
:prepare
echo Preparing EASI Store. Internet access is needed for the first source launch.
call npm ci --no-audit --no-fund
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
:ready
if not defined EASI_STORE_DATA_DIR set "EASI_STORE_DATA_DIR=%LOCALAPPDATA%\EASI Store"
if not defined EASI_STORE_PORT set "EASI_STORE_PORT=8048"
echo Archive: %EASI_STORE_DATA_DIR%
echo Keep this window open. Control-C stops the service.
"%EASI_NODE%" src\cli.js start --data-dir "%EASI_STORE_DATA_DIR%" --host 127.0.0.1 --port "%EASI_STORE_PORT%" --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo EASI Store stopped because a command failed. The details are shown above.
pause
exit /b 1
