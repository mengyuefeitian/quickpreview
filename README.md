<div align="center">

<h1>QuickPreview</h1>

<p>
  在 Windows 资源管理器里选中文件，<b>按空格直接看内容</b>
</p>

<p>
  <a href="https://github.com/mengyuefeitian/quickpreview/releases/latest"><img src="https://img.shields.io/github/v/release/mengyuefeitian/quickpreview?style=flat-square&color=2f81f7" alt="Release"></a>
  <a href="https://github.com/mengyuefeitian/quickpreview/releases"><img src="https://img.shields.io/github/downloads/mengyuefeitian/quickpreview/total?style=flat-square&color=3fb950" alt="Downloads"></a>
  <a href="#系统要求"><img src="https://img.shields.io/badge/Windows-10%201903%2B%20%7C%2011-0078d4?style=flat-square" alt="Platform"></a>
  <a href="#系统要求"><img src="https://img.shields.io/badge/.NET-8.0-512bd4?style=flat-square" alt=".NET"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-orange?style=flat-square" alt="License"></a>
</p>

<p>
  <a href="https://github.com/mengyuefeitian/quickpreview/releases/latest"><img src="https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD%E5%AE%89%E8%A3%85%E5%8C%85-QuickPreview--Setup--x64.exe-2ea043?style=for-the-badge" alt="下载安装包" height="40"></a>
</p>

</div>

---

## 这是什么

Windows 上没有 macOS 那种「选中文件按空格看一眼」的操作。要看一份文档，通常得双击、等软件启动、看完再关掉；或者装一个自带文件浏览器的预览工具——但那样看的已经不是资源管理器里那个文件了。

QuickPreview 只做一件事：**接管空格键**。它在后台常驻，监听资源管理器的选中状态，你按空格时把选中文件的内容渲染到一个浮层里。它没有主界面，不改你的文件管理习惯。

渲染在 WebView2 里完成，用浏览器级的排版能力还原文档，而不是提取纯文本。

## 功能

- **空格开合** — `Space` 打开，`Space` / `Esc` 关闭；只在资源管理器处于前台且有选中项时接管空格，其它程序里打字不受影响。
- **同目录切换** — `←` `→` 在文档内翻页，翻到边界后切到同目录的上/下一个文件；`↑` `↓` 直接切换文件。
- **Word 版式还原** — 分页边界、目录点线、页眉页脚继承、首页不同、文本框绕排、浮动图片。
- **PPT 还原** — 母版 / 版式 / 幻灯片三级背景继承、主题配色、渐变、表格、组合形状。
- **PDF** — 单页或双页横向翻页，等比缩放；矢量文字不糊。
- **媒体直接播** — 浏览器不支持的封装（`mkv` `avi` `wmv` `ape` 等）用内置 ffmpeg 按需转码，结果缓存，第二次秒开。
- **网页存档** — `.mhtml` / `.mht` 按 MIME 分包拆开，图片与 CSS 内联后还原成原页面，断网也能看。
- **顺手的小功能** — 文件夹显示文件数与体积；`zip` 列出条目并可直接预览包内图片和文本；超大文本分块加载。

## 支持格式

| 类别      | 格式                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 图片      | `png` `jpg` `jpeg` `jpe` `jfif` `gif` `bmp` `webp` `tiff` `tif` `svg` `ico` `avif` `heic`                                                                               |
| 文本 / 代码 | `txt` `md` `markdown` `json` `log` `yaml` `xml` `ini` `css` `js` `ts` `jsx` `tsx` `py` `java` `go` `rs` `c` `cpp` `h` `html` `sh` `bat` `ps1` `sql` `toml` `vue` `scss` |
| PDF     | `pdf`                                                                                                                                                                   |
| Word    | `docx` `docm` `doc`                                                                                                                                                     |
| Excel   | `xlsx` `xlsm` `xls` `csv` `tsv`                                                                                                                                         |
| PPT     | `pptx` `pptm`                                                                                                                                                           |
| 压缩包     | `zip`                                                                                                                                                                   |
| 网页存档    | `mhtml` `mht`                                                                                                                                                           |
| 音频      | `mp3` `flac` `wav` `ape` `ogg` `m4a` `aac` `wma`                                                                                                                        |
| 视频      | `mp4` `mkv` `avi` `mov` `webm` `wmv` `flv` `m4v` `mpg` `mpeg`                                                                                                           |
| 文件夹     | 目录（文件数 / 体积统计）                                                                                                                                                          |

关于旧格式：`.doc` 是 Word 97-2003 的 OLE2 二进制，内置 CFB + piece table 解析器直接读正文。该格式不保存版式信息，因此呈现为纯文本加段落结构。`.ppt` 目前不支持——纯前端没有可用的二进制解析器，预览时会提示另存为 `.pptx`。

## 安装

### 系统要求

| 项目       | 要求                                  |
| -------- | ----------------------------------- |
| 系统       | Windows 10 1903 及以上 / Windows 11    |
| 运行时      | .NET 8（安装包已自带）                      |
| WebView2 | Win11 与较新的 Win10 通常已自带；缺失时安装程序会提示下载 |
| 权限       | 普通用户权限即可，**不需要管理员**                 |

