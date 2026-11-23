@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  py -3 start.py
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python start.py
  goto done
)
echo Python 3.9 yoki yangiroq versiyasini o'rnating: https://www.python.org/downloads/
:done
if errorlevel 1 echo Dastur ishga tushmadi. Python 3.9 yoki yangiroq versiya kerak.
pause

