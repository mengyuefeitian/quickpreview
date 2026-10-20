# QuickPreview

### 像 macOS Quick Look 一样按空格预览文件 —— 只不过是在 Windows 上

安装后常驻托盘、**没有任何自己的窗口**。你照常在「文件资源管理器」里翻文件，
选中后按一下 <kbd>Space</kbd>，内容立刻浮现在眼前；再按一下 <kbd>Space</kbd> 或 <kbd>Esc</kbd> 关闭。

[![Release](https://img.shields.io/github/v/release/mengyuefeitian/quick-preview?style=flat-square&color=2f81f7)](https://github.com/mengyuefeitian/quick-preview/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mengyuefeitian/quick-preview/total?style=flat-square&color=3fb950)](https://github.com/mengyuefeitian/quick-preview/releases)
[![Platform](https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square&logo=windows&logoColor=white)](#安装)
[![.NET](https://img.shields.io/badge/.NET-8.0-512bd4?style=flat-square&logo=dotnet&logoColor=white)](https://dotnet.microsoft.com/)
[![License](https://img.shields.io/github/license/mengyuefeitian/quick-preview?style=flat-square&color=orange)](LICENSE)

<p align="center">
  <a href="https://github.com/mengyuefeitian/quick-preview/releases/latest">
    <img src="https://img.shields.io/badge/%E2%AC%87%20%E4%B8%8B%E8%BD%BD%E5%AE%89%E8%A3%85%E5%8C%85-QuickPreview--Setup--x64.exe-2ea043?style=for-the-badge" alt="下载安装包" height="42">
  </a>
</p>

<p align="center">
  <img src="docs/screenshots/word-cover.png" width="80%" alt="Word 预览：封面、目录、页眉页脚与原文档一致">
</p>

---

## 目录

- [为什么做这个](#为什么做这个)
- [核心特性](#核心特性)
- [安装](#安装)
- [使用](#使用)
- [支持的格式](#支持的格式)
- [架构](#架构)
- [从源码构建](#从源码构建)
- [日志与排障](#日志与排障)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [更新日志](#更新日志)
- [致谢](#致谢)
- [许可](#许可)

## 为什么做这个

macOS 上选中文件按空格就能看一眼，是刻进肌肉记忆的操作。Windows 上要做到同样顺手，
要么装完整的 Office、要么忍受「双击打开→等软件启动→关闭」的往返，或者安装一个自己带文件浏览器的预览软件——
后者其实解决的不是同一个问题：**我们想预览的，永远是资源管理器里那一个正在被选中的文件。**

QuickPreview 因此被做成了一个**系统级服务**而不是一个应用：

- 不抢占你的文件管理习惯，资源管理器该怎样还怎样；
- 常驻托盘、不占任务栏，没有任何主界面；渲染模块全部懒加载（首屏 JS 仅 15.5KB），不用时基本不耗 CPU；
- 渲染引擎跑在 WebView2 里，直接复用浏览器级的排版与绘图能力，所以 Word 的页眉页脚、目录点线、
  PPT 的母版背景、PDF 的矢量文字都能**按原样**呈现，而不是"提取纯文本凑合看"。

## 核心特性

<table>
<tr><td width="50%" valign="top">

**⌨️ 零侵入交互**
- 空格开、空格/`Esc` 关，`←` `→` 切换同目录下一个文件
- 只在「资源管理器前台 + 有选中项」时接管空格，其它软件里打字完全不受影响
- 窗口位置、大小自动记住；缩放、单页/双页也记住

</td><td width="50%" valign="top">

**📄 排版级还原**
- Word：目录点线、页眉页脚继承、首页不同、文本框绕排、分页边界全部按 Word 语义重建
- PPT：母版/版式/幻灯片三级背景继承、主题配色、渐变、阴影、表格、组合形状
- PDF：单页横向翻页，等比缩放绝不拉伸变形

</td></tr>
<tr><td valign="top">

**🎬 媒体免转码可直接看**
- 图片、音频、视频（含 `mkv` `ape` `wmv` 等冷门封装）
- 内置 ffmpeg 自动转码并缓存，第二次预览秒开
- 支持 `Range` 拖动播放

</td><td valign="top">

**🗂 顺手的小东西**
- 文件夹：文件数 / 体积统计（超大目录 3 秒截断）
- ZIP：条目列表 + 搜索 + 行内直接预览图片和文本
- 超大文本：首屏 256KB 分块加载，滚到底继续读

</td></tr>
</table>

<p align="center">
  <img src="docs/screenshots/word-toc.png" width="49%" alt="目录：点线、页码右对齐、多级缩进">
  <img src="docs/screenshots/pdf.png" width="49%" alt="PDF 单页横向翻页">
</p>

## 安装

1. 到 [**Releases**](https://github.com/mengyuefeitian/quick-preview/releases/latest) 下载最新的
   `QuickPreview-Setup-<版本>-x64.exe`
2. 双击安装（默认装到当前用户目录，**不需要管理员权限**）
3. 装完自动启动，托盘出现图标即可使用

> **依赖**：Windows 10 1903+ / Windows 11。WebView2 运行时如果缺失，安装程序会提示下载（Win11 与较新的 Win10 通常已自带）。
>
> ⚠️ 安装包未做代码签名，首次运行可能出现 SmartScreen 蓝色提示，点「更多信息 → 仍要运行」即可。

**便携版**：想免安装，可用 `publish/` 目录（自带 .NET 运行时 + 渲染引擎 + ffmpeg），双击 `QuickPreview.exe` 直接跑。

## 使用

| 操作 | 效果 |
|---|---|
| <kbd>Space</kbd> | 打开预览（资源管理器前台且有选中项时） |
| <kbd>Space</kbd> / <kbd>Esc</kbd> | 关闭预览 |
| <kbd>←</kbd> <kbd>→</kbd> | 上一个 / 下一个文件（多页文档中是翻页） |
| <kbd>↑</kbd> <kbd>↓</kbd> | 切换同目录文件 |
| <kbd>Home</kbd> / <kbd>End</kbd> | 跳到首 / 末页 |
| 鼠标滚轮 | 文档内部滚动；页面已完整放下时直接翻页 |
| 按住标题栏拖动 | 移动窗口位置（自动记忆） |
| 拖动窗口边框 | 调整窗口大小（自动记忆） |
| 底部 `−` / `+` / `适应` | Word、PDF 缩放（默认「适应窗口」= 整页可见） |
| 右上角「单页 / 双页」 | Word、PDF 切换单页 / 双页 |
| 右上角「使用 xx 打开」 | 用系统默认程序打开（显示真实程序名，如 Word / 照片） |
| 托盘右键 | 预览当前选中项、开机自启、清转码缓存、查看日志、关于、退出 |

## 支持的格式

| 类别 | 格式 | 说明 |
|---|---|---|
| 图片 | `png` `jpg` `jpeg` `gif` `bmp` `webp` `tiff` `tif` `svg` `ico` | 透明通道、动图正常 |
| 文本 / 代码 | `txt` `md` `json` `log` `csv` `xml` `yaml` `ini` `css` `js` `ts` `py` `java` `go` `rs` `c` `cpp` `html` … | 超大文件分块加载（首屏 256KB） |
| PDF | `pdf` | 单页/双页、缩放、矢量清晰 |
| Word | `docx` `docm`、**`doc`** | 分页、目录、页眉页脚按 Word 语义还原 |
| Excel | `xlsx` `xlsm` `xls` `csv` | 多 sheet 标签页 |
| PPT | `pptx` `pptm` | 按坐标还原形状、文本、图片、表格 |
| 压缩包 | `zip` | 列表 + 搜索 + 行内预览图片/文本 |
| 音频 | `mp3` `flac` `wav` `ape` `ogg` `m4a` `aac` `wma` | 非浏览器原生格式自动转码 |
| 视频 | `mp4` `webm` `mov` `mkv` `avi` `wmv` `m4v` `flv` | 同上，转 mp4 后可拖动 |
| 文件夹 | 目录 | 文件数 / 体积统计 |

> `.doc` 是 Word 97-2003 的 OLE2 二进制格式，内置了 CFB + piece table 解析器直接读取正文，
> 因为格式本身不保存版式信息，呈现为纯文本 + 段落结构。

## 架构

```
资源管理器 ──(选中文件, 按 Space)──▶ 全局键盘钩子  KeyboardHook.cs  (WH_KEYBOARD_LL)
                                          │  只在"预览已开"或"资源管理器有选中项"时吞键
                                          ▼
                          读取选中项  ExplorerSelection.cs / DesktopSelection.cs
                                          │  Shell.Application COM（异步，绝不阻塞钩子）
                                          ▼
                    无边框浮层窗体 MainForm.cs ──WebView2──▶ Web 渲染引擎 (src/renderer)
                                          │                        │
                        本地文件服务 https://qpfile.local/__local ─┘ (支持 Range)
                                          │
                     ffmpeg 转码 MediaTranscode.cs ← 页面请求 prepareMedia
```

**宿主层（C# / .NET 8，WinForms）**

| 文件 | 职责 |
|---|---|
| `KeyboardHook.cs` | `WH_KEYBOARD_LL` 低层钩子。命中条件极窄，其余按键一律放行；回调内只做零成本 Win32 判断 |
| `ExplorerSelection.cs` | 遍历 `Shell.Windows` 取前台窗口的 `SelectedItems()`，还原多选顺序 |
| `DesktopSelection.cs` | 桌面是特例：桌面 ShellWindow 的 hwnd ≠ `SHELLDLL_DefView`，只能按 `LocationName` 定位 |
| `MainForm.cs` | 无边框浮层 + 托盘常驻 + 虚拟主机映射 + `__local` 文件服务 |
| `MediaTranscode.cs` | ffmpeg 按需转码，结果按路径哈希缓存到 `%TEMP%` |
| `Logger.cs` | 分功能拆文件、轮转、倒序写入的日志系统 |

**渲染层（TypeScript / Vite，跑在 WebView2 里）**

| 文件 | 职责 |
|---|---|
| `lib/docxview.ts` | Word 渲染：目录制表位重排、按段落边界重新分页、浮动对象定位 |
| `lib/docxsec.ts` | 渲染前修补 `document.xml`：补全页眉页脚继承、处理 `titlePg` 首页不同 |
| `lib/pptx.ts` | 自研 OOXML 演示文稿渲染（背景继承、主题色、形状、表格） |
| `lib/pdfview.ts` | PDF 单页横向翻页 + 预渲染 + LRU 缓存 |
| `lib/doc.ts` | `.doc` 二进制解析（CFB / FAT / piece table） |
| `lib/zip.ts` | 压缩包列表与行内预览 |
| `lib/text.ts` | 大文件分块流式加载 |

> **扩展名分类有两份等价实现**：`src/shared/mime.ts`（Web 侧）与 `dotnet/QuickPreview/FileTypes.cs`（C# 侧），改动时需要同步。

<details>
<summary><b>几个实现上不太显然的决定</b></summary>

- **本地文件服务用独立虚拟主机** `qpfile.local`。`SetVirtualHostNameToFolderMapping` 会吞掉该 host 下所有请求，
  同 host 的 `/__local` 永远触发不了 `WebResourceRequested`。
- **宿主与页面之间不用 host object 传参**。`AddHostObjectToScript` 的方法调用会报 `0x80070057`，
  所有"页面要宿主干活"的调用都走 `postMessage` 往返。且 `CoreWebView2` 成员只能在 UI 线程访问，
  后台线程回调必须先 `BeginInvoke`。
- **WebView2 用户数据目录显式指向** `%LOCALAPPDATA%\QuickPreview\WebView2`。默认会落在 exe 同目录，
  升级不覆盖、卸载不清理，安装目录一路膨胀。
- **canvas 绝不用 CSS 拉伸**。PDF / 图片的宽高由 JS 算好后写进 `style.width/height`，否则画面会被压扁。
- **Word 分页阈值用"内容区高度"**（纸张高 − 上下页边距），拿整页高度当容量会让每页多塞 20% 内容、页页被撑高。

</details>

## 从源码构建

**前置**：.NET 8 SDK、Node.js 18+、[Inno Setup 6](https://jrsoftware.org/isinfo.php)（仅打安装包需要）

### 一键构建

```bat
cd quick-preview
dotnet\build.bat
```

产出：

- 安装包 `installer\QuickPreview-Setup-<版本>-x64.exe`
- 便携版 `publish\QuickPreview.exe`

### 手动构建

```bash
npm install
npm run build:web          # Web 渲染引擎 → dist/renderer
dotnet publish dotnet/QuickPreview/QuickPreview.csproj -c Release -o publish
```

### 调试渲染引擎（Electron 宿主，可选）

Web 渲染引擎保留了一套 Electron 宿主，方便脱离资源管理器独立调试（带文件选择器的独立窗口，非最终形态）：

```bash
npm run dev:web            # 终端 1
npm run dev:app            # 终端 2
```

### 版本号规则

`主.次.修订`：**仅修 Bug → 第 3 位 +1**；**含新功能 → 第 2 位 +1**；**架构级重构 / 不兼容变更 → 第 1 位 +1**。

改版本号必须同步三处，缺一会导致安装包名、程序内显示、包版本各说各话：

1. `dotnet/QuickPreview/QuickPreview.csproj` → `<Version>` / `<AssemblyVersion>` / `<FileVersion>`
2. `dotnet/setup.iss` → `#define MyAppVersion`
3. `package.json` → `version`

程序内部统一通过 `AppVersion.Current` 读取（从程序集版本派生），不要在日志或 UI 里硬编码版本字符串。

## 日志与排障

**日志目录**：`%LOCALAPPDATA%\QuickPreview\logs`（托盘右键 →「打开日志目录」）

| 文件 | 内容 |
|---|---|
| `app.log` | 启动/退出、托盘、自启、心跳（含钩子与 WebView2 状态） |
| `hook.log` | **按空格没反应先看这里**：钩子安装、每次空格、前台窗口 class/title、选中项读取过程 |
| `preview.log` | 窗口开关、文件类型判定、置顶结果 |
| `media.log` | ffmpeg 命令行/耗时/退出码、`__local` 请求与 Range |
| `web.log` | WebView2 初始化、宿主与页面双向消息、页面 JS 异常 |
| `error.log` | 所有 Error 级别日志的集中副本 |

存储规则（每个文件独立生效）：单文件 ≤ 10MB 即轮转，保留 2 份备份，内容**倒序**（最新在最上面），
异步落盘不阻塞钩子，Error 级别立即落盘。

托盘还有内置日志查看器：下拉切换文件、自动刷新、清空、**导出诊断包**（全部日志打 zip 到桌面）。

## 常见问题

<details>
<summary><b>按空格完全没反应</b></summary>

按顺序排查 `hook.log` 顶部记录：钩子是否安装 → 是否捕获到空格 → 前台窗口是什么 →
Shell COM 是否读到选中项。

两个已修复的历史坑，可以帮你理解这类问题的成因：

1. **在键盘钩子回调里同步调 COM** 会被 Windows 拒绝（`RPC_E_CANTCALLOUT_ININPUTSYNCCALL`），
   所以读取动作必须异步投递到 UI 线程，且读不到时要补发一次空格，不能把用户的操作"吃掉"。
2. **程序以管理员权限运行**时，与普通权限的资源管理器跨 UIPI 边界，COM 调用会被系统拒绝。
   `app.manifest` 已固定 `asInvoker`；若仍出现，托盘右键有「以普通权限重启」一键降级。

</details>

<details>
<summary><b>预览窗口躲在资源管理器后面</b></summary>

Windows 有"防抢焦点"机制，非前台进程弹窗会被插到当前前台窗口下面，`SetForegroundWindow` 还会静默失败。
现在的实现是 `AttachThreadInput` + `HWND_TOPMOST` + 延迟二次置顶的组合（详见 `MainForm.ForceToFront`）。

</details>

<details>
<summary><b>预览一片空白 / 页面是白的</b></summary>

看 `web.log` 与 `error.log`。最常见原因是页面脚本在 module 解析阶段就抛异常——
此时 `window.onerror` 还没装上，页面会静默全白，所以 `index.html` 里放了一段**内联**的早期错误捕获。

</details>

<details>
<summary><b>Word 排版和原文档有差异</b></summary>

预览引擎是轻量 OOXML 还原（docx-preview + 自研修补），不是 Word 排版内核。复杂艺术字、公式、
嵌入对象、`.doc` 的原始版式都无法完全还原。已知并已处理的部分：目录点线、页眉页脚继承、首页不同、
文本框绕排、浮动图片、分页边界。

</details>

<details>
<summary><b>大视频第一次预览很慢</b></summary>

非浏览器原生封装的视频（`mkv` `avi` `wmv`）会先用 ffmpeg 转成 mp4，结果按路径哈希缓存，第二次秒开。
托盘右键「清转码缓存」可清理。

</details>

## 路线图

- [ ] 安装包代码签名，消除 SmartScreen 提示
- [ ] 预览窗口内搜索（文本 / Word / PDF）
- [ ] 表格类文件的单元格选区复制
- [ ] 更多格式：`heic`、`7z`、`rar`、`epub`
- [ ] 自定义快捷键与「点击即预览」模式

有想法欢迎开 [Issue](https://github.com/mengyuefeitian/quick-preview/issues)。

## 更新日志

完整历史见 [CHANGELOG.md](CHANGELOG.md)，每个版本对应一个
[Release](https://github.com/mengyuefeitian/quick-preview/releases)，其中附带该版本的安装包。

**最新版 v1.5.3** — 修复 Word 封面文字层叠、第 2 页起页眉页脚整片丢失、封面被硬塞正文页眉页脚、
带书签的目录条目折行。详见 [Release v1.5.3](https://github.com/mengyuefeitian/quick-preview/releases/tag/v1.5.3)。

## 致谢

站在这些优秀开源项目的肩膀上：

- [docx-preview](https://github.com/VolodymyrBaydalka/docx-preview) — Word 的 OOXML → DOM 渲染基座
- [PDF.js](https://github.com/mozilla/pdf.js) — PDF 渲染
- [SheetJS](https://github.com/SheetJS/sheetjs) — Excel 解析
- [JSZip](https://github.com/Stuk/jszip) — OOXML / ZIP 容器解析
- [WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) — 原生宿主里的渲染引擎
- [FFmpeg](https://ffmpeg.org/) — 音视频转码

## 许可

[MIT](LICENSE) © andyann
