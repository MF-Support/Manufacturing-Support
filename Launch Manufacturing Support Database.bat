@echo off
setlocal

set "APP_DIR=%~dp0"
set "SOURCE_DIR=%APP_DIR%Omnify_All_Parts_Cleaned"
set "SHARED_DB=%APP_DIR%omnify_search.sqlite"
set "LOCAL_DIR=%LOCALAPPDATA%\ManufacturingSupportDatabase"
set "LOCAL_DB=%LOCAL_DIR%\omnify_search.sqlite"

if not exist "%LOCAL_DIR%" mkdir "%LOCAL_DIR%"

if exist "%SHARED_DB%" (
  copy /Y "%SHARED_DB%" "%LOCAL_DB%" >nul
)

if defined MSD_SOURCE_DIR set "SOURCE_DIR=%MSD_SOURCE_DIR%"

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%APP_DIR%omnify_search_app.py" --source "%SOURCE_DIR%" --db "%LOCAL_DB%" --host 127.0.0.1 --port 8765 --open-browser
  goto :done
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%APP_DIR%omnify_search_app.py" --source "%SOURCE_DIR%" --db "%LOCAL_DB%" --host 127.0.0.1 --port 8765 --open-browser
  goto :done
)

echo Python was not found on this computer.
echo Install Python 3, or package this app as an EXE before sharing it.
pause

:done
endlocal
