@echo off
setlocal enabledelayedexpansion

REM QuickPreview 一键构建脚本（Windows）
REM 1) Vite 构建 Web 预览引擎 → dist/renderer
REM 2) dotnet publish 编译 C# 预览服务 → publish\（自包含，含 webroot 与 ffmpeg.exe）
REM 3) 若装有 Inno Setup 6，则生成安装包 → installer\QuickPreview-Setup-1.5.2-x64.exe

pushd "%~dp0\.."

echo [1/3] 构建 Web 预览引擎 (Vite)...
call npm run build:web
if errorlevel 1 goto :err

echo [2/3] 编译 C# 预览服务 (dotnet publish, 自包含)...
REM 清理上一版 webroot：Vite 每次构建会生成新的哈希文件名，
REM publish 目录只会累加旧资源，导致安装包无谓变大。
if exist publish\webroot rmdir /s /q publish\webroot
dotnet publish dotnet\QuickPreview\QuickPreview.csproj -c Release -o publish
if errorlevel 1 goto :err

echo [3/3] 生成安装包 (Inno Setup)...
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"    set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if defined ISCC (
    "!ISCC!" dotnet\setup.iss
    if errorlevel 1 goto :err
    echo.
    echo ============================================
    echo  构建完成：
    echo   便携版： publish\QuickPreview.exe
    echo   安装包： installer\QuickPreview-Setup-x64.exe
    echo   （文件名中的版本号取自 dotnet\setup.iss 的 MyAppVersion；含功能的需求第2位+1，仅修 Bug 第3位+1）
    echo  安装后在「文件资源管理器」中选中文件，按空格键即可预览。
    echo ============================================
) else (
    echo 未检测到 Inno Setup 6，跳过安装包生成（仅产出便携版 publish\QuickPreview.exe）。
    echo 安装 Inno Setup 6 后重新运行本脚本即可生成安装包。
    echo.
    echo ============================================
    echo  构建完成： publish\QuickPreview.exe
    echo ============================================
)
popd
goto :eof

:err
echo.
echo 构建失败，请检查上方错误信息。
popd
exit /b 1
