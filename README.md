# QuickPreview — Windows 空格键快速预览（系统级服务）

[![Release](https://img.shields.io/github/v/release/mengyuefeitian/quick-preview?style=flat-square)](https://github.com/mengyuefeitian/quick-preview/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4?style=flat-square)](#)
[![.NET](https://img.shields.io/badge/.NET-8.0-512bd4?style=flat-square)](#)

**[⬇ 下载最新安装包](https://github.com/mengyuefeitian/quick-preview/releases/latest)**（`QuickPreview-Setup-<版本>-x64.exe`，双击安装）

类 macOS Quick Look 的 **Windows 系统级预览服务**：安装/启动后常驻系统托盘，**不显示任何自己的窗口**。
你照常在「文件资源管理器」里浏览、操作文件，选中一个（或多个）文件后按 **空格** 即弹出预览浮层，
再按空格或 `Esc` 关闭，`←` `→` 切换同目录/选择集的下一个文件，滚轮在文档内翻页。

![Word 封面](docs/screenshots/word-cover.png)
![Word 目录](docs/screenshots/word-toc.png)

<p align="center">
  <img src="docs/screenshots/word-header-footer.png" width="49%" />
  <img src="docs/screenshots/pdf.png" width="49%" />
</p>


## 操作方式
| 操作 | 效果 |
|---|---|
| `空格` | 打开预览（资源管理器前台且选中文件时触发，此时空格不会传给资源管理器） |
| `空格` / `Esc` | 关闭预览 |
| `←` `→` | 上一个 / 下一个文件 |
| `↑` `↓` | 移动选择 |
| 鼠标滚轮 | 文本 / Word / Excel / PPT / PDF 内部滚动翻页；页面已完整放下时改为翻页 |
| 按住标题栏拖动 | 移动预览窗口位置（松开后记住，下次在同一位置弹出） |
| 拖动窗口边框 | 调整预览窗口大小（同样会记住） |
| 底部 `−` / `+` / `适应` | 调整 Word、PDF 的缩放（默认「适应窗口」= 整页可见） |
| 右上角「单页 / 双页」 | Word、PDF 切换单页 / 双页浏览（`←` `→` 翻页） |
| 右上角「使用 xx 打开」 | 用系统默认程序打开（`xx` 是真实默认程序名，如 Word / 记事本 / 照片） |
| 托盘图标 | 右键可预览当前选中文件、开关开机自启、清转码缓存、退出 |

## 支持的格式
| 类别 | 格式 |
|---|---|
| 图片 | png jpg jpeg gif bmp webp tiff tif svg ico |
| 文本 / 代码 | txt md json log csv xml yaml yml ini css js ts jsx tsx py java go rs c cpp html …（超大文件分块加载：首屏 256KB，滚到底部继续读） |
| PDF | pdf（单页 / 双页、可缩放） |
| Word | docx docm（单页 / 双页、可缩放；目录、分页与页码按段落边界自动还原；旧版 .doc 不支持，请另存为 .docx） |
| Excel | xlsx xlsm xls csv（多 sheet 标签页切换） |
| PPT | pptx pptm（按坐标还原文本框与图片；旧版 .ppt 不支持） |
| 压缩包 | zip（列表 + 文件大小 / 压缩后大小 / 时间 + 搜索 + 点行内预览图片和文本） |
| 音频 | mp3 flac wav **ape** ogg m4a aac wma（ape/wma 等自动转码为 flac） |
| 视频 | mp4 webm mov **mkv** avi wmv m4v flv（mkv/avi 等自动转码为 mp4） |

## 架构
```
文件资源管理器 ──(选中文件, 按空格)──▶ 全局空格钩子 (KeyboardHook.cs, WH_KEYBOARD_LL)
                                              │
                                              ▼
                              读取选中项 (ExplorerSelection.cs, Shell.Application COM)
                                              │
                                              ▼
                       无边框浮层窗体 (MainForm.cs) ── WebView2 ──▶ Web 预览引擎 (dist/renderer)
                                              │                          │
                           本地文件服务 https://app.local/__local ───────┘ (含 Range，供音视频拖动)
                                              │
                           ffmpeg 转码 (MediaTranscode.cs) ← window.QP.prepareMediaAsync
```

- **`KeyboardHook.cs`**：`WH_KEYBOARD_LL` 低层键盘钩子。只在两种情况下「吞掉」空格——预览已打开（关闭它），
  或前台是资源管理器且选中了文件（打开预览）；其余情况一律放行，不干扰浏览器/编辑器等其它软件。
- **`ExplorerSelection.cs`**：通过 `Shell.Application` COM 遍历 shell 窗口，取前台窗口的 `Document.SelectedItems()`，
  得到选中的绝对路径（多选时按选择顺序翻页）。
- **`MainForm.cs`**：无边框浮层窗体 + 托盘常驻。`SetVirtualHostNameToFolderMapping("app.local", webroot)`
  把 Vite 构建的 Web 引擎映射为虚拟主机；拦截 `https://app.local/__local?p=<绝对路径>` 返回本地文件字节（支持 HTTP Range）。
- **`QPBridge.cs`**：`window.QP.prepareMediaAsync(path)` → Promise，C# 侧调用 ffmpeg 把 ape/mkv 等转为 flac/mp4，
  结果按路径哈希缓存到 `%TEMP%\QuickPreviewCache`，二次预览秒开。
- **`Autostart.cs`**：写入 HKCU Run 项实现开机自启（无需管理员权限）。

> 注：扩展名分类在两处各有一份等价实现——`src/shared/mime.ts`（Web 侧）与
> `dotnet/QuickPreview/FileTypes.cs`（C# 侧），改动时需同步。

## 构建与运行（Windows）

**前置**：.NET 8 SDK、Node.js 18+、WebView2 运行时（Win10 1903+/Win11 通常已自带，缺失时按提示安装 Evergreen Runtime）。

### 一键构建
```bat
cd quick-preview
dotnet\build.bat
```
产出：
- **安装包**：`installer\QuickPreview-Setup-1.5.3-x64.exe`（需本机装有 Inno Setup 6，双击安装，可选开机自启）
- **便携版**：`publish\QuickPreview.exe`（自包含 .NET 运行时 + webroot + ffmpeg.exe，解压即用）

### 手动构建
```bash
npm install
npm run build:web                                                   # 构建 Web 预览引擎 → dist/renderer
dotnet publish dotnet/QuickPreview/QuickPreview.csproj -c Release -o publish
```

### 调试渲染引擎（Electron 开发模式，可选）
Web 预览引擎也保留了一套 Electron 宿主便于独立调试（自带文件选择器的独立窗口，非最终形态）：
```bash
npm run dev:web     # 终端1
npm run dev:app     # 终端2
```

## 日志与诊断

**日志目录**：`%LOCALAPPDATA%\QuickPreview\logs`（托盘右键 →「打开日志目录」可直接进入）

按服务/功能拆分，每类独立文件、**各自遵守同一套存储规则**：

| 文件 | 内容 |
|---|---|
| `app.log` | 程序启动/退出、托盘、自启、心跳（每 5 分钟一条，含钩子与 WebView2 状态） |
| `hook.log` | **空格没反应先看这里**：钩子安装、每次空格按键、前台窗口 class/title、资源管理器选中项读取过程 |
| `preview.log` | 预览窗口打开/关闭、文件类型判定 |
| `media.log` | ffmpeg 转码命令行/耗时/退出码、`__local` 本地文件服务与 Range 请求 |
| `web.log` | WebView2 初始化、宿主与页面双向消息、页面 JS 异常 |
| `error.log` | 所有 Error 级别日志的集中副本 |

**存储规则**（每个文件独立生效）：
- 单文件不超过 **10MB**，超限即轮转 → 当前文件改名 `<name>.1.log`，`<name>.1.log` → `<name>.2.log`
- 备份最多保留 **2 个**（`<name>.1.log` / `<name>.2.log`），更早的自动删除
- 文件内容**倒序**：最新一条在最上面（无需翻到文件末尾）
- 异步落盘（约 0.8 秒/次），不阻塞键盘钩子；Error 级别立即唤醒落盘

**查看方式**（托盘右键）：
- `查看日志…` — 内置查看器，下拉切换各文件/备份，支持自动刷新、清空、导出
- `打开日志目录` — 直接用资源管理器打开日志文件夹
- 查看器内 `导出诊断包` — 把全部日志打包成 zip 放到桌面

**排查「按空格没反应」**：按空格后打开 `hook.log`，顶部即为最新记录，可看到：
钩子是否安装 → 是否捕获到空格 → 前台窗口是什么 → Shell COM 是否读到选中项 → 最终是否打开预览。

### 两个高频原因（1.1.1 已修复/已可自愈）

1. **`RPC_E_CANTCALLOUT_ININPUTSYNCCALL`（已修复）**
   在键盘钩子回调里同步调用 Shell COM 会被 Windows 拒绝，选中项永远读不到。
   修复方式：钩子回调内只做零成本的 Win32 判断（窗口类是否属于资源管理器/桌面/对话框），
   随后吞键并把读取动作投递到 UI 线程**异步**执行。
   读不到选中项时会补发一次空格，保证用户在资源管理器里的操作不被"吃掉"。

2. **以管理员权限运行（已有提示与自愈入口）**
   资源管理器通常是普通权限，本程序若为管理员权限，两者完整性级别不一致，
   跨 UIPI 边界的 COM 调用会被系统拒绝，表现为**按空格没有任何反应**。
   - 程序启动会在 `app.log` 记录 ERROR，并弹出托盘气泡提示
   - 托盘右键出现 **「以普通权限重启（修复按空格无反应）」**，点击即降级重启
   - `app.manifest` 已固定 `asInvoker`，正常双击启动即为普通权限

## 版本号规则（改动前必读）

采用 `主.次.修订`：**仅修 Bug → 第 3 位 +1**；**含功能需求 → 第 2 位 +1（打包前确认）**；**架构级重构/不兼容变更 → 第 1 位 +1**。

改动版本号时**必须同步三处**：
1. `dotnet/QuickPreview/QuickPreview.csproj` → `<Version>` / `<AssemblyVersion>` / `<FileVersion>`（程序内 `AppVersion.Current` 与日志由此读取）
2. `dotnet/setup.iss` → `#define MyAppVersion`（决定安装包文件名）
3. `package.json` → `version`（Electron 调试模式）

## 已知限制
- C# 宿主已在本机编译通过并产出安装包；但「资源管理器空格触发 + 读取选中项」涉及
  全局钩子与 Shell COM，请在实机上安装后验收。
- 旧版 `.doc` / `.ppt`（二进制 OLE 格式）无法预览，请另存为 `.docx` / `.pptx`。
- 办公文件走轻量解析路线（mammoth / SheetJS / 自研 OOXML），复杂排版与原始 Office 可能有细微差异。
- 大体积视频首次预览转码耗时较长（结果已缓存）。
- 预览浮层默认 `TopMost`，会浮在其它窗口之上（与 Quick Look 行为一致）。
- 安装包未做代码签名，首次运行可能触发 SmartScreen 提示（选择"仍要运行"即可）。

## 更新日志

### v1.5.3
- 修复 Word 封面「文字层叠乱码」：文本框（`wps:txbx`）被按 VML 绝对坐标渲染且不占文档流，导致后续正文压到标题上；
  现在按 VML 语义重算位置，绕排（wrapSquare）的框会让锚点段落预留高度。
- 修复 Word 第 2 页起**页眉页脚整片丢失**：Word 的语义是"节内没写引用就继承上一节"，预览引擎此前不实现继承；
  渲染前把 `sectPr` 的 header/footer 引用补全。
- 修复 Word 封面被硬塞正文页眉页脚：`w:titlePg`（首页不同）此前取不到"首页"引用时退回默认页眉，现改为真正的空白页眉页脚。
- 修复带书签的目录条目被整行塞进标题栏、标题折成两行、目录页比 A4 高出 300+ 像素的问题。

### v1.5.2
- 修复 Word 预览「有的页高、有的页矮」：分页阈值改用内容区高度（纸张高 − 上下页边距），浮动图片不再撑高页面。

### v1.5.1
- 修复 Word 目录解析（制表位被模拟成巨大 `word-spacing`，标题折行、点线丢失）。
- 修复 Word 预览滚轮无法持续向下翻页。

### v1.5.0
- 超大文本分块加载（首屏 256KB，滚到底继续读）。
- 标题栏按钮显示**真实**默认程序名（Word / 记事本 / 照片 …）。
- 修复 PPT 内容与实际不符（按坐标还原文本框/图片）。
- 预览窗口支持拖动、边框缩放，并记忆位置与大小。
- Word / PDF 新增单页·双页切换、适应窗口与底部缩放。
- 新增 ZIP 预览（列表 + 搜索 + 行内预览图片和文本）。

