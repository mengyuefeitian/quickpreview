# -*- coding: utf-8 -*-
"""按版本批量创建 GitHub Release，并上传各版本安装包。

用法：
  python dev_release_all.py notes        # 只把发布说明导出到 docs/releases/*.md
  python dev_release_all.py create       # 建全部 Release（含资产上传）
  python dev_release_all.py create --no-assets
  python dev_release_all.py create --only v1.5.3

说明：
  - 按版本从旧到新建，保证 GitHub 的 latest 指向 v1.5.3。
  - 资产取自 installer/QuickPreview-Setup-<ver>-x64.exe，不存在就跳过（不报错）。
  - tag 由 GitHub 在创建 Release 时按 target_commitish 自动生成。
"""
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dev_gh as g  # noqa: E402

OWNER = "mengyuefeitian"
REPO = "quickpreview"
FULL = f"{OWNER}/{REPO}"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLER_DIR = os.path.join(ROOT, "installer")
NOTES_DIR = os.path.join(ROOT, "docs", "releases")
LATEST = "v1.5.3"

FOOTER = """
---

**安装包**：`{asset}` — Windows 10 1903+ / 11 x64，自包含 .NET 8 运行时与渲染引擎，安装无需管理员权限。\
安装包未做代码签名，首次运行如遇 SmartScreen 提示请点「更多信息 → 仍要运行」。

完整更新日志见 [CHANGELOG.md](https://github.com/{repo}/blob/main/CHANGELOG.md) · \
[README](https://github.com/{repo}#readme)
"""

# ── 各版本发布说明（tag, 日期, 标题, 正文）──────────────────────────────
V = []

V.append(("v1.5.3", "2026-10-20", "Word 排版三连修：封面文本框、页眉页脚继承、书签目录",
"""\
用一份 24 页的真实文档（6 个节、带封面文本框与书签目录）逐个像素对齐 Word 的一版。

### 修复
- **封面文字层叠乱码**：封面标题是一个文本框（`wps:txbx`），此前按 VML 的绝对坐标原样渲染 ——
  脱离文档流却不占高度，于是"创建时间 / 网址 / 联系地址"整块顶上来压在标题上。
  现在按 VML 语义重算坐标；`wrapSquare` 绕排的框还会让锚点段落预留高度，正文不再钻进框里。
- **第 2 页起页眉页脚整片丢失**：Word 的规则是「节内没写引用就继承上一节」，预览引擎此前完全不继承，
  于是 6 个节的文档只有第 1 页有页眉页脚。现在渲染前把每节 `sectPr` 的引用补全。
- **封面被硬塞正文页眉页脚**：`<w:titlePg/>`（首页不同）此前的回退逻辑是"取不到首页引用就用默认页眉"，
  导致封面套上正文页眉。现改为指向真正的空白页眉/页脚部件。
- **带书签的目录条目折行 + 目录页比 A4 高出 332px**：这类条目整行包在 `<a>`（超链接）里，
  分隔点不在段落的直接子级，切分容器选错导致整行（含点线制表位）被塞进标题栏。

### 性能
- 文档预处理 **1108ms → 402ms**：XML 修补从 DOMParser 改成字符串定点替换（320KB 文档解析+序列化要 200ms），
  重打包用 DEFLATE level 1（STORE 反而更慢，要逐条解压）。

### 验证
- 该手册 24 页全部 794×1123px，首页无页眉页脚、2~24 页齐全，目录 33 项全部单行 + 点线 + 页码右对齐。
- 另抽 3 份版本发布说明书（19 / 29 / 24 页）页眉全覆盖，页脚只缺封面。
- 全类型回归 10/10；安装包静默安装后核对 exe 版本、assets 数量、目录体积。
"""))