### 步骤

1. 到 [Releases](https://github.com/mengyuefeitian/quickpreview/releases/latest) 下载 `QuickPreview-Setup-<版本>-x64.exe`
2. 双击安装，默认装到当前用户目录
3. 安装完成自动启动，托盘出现图标即可使用

> **未签名提示**：安装包没有代码签名，首次运行可能出现 SmartScreen 提示，点「更多信息 → 仍要运行」。这是目前已知最影响首次体验的问题，见[路线图](#路线图)。

卸载：从「设置 → 应用」卸载，或运行安装目录下的 `unins000.exe`。卸载会一并清理 WebView2 缓存目录。

## 使用

| 操作                    | 效果                            |
| --------------------- | ----------------------------- |
| `Space`               | 打开预览（资源管理器前台且有选中项时）；再按关闭      |
| `Esc`                 | 关闭预览                          |
| `←` / `→`             | 文档内上一页 / 下一页；无分页时切换同目录上/下一个文件 |
| `PageUp` / `PageDown` | 文档内翻页                         |
| `↑` / `↓`             | 切换同目录文件                       |
| `Home` / `End`        | 跳到首页 / 末页                     |
| 滚轮                    | 文档内部滚动；当前页已完整显示时翻页            |
| 拖动标题栏 / 边框            | 移动、缩放窗口（位置与大小自动记忆）            |
| 底部 `−` `+` `适应`       | Word / PDF 缩放，默认「适应窗口」= 整页可见  |
| 右上角「单页 / 双页」          | Word / PDF 切换显示模式             |
| 右上角「使用 xx 打开」         | 交给系统默认程序打开（显示真实程序名）           |
| 托盘右键                  | 预览当前选中项、开机自启、清转码缓存、查看日志、关于、退出 |

## 从源码构建

**前置**：.NET 8 SDK、Node.js 18+、[Inno Setup 6](https://jrsoftware.org/isinfo.php)（仅打安装包需要）

```bat
dotnet\build.bat
```

产出：

- 安装包 `installer\QuickPreview-Setup-<版本>-x64.exe`
- 便携版 `publish\QuickPreview.exe`（自带 .NET 运行时与渲染资源，双击即用，无需安装）

手动分步：

```bash
npm install
npm run build:web                                   # 渲染引擎 → dist/renderer
dotnet publish dotnet/QuickPreview/QuickPreview.csproj -c Release -o publish
```

调试渲染引擎时，仓库保留了一套 Electron 宿主，可以脱离资源管理器单独开窗口：

```bash
npm run dev:web     # 终端 1
npm run dev:app     # 终端 2
```

## 架构

```
资源管理器 ──(选中文件 + 空格)──▶ 全局键盘钩子 KeyboardHook.cs  (WH_KEYBOARD_LL)
                                        │ 只在"预览已开"或"资源管理器有选中项"时吞键
                                        ▼
                    读取选中项 ExplorerSelection.cs / DesktopSelection.cs
                                        │ Shell.Application COM（异步投递，绝不阻塞钩子）
                                        ▼
                  无边框浮层窗体 MainForm.cs ──WebView2──▶ Web 渲染层 src/renderer
                                        │                       │
                      本地文件服务 https://qpfile.local/__local ─┘  (支持 Range)
                                        │
                   ffmpeg 转码 MediaTranscode.cs ◀── 页面请求 prepareMedia
```

宿主层是 C# / .NET 8 WinForms，负责钩子、窗口、托盘、文件服务与转码；渲染层是 TypeScript + Vite，跑在 WebView2 里，按文件类型分派到各自的渲染器（`docxview.ts` / `pptx.ts` / `pdfview.ts` / `doc.ts` / `zip.ts` / `mhtml.ts` / `text.ts`）。

<details>

<summary><b>几个实现上不太显然的决定</b></summary>

- **本地文件服务用独立虚拟主机** `qpfile.local`：`SetVirtualHostNameToFolderMapping` 会吞掉该 host 下所有请求，同 host 的 `/__local` 永远触发不了 `WebResourceRequested`。
- **宿主与页面之间不用 host object 传参**：`AddHostObjectToScript` 的方法调用会返回 `0x80070057`，所有「页面要宿主干活」的调用都走 `postMessage` 往返。`CoreWebView2` 成员只能在 UI 线程访问，后台线程回调必须先 `BeginInvoke`。
- **WebView2 用户数据目录显式指向** `%LOCALAPPDATA%\QuickPreview\WebView2`：默认会落在 exe 同目录，升级不覆盖、卸载不清理，安装目录会持续膨胀。
- **canvas 不用 CSS 拉伸**：PDF / 图片的宽高由 JS 算好后写进 `style.width/height`，只设 CSS 宽度会把画面压扁。
- **Word 分页用「内容区高度」**（纸张高 − 上下页边距）作阈值：拿整页高度当容量会让每页多塞约 20% 内容，页页被撑高、高低不齐。
- **docx-preview 不做页眉页脚继承**：按 Word 语义，`sectPr` 未写 `headerReference` 就继承上一节，所以渲染前要先把 `document.xml` 的引用补全（`docxsec.ts`）。

</details>

## 常见问题

<details>

<summary><b>按空格完全没反应</b></summary>

按顺序看 `hook.log` 顶部：钩子是否安装 → 是否收到空格 → 前台窗口是什么 → Shell COM 是否读到选中项。

两个已修复的历史成因：① 在键盘钩子回调里同步调 COM 会被 Windows 拒绝（`RPC_E_CANTCALLOUT_ININPUTSYNCCALL`），读取必须异步投递到 UI 线程；② 程序以管理员权限运行时与普通权限的资源管理器跨 UIPI 边界，COM 调用被拒，`app.manifest` 已固定 `asInvoker`，托盘也有「以普通权限重启」。

</details>

<details>

<summary><b>预览窗口躲在资源管理器后面</b></summary>

Windows 的防抢焦点机制会把非前台进程的弹窗压到当前前台窗口下面，`SetForegroundWindow` 还会静默失败。现在的做法是 `AttachThreadInput` + `HWND_TOPMOST` + 延迟二次置顶（见 `MainForm.ForceToFront`）。

</details>

<details>

<summary><b>预览一片空白</b></summary>

先看 `web.log` 与 `error.log`。最常见的原因是页面脚本在 module 解析阶段就抛异常——那时 `window.onerror` 还没装上，页面会静默全白，所以 `index.html` 里放了一段内联的早期错误捕获。

</details>

<details>

<summary><b>Word 排版和原文档有差异</b></summary>

预览引擎是轻量 OOXML 还原，不是 Word 的排版内核。艺术字、公式、嵌入对象、`.doc` 的原始版式都无法完全还原。已处理的部分：分页边界、目录点线、页眉页脚继承、首页不同、文本框绕排、浮动图片。

</details>

<details>

<summary><b>大视频第一次预览很慢</b></summary>

非原生封装的视频会先用 ffmpeg 转 mp4，结果按路径哈希缓存，第二次秒开。托盘「清转码缓存」可清理。

</details>

## 日志与排障

日志目录：`%LOCALAPPDATA%\QuickPreview\logs`（托盘右键 →「打开日志目录」）

| 文件            | 内容                                        |
| ------------- | ----------------------------------------- |
| `app.log`     | 启动 / 退出、托盘、自启、心跳                          |
| `hook.log`    | 钩子安装、每次空格、前台窗口 class/title、选中项读取过程        |
| `preview.log` | 窗口开关、文件类型判定、置顶结果                          |
| `media.log`   | ffmpeg 命令行 / 耗时 / 退出码、`__local` 请求与 Range |
| `web.log`     | WebView2 初始化、宿主与页面双向消息、页面 JS 异常           |
| `error.log`   | 所有 Error 级别的集中副本                          |

每个文件独立轮转：单文件上限 10MB，保留 2 份备份，内容倒序（最新在最上面），异步落盘不阻塞钩子，Error 级别立即落盘。托盘内有日志查看器，支持切换文件、自动刷新、清空、导出诊断包（全部日志打包到桌面）。

## 路线图

- [ ] 安装包代码签名，消除 SmartScreen 提示
- [ ] 预览窗口内搜索（文本 / Word / PDF）
- [ ] 表格类文件的单元格选区复制
- [ ] 更多压缩包格式：`7z`、`rar`
- [ ] 电子书：`epub`
- [ ] 自定义快捷键与「单击即预览」模式

## 更新日志

完整历史见 [CHANGELOG.md](CHANGELOG.md)。每个版本对应一个 [Release](https://github.com/mengyuefeitian/quickpreview/releases)，附带该版本的安装包。

## 参与贡献

欢迎提 Issue 和 PR。提交 PR 前：

- 修 Bug 请说明复现条件与所看日志；
- 改动渲染逻辑时，请附上改动前后的对比截图或页数/尺寸数据；
- 扩展名分类有两份等价实现——`src/shared/mime.ts`（Web 侧）与 `dotnet/QuickPreview/FileTypes.cs`（C# 侧），改动需同步。

版本号遵循 `主.次.修订`：仅修 Bug 加第 3 位，含新功能加第 2 位，不兼容变更加第 1 位。改版本号要同步 `QuickPreview.csproj`、`setup.iss`、`package.json` 三处。

## 致谢

- [docx-preview](https://github.com/VolodymyrBaydalka/docx-preview) — Word 的 OOXML → DOM 渲染基座
- [PDF.js](https://github.com/mozilla/pdf.js) — PDF 渲染
- [SheetJS](https://github.com/SheetJS/sheetjs) — Excel 解析
- [JSZip](https://github.com/Stuk/jszip) — OOXML / ZIP 容器解析
- [WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) — 原生宿主里的渲染引擎
- [FFmpeg](https://ffmpeg.org/) — 音视频转码

## 许可证

[MIT](LICENSE) © andyann
