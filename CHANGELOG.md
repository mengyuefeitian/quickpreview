# 更新日志

本项目所有值得记录的变更都写在这里。版本号遵循 `主.次.修订`：
**仅修 Bug → 第 3 位 +1**；**含新功能 → 第 2 位 +1**；**架构级重构 / 不兼容变更 → 第 1 位 +1**。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [1.6.0] - 2026-10-21

用户反馈里最集中的四类问题：代码文件不能预览、滚轮翻页乱跳、音视频不自动播放、误报管理员。

### 新增
- **代码与配置文件预览**：141 个扩展名（`.py` `.ps1` `.bat` `.sh` `.java` `.go` `.rs` `.sql` `.toml` …）
  加上 `Makefile` / `Dockerfile` / `LICENSE` 等 16 个无扩展名文件，按空格即可预览并按语言高亮。
  此前前端与宿主各维护一份扩展名表且已漂移，`.ps1` `.bat` 在宿主侧缺失 → 按空格被判"不支持"。
- **音视频自动播放**：打开即播。被浏览器策略拦下时音频记日志、视频降级为静音播放。
- **底部参数标注**：图片显示尺寸与体积，音视频显示分辨率 / 时长 / 编码 / 体积。

### 修复
- **滚轮翻到末页后跳到随机文件**：翻到边界后不再切换文件；滚轮只做文档内翻页，
  切换文件只由方向键触发，且一次只走一格。
- **加载大视频后点关闭就崩溃**：本地文件服务改为按区间流式读取（此前整文件 `ReadAllBytes`，
  并发 Range 请求导致 OOM）。实测 202MB 文件只取 0–1,048,575 共 1MB。
- **桌面文件夹里预览的不是当前选中项**：选中项结果加窗口 class + 父目录双重校验。
- **「需要以非管理员启动」误报**：改为只在确实读不到选中项时提示，且一轮只提示一次。
- **MKV / 大视频预览慢**：先探测编码，能 remux 就不重编码（mkv 2646ms → 534ms，画质零损失）。
- **FLAC 加载慢**：FLAC / MOV 此前被误判为需转码，白白跑一遍 ffmpeg。

### 工程
- 新增 `test-samples/check_ext_parity.py`：校验 `src/shared/mime.ts` 与 `FileTypes.cs` 两份扩展名表一致。
- 新增渲染进程崩溃监听；GPU / 解码这类可自愈的子进程崩溃记 WARN 而非 ERROR。
- 新增 `ByteRangeStream`：限长只读流包装，恒定内存。

## [1.5.3] - 2026-10-20

Word 真实文档（带封面文本框、多节页眉页脚、带书签目录）的排版修复。

### 修复
- **封面文字层叠乱码**：封面标题是文本框（`wps:txbx`），此前按 VML 的绝对坐标原样渲染，
  脱离文档流却不占高度，导致后面的"创建时间 / 网址 / 地址"整块顶上来压在标题上。
  现在按 VML 语义重算坐标，`wrapSquare` 绕排的框还会让锚点段落预留高度。
- **第 2 页起页眉页脚整片丢失**：Word 的语义是"节内没写引用就继承上一节"，预览引擎此前不做继承 →
  6 个节的文档只有第 1 页有页眉页脚。现在渲染前把每节的 `sectPr` 引用补全。
- **封面被硬塞正文页眉页脚**：`<w:titlePg/>`（首页不同）此前的回退逻辑是"取不到首页引用就用默认"，
  导致封面套上正文页眉。现改为指向真正的空白页眉/页脚部件。
- **目录条目折行 / 目录页比 A4 高出 332px**：带书签的目录条目整行包在 `<a>` 里，
  分隔点不在段落的直接子级，切分容器选错导致整行被塞进标题栏。

### 性能
- 文档预处理 1108ms → **402ms**（改用字符串定点替换修补 XML，重打包用 DEFLATE level 1）。

## [1.5.2] - 2026-10-20

### 修复
- **Word 预览页面高低不齐**：分页阈值误用"整页高度"，而页边距是以 `padding` 形式存在的，
  A4 纸只有 930px 能放正文 → 每页多塞 20%，页页被撑高。改用内容区高度，并按真实溢出比例二次收缩。
- **浮动图片撑高页面**：`wp:anchor` 图片外层那个 0×0 的壳并没有真正把图片摘出文档流，
  封面上 602×285pt 的水印图把整页多撑了 181px、把封面切成两页。改为绝对定位 + 相对锚点段落回填坐标。