V.append(("v1.5.2", "2026-10-20", "Word 预览页面高低不齐（不是 A4）",
"""\
用户反馈：每页高度都不一样，和 Word 里清一色 A4 的观感完全不同。两个根因叠加。

### 修复
- **分页阈值算错**：判断"内容装不装得下"时用的是整页高度，但页边距在渲染结果里是以 `padding` 存在的 ——
  A4 的 1122.5px 只有 **930px** 能放正文，阈值宽了 20%，于是每页都塞进超额内容、每页都被撑高。
  改用「纸张高 − 上下页边距」作为内容区高度，并按真实溢出比例二次收缩（最多 4 轮）。
- **浮动图片仍占文档流**：`wp:anchor` 图片外面那层 `width:0;height:0` 的壳并没有真正把图片摘出文档流，
  封面上 602×285pt 的水印图把所在段落撑到 384px，整页多出 181px、把封面切成两页。
  改为绝对定位并把坐标相对"锚点段落"回填，section 补 `position:relative` 当定位祖先。

### 结果
一份 24 页的安装部署手册：12 页 → **24 页，与文档自称"共 24 页"完全一致**，全部 794×1123px，
逐页内容占用 14%~95%，封面回到单页且底部信息齐全，目录页与双页并排的表格页也都齐平。

### 新增
- 日志增加页面高度自检：`页高 1123px`（齐）/ `页高 1122~1303（不齐 181px）`，回归时一眼可判。
"""))

V.append(("v1.5.1", "2026-10-20", "Word 目录错乱 + 滚轮翻不动",
"""\
真实文档（506 段、1.6MB、36 条目录）暴露的三个互相叠加的根因。

### 修复
- **目录折行、点线消失**：`<w:tab/>` 被渲染成 `word-spacing:415pt` 的 span，415pt = 553px 正好是整个正文宽度，
  "1 概述"被挤成 `1 概` / `述` / `7` 三行，点线只剩一个字符宽。
  现在重排为 `[标题][点线 flex:1][页码]`，层级缩进从 `text-indent` 搬到 `padding-left`（flex 容器上 text-indent 不生效）。
- **目录页被撑高 4.6 倍**（5103px vs A4 1123px），导致「适应窗口」算成 25%、字小到看不清。
- **滚轮翻不动**：该文档既没有 `w:lastRenderedPageBreak` 也没多少 `pageBreakBefore`，
  整节塞进好几页，单页模式下滚到节底就再也不能翻页（实测停在第 4 页）。
  改为按 section 的纸张高度在**段落边界**重新切页（12 页 → 21 页），滚轮策略改为
  "页内还能滚就滚，滚到底或剩余不足 1/5 屏就翻页"。

### 技术要点
- docx-preview 的 `refreshTabStops()` 是 `setTimeout(500ms)` 才回填制表位样式，
  `renderAsync` resolve 时 style 还是空的 —— 必须轮询等到位再处理，否则 36 个制表位全被当成普通制表位跳过。
- 重新切页时要克隆 header/footer（它们是绝对定位在 section 内的）。

### 验证
目录 36/36 项修正；用 CDP 发**真实滚轮事件**从第 2 页一路滚到第 15 页，`scrollTop` 恒为 0；全类型回归 14/14。
"""))

V.append(("v1.5.0", "2026-10-20", "八项实测反馈：缩放、双页、ZIP、窗口记忆、大文件分块",
"""\
一轮集中反馈的八项改进，外加两个打包期才暴露的坑。

### 新增
- **超大文本分块加载**：首屏 256KB，滚到底部继续读，几个 GB 的日志也能开。
- 标题栏按钮显示**真实**默认程序名（Word / 记事本 / 照片 …），而不是笼统的"用默认程序打开"。
- 预览窗口可拖动、可拖边框缩放，位置与大小自动记忆。
- Word / PDF 新增**单页·双页切换**、适应窗口与底部缩放；缩放标签始终显示真实百分比。
- **ZIP 预览**：条目列表 + 搜索 + 行内直接预览图片和文本（不落盘解压）。

### 修复
- PPT 内容与实际不符：按坐标还原文本框与图片，母版占位符（"Click to edit Master…"）不再画出来。
- **安装后预览一片空白**：Inno 的 `[InstallDelete]` 用 `filesandordirs` 删 `webroot\\assets` 时，
  目录删除会被延迟到最后执行 —— 先删旧目录、再拷新文件、最后连新装的目录一起删掉。
  改为 `Type: files` 只删文件、保留目录。
- docx-preview 的类名由 `options.className` 派生，按 README 写的 `.docx-wrapper` 查会得到 0 个页面，
  于是 `pageCount=1`、样式逻辑全部落空 → 整页空白。
- Word「适应窗口」原来只按宽度算（123%，A4 明显高出视口），改为 `min(宽比, 高比)`（54%，整页可见）。
"""))

