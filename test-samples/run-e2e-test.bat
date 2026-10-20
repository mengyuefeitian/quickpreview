@echo off
cd /d "%~dp0"
set PY=C:\Users\anweining01\.workbuddy\binaries\python\versions\3.13.12\python.exe
if not exist "%PY%" set PY=python

echo ============================================
echo  QuickPreview end-to-end test
echo  (Explorer select file - press SPACE - preview)
echo  NOTE: screen must be unlocked, do not lock it
echo        or switch away while this is running.
echo ============================================
echo.

"%PY%" e2e_test.py

echo.
echo --------------------------------------------
echo Result written to: e2e_result.txt
echo --------------------------------------------
type e2e_result.txt
echo.
pause
