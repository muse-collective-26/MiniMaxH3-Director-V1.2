@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0..\..\..\..\python_embeded\python.exe" (
    "%~dp0..\..\..\..\python_embeded\python.exe" "%~dp0install.py" %*
    goto finished
)
if exist "%~dp0..\..\..\.venv\Scripts\python.exe" (
    "%~dp0..\..\..\.venv\Scripts\python.exe" "%~dp0install.py" %*
    goto finished
)
if exist "%~dp0..\..\..\venv\Scripts\python.exe" (
    "%~dp0..\..\..\venv\Scripts\python.exe" "%~dp0install.py" %*
    goto finished
)
where python >nul 2>&1
if not errorlevel 1 (
    python "%~dp0install.py" %*
    goto finished
)
echo Python not found. See README.md for the explicit Python command.
exit /b 1
:finished
set "MUSE_INSTALL_RESULT=%ERRORLEVEL%"
pause
exit /b %MUSE_INSTALL_RESULT%