V.append(("v1.4.0", "2026-10-20", "安装目录瘦身：303MB → 241MB",
"""\
功能上没有新东西，但装完看一眼安装目录就知道该修了：`publish/` 只有 229MB，安装后却 303MB。

### 修复
- **WebView2 用户数据目录落在 exe 同目录**（`QuickPreview.exe.WebView2`）。升级安装不覆盖它、
  卸载程序也只清理自己装过的文件 —— 这份缓存会永久留在用户磁盘上，并且一路膨胀（本次 18MB）。
  改为显式指向 `%LOCALAPPDATA%\\QuickPreview\\WebView2`，该目录已被卸载脚本覆盖。
- **升级安装堆积历史资源**：`webroot\\assets` 的文件名带内容 hash，每次构建都变，
  Inno 不会删除"新版已不含"的旧文件，累积了 30+ 个历史 `index-*.js/.css`。
  新增 `[InstallDelete]` 段清理，assets 收敛到 10 个。

### 结果
303MB → **241MB**；干净卸载 → 重装 → 比对体积与文件清单，无 `QuickPreview.exe.WebView2` 残留。
"""))

V.append(("v1.3.0", "2026-10-20", "PDF 单页翻页、.doc 支持、PPT 重写、桌面修复",
"""\
### 新增
- **`.doc`（Word 97-2003 二进制）支持**：主流解析库都对 OLE2 无能为力，于是自研 CFB 解析器
  （FAT / MiniFAT / 目录），按 FIB 取正文；`fComplex` 时走 0Table/1Table 的 piece table。
  编码不迷信 `fExtChar`（WPS 文档该位与实际不符），改按原始字节分布判断 UTF-16LE 还是 GBK。
- **托盘「关于」**：产品名、版本、运行时、安装目录、支持格式、快捷键。
- PDF 改为**单页横向翻页**，`←` `→` / `PageUp` `PageDown` 翻页，首末页再翻才切文件。

### 修复
- **PDF 画面被压扁**：所有页纵向堆叠、CSS 只约束宽度而高度仍用 canvas 像素属性 → 宽高比失真。
  改为一次只渲染一页，按容器等比算 scale，**宽高都由 JS 写**（绝不用 CSS 拉伸），
  渲染分辨率取 `fit × min(devicePixelRatio, 2)`，并预渲染相邻页 + LRU 缓存。
- **PPT 背景整片发黑**：背景来自 slide → layout → master 三级 `p:bg` 继承，`bgRef` 的
  `schemeClr val="phClr"` 要用 idx 映射到的主题色当基准；而主题色表里存的是 `rgb(...)` 字符串，
  颜色解析只认 `#RRGGBB`，于是全部算成黑色。`toRgb()` 现在三种形态都认。
- **桌面按空格无效**（1.2.0 没修到根因）：桌面 `SelectedItems()` 会把回收站一起返回且常排在第一位，
  旧逻辑取第一个判为"虚拟项不支持"就整体放弃。改为先过滤 `::{GUID}` 虚拟项再取真实路径。
- `.xlsx` 空工作表导致整个文件预览失败（SheetJS 对没有 `!ref` 的表抛异常）。单表兜底即可。

### 其它
- PPT 渲染补齐：主题配色/字体、渐变（含角度换算）、图片填充（裁剪、平铺）、描边、阴影、
  预设几何、项目符号、行距缩进、表格合并单元格、组合形状坐标换算。
"""))

