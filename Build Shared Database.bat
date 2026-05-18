@echo off
setlocal

set "APP_DIR=%~dp0"
set "SOURCE_DIR=%APP_DIR%Omnify_All_Parts_Cleaned"
set "DB_PATH=%APP_DIR%omnify_search.sqlite"

if not exist "%SOURCE_DIR%" (
  echo Source folder not found:
  echo %SOURCE_DIR%
  echo.
  echo Copy Omnify_All_Parts_Cleaned into this shared app folder first.
  pause
  exit /b 2
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%APP_DIR%omnify_search_app.py" --source "%SOURCE_DIR%" --db "%DB_PATH%" --rebuild --build-only
  pause
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%APP_DIR%omnify_search_app.py" --source "%SOURCE_DIR%" --db "%DB_PATH%" --rebuild --build-only
  pause
  exit /b %ERRORLEVEL%
)

echo Python was not found on this computer.
pause
exit /b 1