- 一份 24 页的安装部署手册：12 页 → **24 页，与文档自称"共 24 页"一致**，全部 794×1123px。

## [1.5.1] - 2026-10-20

### 修复
- **Word 目录解析错乱**：`<w:tab/>` 被渲染成 `word-spacing:415pt`（553px，正好一个正文宽），
  标题被挤成三行、点线只剩一个字符。改为重排为 `[标题][点线 flex:1][页码]`。
- **滚轮翻不动**：文档没有任何分页标记时整节塞进好几页，单页模式下滚到节底就再也不能翻页。
  改为"页内还能滚就滚，剩余不足 1/5 屏或到底就翻页"。
- 目录页被撑高 4.6 倍（5103px vs 1123px）导致"适应窗口"算成 25%、字小到看不清。

## [1.5.0] - 2026-10-20

### 新增
- **超大文本分块加载**：首屏 256KB，滚到底部继续读。
- 标题栏按钮显示**真实**默认程序名（Word / 记事本 / 照片 …），而不是"用默认程序打开"。
- 预览窗口支持拖动、边框缩放，并记忆位置与大小。
- Word / PDF 新增单页·双页切换、适应窗口与底部缩放。
- **ZIP 预览**：条目列表 + 搜索 + 行内预览图片与文本。

### 修复
- PPT 内容与实际不符（按坐标还原文本框与图片，母版占位符不再画出来）。
- **安装后预览一片空白**：Inno 的 `[InstallDelete]` 用 `filesandordirs` 删 `webroot\assets` 时，
  目录删除被延迟到最后执行，把刚装进去的新资源一起删掉了。
- docx-preview 的类名由 `options.className` 派生，按 README 写的 `.docx-wrapper` 查会得到 0 个页面 → 整页空白。
- Word「适应窗口」只按宽度算，改为一并考虑高度（与 PDF 一致）。

## [1.4.0] - 2026-10-20

### 修复
- **安装目录膨胀到 303MB**：WebView2 用户数据目录默认落在 exe 同目录，升级不覆盖、卸载不清理。
  改为 `%LOCALAPPDATA%\QuickPreview\WebView2`。303MB → **241MB**。
- **升级安装堆积历史资源**：`webroot\assets` 文件名带内容 hash，Inno 不会删除"新版已不含"的旧文件。
  新增 `[InstallDelete]` 显式清理，assets 从 30+ 个收敛到 10 个。

## [1.3.0] - 2026-10-20

### 新增
- **`.doc` 支持**：自研 CFB / piece table 解析器，直接读 Word 97-2003 二进制正文。
- **托盘「关于」窗口**：版本、运行时、安装目录、支持格式、快捷键。
- PDF 改为**单页横向翻页**。

### 修复
- **PDF 画面被压扁**：所有页纵向堆叠 + CSS 只约束宽度，高度仍用 canvas 像素属性 → 宽高比失真。
  改为一次一页、按容器等比算 scale、宽高都由 JS 写入。
- **PPT 背景整片发黑**：主题色表存 `rgb(...)` 字符串，颜色解析只认 `#RRGGBB`，全部算成黑色。
- **桌面按空格无效**（1.2.0 未修到根因）：桌面 `SelectedItems()` 会把回收站一起返回且常排第一，
  取 `sel[0]` 判为"虚拟项不支持"就整体放弃。改为先过滤 `::{GUID}` 虚拟项。
- `.xlsx` 空工作表导致整个文件预览失败（SheetJS 对无 `!ref` 的表抛异常）。

## [1.2.0] - 2026-10-20

### 新增
- **文件夹预览**：文件数 / 体积统计，后台递归遍历，3 秒超时截断并标注"部分"。
- **桌面空格预览**：桌面 ShellWindow 的 hwnd 与 `SHELLDLL_DefView` 不同，只能按 `LocationName` 定位；
  点击图标后焦点落在 `SysListView32` 上，需要向上找 8 层祖先链判定桌面上下文。

## [1.1.5] - 2026-10-20

### 变更
- **Word 渲染从 mammoth 换成 docx-preview**。mammoth 是语义转换器，丢掉字体、字号、颜色、对齐、
  缩进、表格边框、分页，与原文档差太远。

### 性能
- 首屏 JS **1.1MB → 15.5KB**，页面 ready **9s → 2.2s**：pdf.js / mammoth / docx-preview / xlsx / pptx
  全部改为 `await import()` 按需加载。