V.append(("v1.2.0", "2026-10-20", "文件夹预览 + 桌面空格预览",
"""\
### 新增
- **文件夹预览**：文件数与总体积统计，后台线程递归遍历，**3 秒超时截断**并标注"部分"
  （实测 3.4MB/24 文件 22ms，2.68GB/452 文件 1104ms，`C:\\Windows` 3 秒截断）。
- **桌面空格预览**。

### 技术要点（桌面为什么难）
- `ShellWindows` 集合确实包含桌面，`Document.SelectedItems()` 也可用 ——
  但**桌面 ShellWindow 的 hwnd ≠ `SHELLDLL_DefView` 的 hwnd**，
  原先"用前台 hwnd 精确匹配"的思路对桌面恒不命中，只能按 `LocationName` 去找。
- 点击桌面图标后焦点落在 `SysListView32` 上而不是 `Progman`，需要向上 8 层祖先链找到 `SHELLDLL_DefView` 才算桌面上下文。
- 试过但不可行的两条路（避免后来者重走）：`WM_GETISHELLBROWSER` 跨进程 `SendMessage` 不映射地址，恒返回 0；
  `VirtualAllocEx + LVM_GETITEM` 读桌面 ListView，本机所有项的 `lParam` 全为 0，拿不到 PIDL。
- 桌面虚拟项（回收站等）路径形如 `::{GUID}`，需单独识别并提示不支持。
"""))

V.append(("v1.1.5", "2026-10-20", "Word 排版重做 + 首屏 JS 减到 15.5KB",
"""\
用户评价"和实际 Word 差太远"。查下来问题不在速度，而在渲染器选型和首屏体积。

### 变更
- **Word 渲染从 mammoth 换成 docx-preview**。mammoth 是语义转换器，只保留标题/段落结构，
  丢掉字体、字号、颜色、对齐、缩进、表格边框、分页。改用 docx-preview 直接按 OOXML 还原排版，
  失败时回退 mammoth（日志会记「回退纯文本」）。

### 性能
- 实测解析库本身差异很小（mammoth 253ms vs docx-preview 155~217ms），
  真正的瓶颈是**首屏 JS 1.1MB**（pdf.js + mammoth + docx-preview + xlsx 全打进一个包），
  页面要解析完才上报 ready，宿主此前的指令只能排队 —— 页面 ready 需要 **9 秒**。
- 全部改为 `await import()` 按需加载：首屏 JS **1.1MB → 15.5KB**，页面 ready **9s → 2.2s**。

### 修复
- 把 WebView2 初始化提前时忘了删构造函数末尾的旧调用，导致创建了两套 `CoreWebView2`，
  页面 ready 上报两次、`_pendingPath` 被第一次消费 → **窗口弹出来了但一直没有内容**。
  异步初始化现在有幂等保护。

### 新增
- `index.html` 内联早期错误捕获：module 解析阶段的异常进不了 `main.ts` 的 `window.onerror`，
  页面会静默全白。现在区分「资源加载失败」与「脚本异常」并回传 `error.log`。
"""))

