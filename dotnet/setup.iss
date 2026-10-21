; QuickPreview 安装脚本（Inno Setup 6）
; 用法：先执行 dotnet\build.bat 产出 publish\，再用 Inno Setup 编译本文件 → installer\QuickPreview-Setup-x64.exe

#define MyAppName      "QuickPreview"
; 版本号须与 QuickPreview.csproj 的 <Version>、package.json 的 version 保持一致
; 规则：修 Bug 第3位+1；含功能第2位+1（打包前确认）；架构变更第1位+1
#define MyAppVersion   "1.6.1"
#define MyAppPublisher "QuickPreview"
#define MyAppURL       "https://github.com/mengyuefeitian/quickpreview"
#define MyAppExeName   "QuickPreview.exe"
#define MyAppId        "QuickPreview.FileQuickPreview"
#define PublishDir     "..\publish"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\QuickPreview
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
; 仅在命令行显式指定时才允许提权覆盖：保持与资源管理器一致的普通权限上下文
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter=*.exe
RestartApplications=no
; 单实例互斥体（须与 Program.cs 的 SingleInstanceMutex 完全一致）。
; 旧实例运行时，安装程序能可靠地识别并请求其退出，避免"覆盖安装失败/文件被占用"。
AppMutex=QuickPreview_SingleInstance_Mutex
OutputDir=..\installer
OutputBaseFilename=QuickPreview-Setup-{#MyAppVersion}-x64
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName},0
Compression=lzma2/max
SolidCompression=yes
InternalCompressLevel=max
LZMAUseSeparateProcess=yes
LZMADictionarySize=262144
LZMANumBlockThreads=4
Uninstallable=yes
SignedUninstaller=no

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"
Name: "english";     MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart";   Description: "开机自动启动 QuickPreview"; GroupDescription: "附加选项："
Name: "desktopicon"; Description: "创建桌面快捷方式";           GroupDescription: "附加选项："

[Files]
; 主程序（publish 目录下全部内容：exe + 运行时 + webroot + ffmpeg）
; 注意 Excludes：程序运行时会在 exe 同目录生成 WebView2 用户数据目录
; （QuickPreview.exe.WebView2，含 leveldb 的 LOCK/LOG 等文件）。
; 本地调试后直接打包会把这份"测试缓存"塞进安装包，既增大体积，
; 也可能因残留 LOCK 影响目标机首次启动，必须排除。
Source: "{#PublishDir}\*"; DestDir: "{app}"; \
    Excludes: "QuickPreview.exe.WebView2,QuickPreview.exe.WebView2\*,*.pdb,*.vshost.exe"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; WebView2 运行时引导器（仅当系统缺少 WebView2 时由 [Code] 提取并安装，1.8MB）
Source: "redist\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: nocompression dontcopy

[Icons]
Name: "{group}\{#MyAppName}";       Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}";  Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; 注意：开机自启【不】放在 [Registry] 段。
; 该段写入失败会直接中断安装并回滚（管理员安装模式下写 HKCU Run 可能返回"拒绝访问"）。
; 改为在 ssPostInstall 阶段由 [Code] 容错写入，失败只记录不中断。

[Run]
; 缺少 WebView2 运行时时静默安装（必需组件）
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; \
    StatusMsg: "正在安装 WebView2 运行时（必需组件）..."; Check: NeedWebView2; Flags: waituntilterminated

; 安装完成立即启动预览服务。
; 必须经 explorer.exe 启动：本服务需要与资源管理器处于同一（普通）完整性级别，
; 若跟随安装包的管理员令牌启动，读取选中文件会被 UIPI 拒绝（表现为按空格无反应）。
Filename: "{win}\explorer.exe"; Parameters: """{app}\{#MyAppExeName}"""; \
    Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

; ---------- 覆盖安装前的清理 ----------
; webroot\assets 下的文件名带内容哈希（index-Di17XQGm.js 之类），每次构建都会变。
; Inno 的升级安装不会主动删除"新版本已不包含"的旧文件，反复覆盖安装后该目录会无限堆积
; （实测累积了 30+ 个历史 index-*.js/.css，安装目录从 229MB 膨胀到 303MB）。
; QuickPreview.exe.WebView2 是 1.4.0 及更早版本把 WebView2 缓存落在 exe 同目录的遗留物，
; 新版已改到 %LOCALAPPDATA%\QuickPreview\WebView2，这里负责清掉老位置。
;
; 【坑】这里必须用 "files" 通配删除 assets 下的文件，不能写 "filesandordirs" 删整个目录：
; Inno 对目录的删除是延迟到最后执行的，会把刚装进去的新 assets 一起删掉，
; 表现为安装完成后 webroot 里只剩 index.html、打开预览一片空白（1.5.0 踩过）。
[InstallDelete]
Type: files; Name: "{app}\webroot\assets\*"
Type: filesandordirs; Name: "{app}\QuickPreview.exe.WebView2"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\QuickPreview"