### 修复
- WebView2 被初始化了两遍导致"窗口弹出来了但一直没有内容"（异步初始化缺幂等保护）。

## [1.1.4] - 2026-10-20

### 修复
- **预览窗口躲在文件夹窗口背后**：Windows 防抢焦点机制会把握窗插到前台窗口下面。
  改为 `AttachThreadInput` + `HWND_TOPMOST` + 延迟二次置顶。
- **切换文件时串文件、上一个 PDF 疯狂翻页**：PDF 渲染循环没有取消机制。
  新增渲染代次 + `cancelRender()`，每个 `await` 后检查是否已被取代。
- 快捷键语义细化：预览在前台时空格＝关闭；预览已失焦（回资源管理器换了选择）时空格＝关旧的、开新的。

## [1.1.3] - 2026-10-17

### 修复
- **所有音视频预览失败**：宿主对象方法 `QP.prepareMediaAsync` 报 `0x80070057`。改为 `postMessage` 往返通道。
- **转码完成后仍失败**：ffmpeg 在后台线程完成，回传时跨线程访问 `CoreWebView2` 抛异常。统一 `BeginInvoke` 切回 UI 线程。

## [1.1.2] - 2026-10-16

### 修复
- **图片/文档全部预览失败（最核心的一个）**：`SetVirtualHostNameToFolderMapping` 会吞掉该 host 下所有请求，
  同 host 的 `/__local` 永远触发不了 `WebResourceRequested`。改用独立主机名 `qpfile.local`。
- **启动后第一次预览丢失**：WebView2 就绪 ≠ 页面就绪，过早下发 `open` 会被丢弃。改为页面上报 `ready` + 宿主排队补发。
- **页面报错被全部吞掉**：`postMessage(JSON.stringify(...))` 时 `WebMessageAsJson` 是二次编码的 JSON 字符串，
  直接当对象取属性会抛异常。

## [1.1.1] - 2026-10-16

### 修复
- **按空格没反应（根因 A）**：在键盘钩子回调里同步调用 Shell COM，被 Windows 拒绝
  （`RPC_E_CANTCALLOUT_ININPUTSYNCCALL`）。改为回调内只做 Win32 判断，读取动作异步投递到 UI 线程；
  读不到选中项时补发一次空格，不吞用户的操作。
- **按空格没反应（根因 B）**：程序以管理员权限运行时，与普通权限的资源管理器跨 UIPI 边界，COM 被拒。
  新增 `app.manifest`（`asInvoker`）+ 启动检测 + 托盘「以普通权限重启」。
- **覆盖安装失败**：Inno 的 `CloseApplications` 检测早于 `PrepareToInstall`，隐藏窗体的托盘程序会被判"请先关闭实例"
  并静默中止；`[Registry]` 在管理员模式下写 HKCU 返回错误 5 直接回滚安装。

## [1.1.0] - 2026-10-16

### 新增
- **日志系统**：按功能拆 6 个文件、≤10MB 轮转保留 2 份、内容倒序、异步落盘、Error 立即唤醒。
- 内置日志查看器（切换文件 / 自动刷新 / 清空 / **导出诊断包**）。
- 全链路埋点：钩子安装与心跳自愈、每次空格、前台窗口 class/title、Shell COM 遍历、预览开关、
  `__local` 请求、ffmpeg 命令行与退出码、页面 JS 异常回传。
- 版本号单一来源 `AppVersion.cs`（从程序集版本派生）。

## [1.0.0] - 2026-10-16

### 新增
- 首个可安装版本。Electron + Vite + TypeScript 原型：独立窗口 + 自带文件选择器，
  支持图片、文本、PDF、Word、Excel、PPT、音视频（ffmpeg 按需转码）。
- 原生宿主形态（C# / .NET 8 + WebView2）落地：全局空格钩子、Shell COM 读取选中项、
  无边框浮层、虚拟主机映射本地文件服务。

---

[1.5.3]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.5.3
[1.5.2]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.5.2
[1.5.1]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.5.1
[1.5.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.5.0
[1.4.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.4.0
[1.3.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.3.0
[1.2.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.2.0
[1.1.5]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.5
[1.1.4]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.4
[1.1.3]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.3
[1.1.2]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.2
[1.1.1]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.1
[1.1.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.1.0
[1.0.0]: https://github.com/mengyuefeitian/quickpreview/releases/tag/v1.0.0