V.append(("v1.1.4", "2026-10-20", "窗口置顶 + 切换文件串台",
"""\
### 修复
- **预览窗口躲在文件夹窗口背后**：只调 `BringToFront()/Activate()` 不管用 ——
  非前台进程弹窗会被 Windows 的"防抢焦点"机制插到当前前台窗口下面，`SetForegroundWindow` 也静默失败。
  改为 `AttachThreadInput` + `SetWindowPos(HWND_TOPMOST)` + `SetForegroundWindow` 组合，
  并延迟 300ms 再补一次（防资源管理器抢回 z 序），结果写 `preview.log` 便于排查。
- **切换目录/文件时串文件、上一个 PDF 疯狂翻页**：PDF 渲染循环没有任何取消机制，
  打开新文件时旧循环还在往 DOM 追加画布并刷新页码。
  新增渲染代次 `renderGen` + `cancelRender()`，每个 `await` 之后检查是否已被取代，
  PDF 循环内每页都检查并 `pdf.destroy()`。
- **空格语义细化**：预览在前台 → 空格＝关闭；预览已失焦（用户回资源管理器换了选择）→
  空格＝关掉旧的并打开新选中项，而不是单纯关闭。
"""))

V.append(("v1.1.3", "2026-10-17", "音视频预览全线修复",
"""\
装到本机一测，`mp3` / `flac` / `mp4` / `mkv` / `ape` **全部**预览失败。两个连续的坑。

### 修复
- **宿主对象方法不可靠**：`QP.prepareMediaAsync` 报 `0x80070057 (E_INVALIDARG)`（COM 参数封送问题）。
  改为与 `readFile` 同款的消息往返通道：页面发 `prepareMedia` → C# 回 `mediaReady`。
- **转码完成回传跨线程**：ffmpeg 在后台线程完成，`PostWebMessageAsJson` 抛
  "CoreWebView2 members can only be accessed from the UI thread" → `flac`/`mkv`/`ape` 仍失败。
  统一 `BeginInvoke` 切回 UI 线程再登记白名单 + 投递消息。

### 结论
> 跨语言传数据不要用 host object 方法，一律走 postMessage 往返。这条已写进项目约定。

回归：`render_test.py` 11/11 通过（png/txt/docx/xlsx/pptx/pdf/mp3/flac/ape/mp4/mkv）。
"""))

V.append(("v1.1.2", "2026-10-16", "预览窗口能弹出但内容全空白",
"""\
现象很有迷惑性：空格能弹出窗口、文件列表已下发、页面也收到了 open，但内容永远空白。
关键线索是 `media.log` **完全不存在** —— 说明本地文件请求从未进入 C# 处理器。

### 修复
- **虚拟主机名冲突（最核心）**：`SetVirtualHostNameToFolderMapping("app.local", webroot)` 会
  **吞掉该 host 下所有请求**，同 host 的 `https://app.local/__local?p=...` 不会触发 `WebResourceRequested`
  （映射目录里没有该路径 → 直接 404），`AddWebResourceRequestedFilter` 形同虚设。
  改用独立主机名 `qpfile.local`（不映射任何目录），`media.log` 立刻出现 `__local 200 → OK`。
- **启动后第一次预览丢失**：WebView2 就绪 ≠ 页面就绪（JS 解析还要 1~2 秒），
  过早下发 `open` 会被丢弃。改为页面上报 `ready` + 宿主排队补发。
- **页面上报的错误被全部吞掉**：`postMessage(JSON.stringify(obj))` 时 `WebMessageAsJson`
  拿到的是**二次编码**的 JSON 字符串，直接当对象取属性会抛异常。需二次 Parse。
"""))

