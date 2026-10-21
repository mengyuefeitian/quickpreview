@echo off
echo QuickPreview bat test
for %%i in (1 2 3) do echo item %%i
if exist "%~dp0code_sample.py" echo python sample found
pause