[Code]
const
  WebView2ClientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  AppExeName = 'QuickPreview.exe';
  // 须与 Program.cs 的 SingleInstanceMutex、[Setup] 的 AppMutex 三者一致
  MutexName = 'QuickPreview_SingleInstance_Mutex';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

// 旧实例是否仍在运行（通过单实例互斥体判断）
function AppIsRunning(): Boolean;
begin
  Result := CheckForMutexes(MutexName);
end;

// 强制结束正在运行的 QuickPreview。
// 本程序是「隐藏主窗体 + 托盘常驻」，没有可见窗口可以接收 WM_CLOSE/WM_QUERYENDSESSION，
// Inno 自带的 CloseApplications 经常关不掉它，导致覆盖安装时文件被占用而失败。
// 这里显式调用 taskkill 兜底（/T 一并结束子进程）。
// 返回 False 表示未能结束，且用户选择中止安装。
function KillRunningApp(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if not AppIsRunning() then
    exit;

  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM ' + AppExeName, '', SW_HIDE,
       ewWaitUntilTerminated, ResultCode);
  Sleep(800);

  if AppIsRunning() then begin
    // 仍未能结束：绝大多数情况是旧实例以管理员权限运行，
    // 而本次安装为普通权限，taskkill 无权结束高完整性级别进程。
    Result := MsgBox('QuickPreview 正在运行且无法自动关闭。' + #13#10#13#10 +
                     '常见原因：它以【管理员权限】运行，而本次安装是普通权限。' + #13#10 +
                     '请右键系统托盘的 QuickPreview 图标 → 退出，' +
                     '（或选择托盘菜单中的"以普通权限重启"）后重新运行安装程序。' + #13#10#13#10 +
                     '是否仍要继续安装？（文件可能更新不完整，建议先退出程序）',
                     mbConfirmation, MB_YESNO) = IDYES;
  end;
end;

// 静默结束旧实例（不弹任何框），供 InitializeSetup 抢先调用
procedure SilentlyKillRunningApp();
var
  ResultCode: Integer;
begin
  if not AppIsRunning() then
    exit;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM ' + AppExeName, '', SW_HIDE,
       ewWaitUntilTerminated, ResultCode);
  Sleep(800);
end;

// 安装（含覆盖安装）前：确认旧实例已结束
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  try
    if not KillRunningApp() then
      Result := '安装已被取消：请先退出正在运行的 QuickPreview。';
  except
    Result := '';
  end;
end;

// 卸载前：先结束运行中的实例，避免卸载后残留文件
function InitializeUninstall(): Boolean;
begin
  Result := True;
  try
    KillRunningApp();
  except
  end;
end;

// 系统是否已存在 WebView2 运行时（HKLM 64/32 位 + HKCU）
function WebView2Present(): Boolean;
begin
  Result := RegKeyExists(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid)
         or RegKeyExists(HKEY_LOCAL_MACHINE, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid)
         or RegKeyExists(HKEY_CURRENT_USER,  'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientGuid);
end;

// 供 [Run] 段判断：需要安装 WebView2 时才解压并执行引导器
function NeedWebView2(): Boolean;
begin
  if WebView2Present then begin
    Result := False;
    exit;
  end;
  try
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    Result := True;
  except
    Result := False;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not IsWin64 then begin
    MsgBox('QuickPreview 仅支持 64 位 Windows。', mbError, MB_OK);
    Result := False;
    exit;
  end;

  // 关键：必须在 Inno 自带的 CloseApplications 检测【之前】结束旧实例。
  // 本程序是「隐藏主窗体 + 托盘常驻」，Inno 找不到可关闭的可见窗口，
  // 会在检测阶段直接弹框要求用户手动关闭，覆盖安装即告失败（静默模式下直接中止）。
  try
    SilentlyKillRunningApp();
  except
  end;
end;

// ---------- 开机自启：容错写入，失败不中断安装 ----------
procedure ApplyAutostart();
begin
  if not WizardIsTaskSelected('autostart') then
    exit;
  try
    if not RegWriteStringValue(HKEY_CURRENT_USER, RunKey, '{#MyAppName}',
                               '"' + ExpandConstant('{app}') + '\{#MyAppExeName}"') then
      Log('提示：写入开机自启失败（不影响使用，可在托盘菜单中手动开启）');
  except
    Log('提示：写入开机自启异常（不影响使用，可在托盘菜单中手动开启）');
  end;
end;

procedure RemoveAutostart();
begin
  try
    RegDeleteValue(HKEY_CURRENT_USER, RunKey, '{#MyAppName}');
  except
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    ApplyAutostart();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveAutostart();
end;