V.append(("v1.1.1", "2026-10-16", "按空格没反应 / 覆盖安装失败",
"""\
第一次实机验收反馈两个致命问题，都定位到了根因。

### 修复
- **按空格没反应（根因 A）**：`hook.log` 满屏 `RPC_E_CANTCALLOUT_ININPUTSYNCCALL` ——
  `WH_KEYBOARD_LL` 回调运行在 Windows"输入同步调用"上下文，**禁止跨进程 COM 调用**，
  Shell.Application 永远读不到选中项。
  改为回调内只做零成本 Win32 判断（窗口类是否属于资源管理器/桌面/对话框），
  命中才吞键并把读取投递到 UI 线程异步执行；读不到选中项时补发一次空格，保证用户操作不被"吃掉"。
- **按空格没反应（根因 B）**：程序以管理员权限运行时，与普通权限的资源管理器完整性级别不一致，
  跨 UIPI 边界的 COM 被系统拒绝。新增 `app.manifest`（`asInvoker`）+ 启动检测（ERROR 日志 + 托盘气泡）
  + 托盘「以普通权限重启（修复按空格无反应）」一键降级。
- **覆盖安装失败（三层原因）**：
  1. Inno 自带的 `CloseApplications` 检测**早于** `PrepareToInstall`，隐藏窗体的托盘程序没有可见窗口，
     会被判"请先关闭所有实例"并在静默安装下默认 Cancel；
  2. `[Registry]` 在管理员安装模式下写 HKCU 返回错误 5，**直接中断安装并回滚卸载**；
  3. `[Run]` 启动项跟随了安装包的管理员令牌。

### 结果
覆盖安装（服务正在运行）`INSTALL_EXIT=0`；`app.log` 记录「权限级别：普通用户（与资源管理器一致）」；
`hook.log` 钩子已安装且无 ERROR。
"""))

V.append(("v1.1.0", "2026-10-16", "日志系统：按空格没反应可以自己查了",
"""\
功能需求，按版本规则第 2 位 +1。

### 新增
- **分功能日志系统**：`app` / `hook` / `preview` / `media` / `web` / `error` 六个独立文件。
- **存储规则**（每个文件独立生效）：单文件 ≤10MB 即轮转、保留 2 份备份、内容**倒序**（最新在最上面）、
  异步落盘（约 0.8 秒/次）不阻塞键盘钩子、Error 级别立即唤醒落盘。
- **内置日志查看器**（托盘）：下拉切换文件与备份、自动刷新、清空、**导出诊断包**（全部日志打 zip 到桌面）。
- 托盘新增「打开日志目录」，直接用资源管理器打开日志文件夹。
- 全链路埋点：钩子安装与失效自动重装（30s 心跳）、每次空格、前台窗口 class/title、
  Shell COM 遍历与 SelectedItems、预览开关、`__local` 请求、ffmpeg 命令行与退出码、页面 JS 异常回传。
- 版本号单一来源 `AppVersion.cs`（从程序集版本派生），日志与 UI 不再硬编码版本字符串。

### 同时修掉的
- 主窗体常驻隐藏导致 WebView2 无句柄 → 构造时主动创建句柄。
- WebView2 未就绪时 `ShowPreview` 直接 return 导致完全无反馈 → 先抬窗口再排队补发。
- 关闭预览后把焦点还给资源管理器。
"""))

V.append(("v1.0.0", "2026-10-16", "首个可安装版本",
"""\
QuickPreview 的第一个安装包：一个常驻托盘的 Windows 系统级预览服务，**不改你的文件管理习惯**。

装完后照常在资源管理器里选中文件按 <kbd>Space</kbd>，内容即刻浮现在眼前。

### 包含
- **全局空格钩子**（`WH_KEYBOARD_LL`）+ **Shell COM 读取选中项**，只在"预览已打开"或
  "资源管理器前台且有选中项"时接管空格，其余情况一律放行。
- **无边框浮层窗口 + WebView2 渲染引擎**，托盘常驻、无主界面、无需管理员权限。
- 预览格式：图片、文本/代码、PDF、Word（`docx`）、Excel（`xlsx`/`xls`/`csv`）、PPT（`pptx`）、
  压缩包（`zip`）、音频（`mp3`/`flac`/`wav`/`ape`/…）、视频（`mp4`/`webm`/`mov`/`mkv`/…）。
- 内置 ffmpeg：非浏览器原生封装的音视频自动转码并缓存，二次预览秒开。
- 开机自启（写 HKCU Run，无需管理员权限）、`Esc` 关闭、`←` `→` 切换同目录文件、滚轮翻页。

### 安装包
自包含 .NET 8 运行时 + 渲染引擎 + ffmpeg + WebView2 引导器，覆盖安装可原地升级。

> 说明：早期还写过一个 Electron + Vite 的原型，但它自带文件浏览器，
> 解决的并不是同一个问题，因此没有发布安装包 —— 最终形态从一开始就是原生宿主。
"""))


def ver_of(tag):
    return tag.lstrip("v")


def asset_of(tag):
    p = os.path.join(INSTALLER_DIR, "QuickPreview-Setup-%s-x64.exe" % ver_of(tag))
    return p if os.path.exists(p) else None


def body_of(tag, date, title, inner):
    asset = asset_of(tag)
    foot = FOOTER.format(asset=os.path.basename(asset) if asset else "本版本无独立安装包",
                         repo=FULL)
    return "## %s — %s\n\n_发布日期：%s_\n\n%s%s" % (tag, title, date, inner.strip(), foot)


def dump_notes():
    os.makedirs(NOTES_DIR, exist_ok=True)
    for tag, date, title, inner in V:
        p = os.path.join(NOTES_DIR, tag + ".md")
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(body_of(tag, date, title, inner))
        print("wrote", os.path.relpath(p, ROOT))
    print("共 %d 个版本" % len(V))


def create(only=None, assets=True):
    # GitHub 的 latest = 最新的非 draft/prerelease，所以必须从旧到新建
    order = sorted(V, key=lambda x: [int(n) for n in ver_of(x[0]).split(".")])
    ok, fail = [], []
    for tag, date, title, inner in order:
        if only and tag != only:
            continue
        body = body_of(tag, date, title, inner)
        st, d = g.call("GET", f"/repos/{FULL}/releases/tags/{tag}")
        if st == 200:
            print("[%s] 已存在 %s" % (tag, d["html_url"]))
            rel = d
        else:
            st, d = g.call("POST", f"/repos/{FULL}/releases", {
                "tag_name": tag,
                "target_commitish": "main",
                "name": "QuickPreview %s — %s" % (ver_of(tag), title),
                "body": body,
                "draft": False,
                "prerelease": False,
                # 明确指定 latest，避免创建顺序影响「最新版本」指向
                "make_latest": "true" if tag == LATEST else "false",
            })
            if st not in (200, 201):
                print("[%s] FAIL" % tag, st, json.dumps(d, ensure_ascii=False)[:300])
                fail.append(tag)
                continue
            rel = d
            print("[%s] created %s" % (tag, rel["html_url"]))

        if not assets:
            ok.append(tag)
            continue

        ap = asset_of(tag)
        if not ap:
            print("[%s] 无安装包，跳过资产" % tag)
            ok.append(tag)
            continue
        name = os.path.basename(ap)
        if any(a["name"] == name for a in rel.get("assets", [])):
            print("[%s] 资产已存在 %s" % (tag, name))
            ok.append(tag)
            continue
        data = open(ap, "rb").read()
        up = rel["upload_url"].split("{")[0]
        print("[%s] 上传 %s (%.1f MB) …" % (tag, name, len(data) / 1048576), flush=True)
        t0 = time.time()
        st, d2 = g.call("POST", "%s?name=%s" % (up, urllib.parse.quote(name)), data,
                        ctype="application/octet-stream")
        if st not in (200, 201):
            print("[%s] FAIL upload" % tag, st, json.dumps(d2, ensure_ascii=False)[:200])
            fail.append(tag)
            continue
        print("[%s] ok %.1f MB in %.0fs" % (tag, d2["size"] / 1048576, time.time() - t0), flush=True)
        ok.append(tag)

    print("\n成功 %d / 失败 %d" % (len(ok), len(fail)))
    if fail:
        print("失败列表：", ", ".join(fail))
        return 1
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "notes"
    if cmd == "notes":
        dump_notes()
        return 0
    if cmd == "create":
        only = None
        if "--only" in sys.argv:
            only = sys.argv[sys.argv.index("--only") + 1]
        return create(only=only, assets="--no-assets" not in sys.argv)
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
