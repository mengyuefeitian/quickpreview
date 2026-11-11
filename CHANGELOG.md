# 更新日志

本项目所有值得记录的变更都写在这里。版本号遵循 `主.次.修订`：
**仅修 Bug → 第 3 位 +1**；**含新功能 → 第 2 位 +1**；**架构级重构 / 不兼容变更 → 第 1 位 +1**。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [1.9.2] - 2026-11-11

### 修复

- **Word 预览：符号标记图标不再碎图（EMF/WMF 元文件光栅化）**
  手册里「警告 / 注意 / 说明 / 窍门」这类标记常以 EMF/WMF 元文件插图，Chromium 根本不解码，
  `<img>` 的 `naturalWidth` 恒为 0 —— 表现为一整排碎图标。现在渲染前由宿主的 GDI+ 把
  元文件重放成 3 倍 PNG（最长边封顶 4000px）顶掉原条目，同时把 `[Content_Types].xml` 里
  `emf`/`wmf` 的 ContentType 改成 `image/png`（docx-preview 的 MIME 就是从这里取的），
  页面侧照常按 PNG 渲染。裸 WMF 补 22 字节 Aldus 头再试一次。实测 4 个标记图标 4/4 成功。

- **Word 预览：章节编号整体 +1 / 单页模式下编号从 0 起**
  三个独立原因叠在一起，缺一个都修不干净：
  ① 源文档里「目录」这类段落的 `pStyle` 沿 `basedOn` 链指向 `numId=0`（Word 里表示
    「显式不要编号」），而 docx-preview 的 `processStyles` 用 `mergeDeep(子, 基)` 合并样式，
    **基样式反向覆盖子样式**，`numId=0` 被 heading 的 `numId=1` 盖掉 ⇒ 整篇章节号 +1。
    预处理给这类段落补一条段落级 `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>`
    —— docx-preview 取编号时是 `elem.numbering ?? style?.paragraphProps?.numbering`，
    段落级存在就直接生效，不参与样式合并。
  ② 编号是纯 CSS 计数器实现的，而计数器只在**生成了盒子**的元素上累加。单页模式原来用
    `display:none` 藏非当前页，前面几十页的标题直接不计数 ⇒ 第 5 章显示成「1」、5.1 成「0.1」。
    改成 `position:absolute + left:-99999px + visibility:hidden`：仍参与布局（计数器连续），
    但不可见、不响应鼠标，负 left 也不会产生滚动条。顺带所有页常驻已布局状态，翻页更快。
  ③ 排版容器 `.docx-preview-wrapper` 原来设了 `display:contents` 好让它不参与布局，可
    docx-preview 的 `counter-reset: docx-preview-num-…` 恰好写在这个元素上 ——
    不生成盒子 ⇒ 复位失效 ⇒ 章节号从 0 起（真机上就是「0.1 读者对象」）。
    改为让 wrapper 自己当 flex 排版容器（`.docx-stage > .docx-preview-wrapper`）。

- **Word 预览：页脚页码每页都印缓存值（第 19 页，共 19 页）**
  页脚里的 PAGE / NUMPAGES 是复杂域：`fldChar begin → instrText " PAGE " → separate → 缓存结果 → end`。
  docx-preview 丢掉指令、只渲染缓存值，于是每一页都印同一个数。预处理器把整个域换成哨兵字符
  （`\uE000P\uE001` / `\uE000N\uE001`），分页结束后逐页回填本阅读器的页号与总页数 ——
  页眉页脚是每页一份副本，同一个哨兵在不同页里取不同值。口径是「本阅读器的第几页」：
  与 Word 的绝对页码仍可能有差异（排版引擎不同），但不再是每页一个固定数字。

- **Word 预览：分页把内容摊薄，一页只装六七成**
  四个问题串在一起，全在 `docxview.ts` 的分页器里：
  ① `renderAsync` 返回时图片还没解码，`getBoundingClientRect()` 高度是 0 ⇒ 带图的块被当成
     「不占地方」（实测某节估算 790px、图片就位后实际 2319px）。量尺寸前补一步
     `waitAssetsReady`：等图片 `load`/`error` + `document.fonts.ready`。
  ② 估算用 `blockHeight`（rect 高 + 上下 margin）逐块累加，而相邻段落的上下外边距会折叠成
     `max(上, 下)`，等于把行距算两遍。改成「累计底边之差」。
  ③ 一旦某页溢出就按 `inner²/actual` 缩小可用高度重切，`actual` 到 1300px 时 limit 就从 931
     掉到 660 —— 好页也被切碎。删掉这套缩放，改成「先放进去、实测溢出才退回」。
  ④ 退回时如果当前页刚建好，会留下一个空页。现在退回的前提是本页还剩别的块。
  结果：同一份手册的页数从 128 页降到 118 页，空页 4 个 → 0，溢出页 3 个 → 0，
  「页面被撑高」告警消失。

- **资源管理器选中项不跟随方向键**
  预览里按 ↑/↓ 换文件时，文件夹里的选中高亮一直停在最初那个文件上，名字相近的一批文档
  根本分不清看到第几个。现在每次换文件都让宿主调 `ShellFolderView.SelectItem`
  （`SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE`，不加 `SVSI_FOCUSED`
  以免抢焦点），Win11 多标签页仍按活动标签定位；同一路径 400ms 内去重，避免连按时把
  资源管理器 UI 线程打满。路径必须命中本次预览的文件列表才会执行，避免误改其它窗口的选中项。

- **「检查更新」失败的日志现在能看出真正原因**
  原来网络失败只记外层异常，而 `HttpRequestException` 的 Message 恒为
  `The SSL connection could not be established, see inner exception.` —— 真正的原因
  （证书链 `PartialChain`、超时、代理拒绝、DNS）全在内层，等于没记。现在把整条异常链
  摊平成一行写入日志，并把「证书校验失败」从「连不上网」里单独区分出来，界面提示也一并改写
  （证书问题重试无用，得换网络或找网管，不该让用户反复点重试）。

  起因是一次实测：某台机器上托盘「检查更新」报 SSL 失败，日志里只有上面那句无用的话，
  得另写探测程序才查出是本机 Windows 根证书存储缺了 GitHub 证书链要用的 CA（那台机器在域内，
  组策略 `DisableRootAutoUpdate=1` 关掉了根证书自动更新），于是任何使用该 CA 的站点在 .NET 里
  都报 `PartialChain`。程序拒绝连接的行为是正确的，证书校验不能为「让更新能用」而放宽 ——
  更新器一旦能跳过校验，就等于开了任意代码执行的口子。

### 变更

- 分页入口统一到 `prepareDocx()`：页眉页脚继承、`numId=0` 修正、页码域换哨兵、EMF 转 PNG
  一次解包/重打包完成，日志汇总成一行（清编号 N / 页码域 N→回填 M / EMF→PNG N）。

## [1.9.0] - 2026-11-03

### 新增

- **自动更新：检查 → 下载 → 校验 → 静默安装 → 重启，一条链路走完**
  托盘菜单新增「检查更新…」与「自动检查更新」开关；开启时启动 60 秒后查一次，
  之后每 6 小时查一次（间隔在 `config.json` 的 `UpdateIntervalHours`）。

  发现新版本时弹一个窗口：显示版本号、发布日期、更新说明（Markdown 轻量清洗后展示），
  可以「立即更新 / 稍后提醒（24 小时）/ 跳过此版」。「立即更新」带进度条与实时速度，
  下载完成校验通过后才启动安装包，装完自动把程序重新拉起来，并提示「已更新到 vX.Y.Z」。

  **数据源就是 GitHub Releases**：`/releases/latest` 拿版本号、正文与资产，
  资产里 GitHub 会带 `digest: sha256:…`，正好用来做完整性校验。

  **真正的难点不是下载，是"把自己换掉"**。程序是托盘常驻单实例，安装包写文件时
  自身 exe 正被占用，所以顺序必须是：应用退出 → 安装包覆盖 → 安装包重新拉起。
  实现上没有另起一个 updater 进程（自包含发布再加一个 exe 要多 60MB），而是复用
  Inno 已有的能力：安装包 `InitializeSetup` 里本来就 `taskkill` 旧实例，
  再加一条带 `Check: ShouldRelaunchAfterUpdate` 的 `[Run]`（带 `/relaunch=1` 才执行），
  用 `runasoriginaluser` 拉起新实例 —— 这一步不能省：若继承管理员令牌启动，
  新进程与资源管理器不在同一完整性级别，读选中项会被 UIPI 拒绝，表现为按空格没反应。

  **安全边界**（更新器被劫持等于任意代码执行，这几条不能省）：
  ① 只接受 HTTPS，且下载域名限定 `github.com` / `objects.githubusercontent.com` / `*.githubusercontent.com`；
  ② 下载大小必须与 API 声明一致，有 sha256 digest 就强制校验，不匹配直接丢弃；
  ③ 只运行本仓库 `releases/latest` 里挑出来的那个 `.exe` 资产；
  ④ 先写 `.part` 再改名，中断/取消都不会留下"看起来完整"的文件。

  **两个必须说清的边界**：
  · 只有**安装版**能一键静默更新。便携版（例如直接跑 `publish\QuickPreview.exe`）
    点「立即更新」会打开下载页 —— 静默覆盖一个正在运行的绿色版目录不是用户预期的行为。
  · 依赖 GitHub 可达。断网/代理拦截时自动检查**静默失败**（只记 WARN，不弹窗），
    手动检查才会把失败原因显示出来。

  **踩坑**：
  ① 版本比较必须**逐段按数值**：字符串比较会认为 `1.10.0 < 1.9.0`，
     后果是"永远提示有新版本"或者"新版本永远升不上去"。
  ② 自动检查不能在启动瞬间跑：WebView2 冷启动要几秒，抢 IO 会让首次预览更慢，
     所以延迟 60 秒；发现更新时窗口**不激活**（`ShowWithoutActivation`），
     避免把用户正在打的字打断。
  ③ 自动检查失败也要记 `LastUpdateCheckUtc`，否则断网时会每分钟重试一次。

## [1.8.0] - 2026-11-02

### 新增

- **支持 RAR 压缩包预览（RAR5 / RAR4）**
  以前 .rar 直接落到「不支持预览该类型」。现在按空格就能看到包内完整清单：
  路径、大小、压缩后大小、修改时间，支持筛选；以「存储」方式打包的条目点开即可看内容
  （文本 / 图片），真正压缩过的条目会明确说明原因，而不是给个空面板。

  **RAR 和 ZIP 不是一回事**：ZIP 的中央目录在文件尾部，一跳就能读到索引；RAR 没有中央目录，
  只能从文件头开始把块头一个个走完。RAR 的压缩算法也是专有格式，浏览器里没有解压器
  （`DecompressionStream` 只有 deflate/gzip），所以内容解码这条路走不通，只做结构读取。

  大包（>64MB）走区间读取：块头里带 `DATA_SIZE`，数据区整块跳过，
  45MB 的包只读 3.75MB 块头（16 次请求），绝不整包载入 —— 与 1.7.0 修的闪退是同一类防护。

  **踩坑（三处都会导致全盘错位）**：
  ① RAR5 的变长整数是 **LEB128**（低 7 位是数据、bit7 续位、低位在前），
  不是「首字节写明后续字节数再大端拼接」。按后者解，`HEAD_SIZE` 会从 13 变成 90，之后全错。
  ② `HEAD_SIZE` 从 **HEAD_TYPE 字段**起算，到 extra area 结束；数据区在它之后，
  所以 `dataStart = headTypePos + headSize`。把 HEAD_SIZE 当成整块长度会漏掉 CRC 与自身共 8 字节。
  ③ 结束块除了 type=5、flags 还多一个 `END_OF_ARCHIVE` 字段，少了它 7z 直接报 Headers Error。
  另外 RAR4 若没写 `LONG_BLOCK`，数据长度得取 `PACK_SIZE` 自己跳过，否则数据区会被当成下一个块头，
  后面的条目全部丢失（实测第二个文件就没了）。

## [1.7.0] - 2026-10-27

### 新增

- **加密 PDF 支持在预览页输入密码**
  以前加密 PDF 只会显示一句「预览出错：No password given」。现在预览区会出现密码层：
  输入框（`type=password`）+ 打开 / 取消，回车提交、Esc 取消。
  密码错时 pdf.js 会以 `reason=2` 再次回调，提示层原地显示「密码不正确，请重试」
  并解锁输入框；输对了直接进入翻页浏览，密码层自动移除。
  取消则抛出「已取消输入密码」，不会把 pdf.js 的 worker 挂住。

  **踩坑**：pdf.js 4.x 的 `getDocument()` **不认 init 里的 `onPassword`**
  （类型定义和实现里都没有），必须先拿到 `loadingTask` 再赋 `loadingTask.onPassword`。
  写在 init 里不会报错，只是永远不会被调用，最后以 `PasswordException: No password given`
  失败 —— 看着像"密码没传进去"，实际是回调没挂上。
  另外传 `updatePassword(new Error(...))` 取消时，pdf.js 会把原始信息包成
  `PasswordException("No password given")`，所以取消状态得自己记，不能用异常文本判断。

### 修复

- **预览 1.5GB 压缩包时程序直接消失**
  根因不是"解析太慢"，是**整包读进了内存**：`preview.ts` 对所有压缩包无条件
  `fetch(__local)`，没有 `Range` 头 ⇒ 宿主回 200 全量 ⇒ 1.5GB 响应体一次性塞给
  WebView2 ⇒ 浏览器进程被打爆、连带宿主抛 `SEHException` 退出。
  代码里原来的 512MB 上限写在 `renderZipView` 开头，可那时文件**已经读完了**，救不了。

  现在按大小分流（阈值 64MB）：
  - 小包：维持 JSZip 整包内存，行为不变；
  - 大包：绝不整包读。先读文件尾 128KB 找 EOCD（含 ZIP64 定位器），
    再按 4MB 分片抓中央目录（上限 32MB），点开某个文件时才抓那一个条目的
    本地头 + 数据区，用 `DecompressionStream('deflate-raw')` 解压（支持存储 / Deflate）。
  实测 1.5GB 包的请求序列是 131072 + 59 + 30 + 27 字节，55ms 出清单。

  **两个配套改动**：
  - 区间用查询参数 `&r=start-end` 传给宿主，不用 `Range` 请求头 ——
    自定义 Range 头会触发 CORS 预检，宿主没有 OPTIONS 分支，预检一失败整条通道就废了；
  - 宿主加兜底：**任何 200 全量响应超过 256MB 直接 413**。预览侧已经不会发这种请求，
    这条只是防止将来某条路径重犯同一个错误（宁可弹错误也不能让程序消失）。

- **中央目录解析补上本地头偏移**（`ZipDirEntry.offset`），ZIP64 扩展字段按规范顺序消费。

### 测试

- `dev_zip_range_test.py`：把区间读取换成"读本地文件"跑纯逻辑，与 Python `zipfile` 逐项对照。
  四个样本：内置 `sample.zip`、跨分片解压（12MB 条目）、70000 条目（ZIP64 + 6.7MB 目录，
  逼出 4MB 分片）、**1.5GiB 稀疏包**（本地头在 0、中央目录写在 1.5GiB 偏移处，
  磁盘只占几 KB）。共 27 项断言全通过。
- `dev_pdf_pass_test.py`：`make_encrypted_pdf.py` 现场按 PDF 规范（V=1/R=2/40-bit RC4）
  生成加密样本 → 真 pdf.js 验 `onPassword` 的三种回调（reason=1 / reason=2 / 取消）→
  jsdom 里验密码层的输入、回车、取消、重试提示、销毁。共 20 项断言全通过。
- `dev_v170_probe.py`：走真实 WebView2 + CDP，16 项断言 —— 1.5GB 包不崩、列出条目、
  给出"按需读取索引"提示、点开条目能读出内容；加密 PDF 出密码层、密码错提示、
  输对后渲染出第 1 页。
- 常规格式回归 7/7（png/txt/docx/xlsx/pptx/pdf/zip）。

### 已知限制

- 大包内只能预览**存储 / Deflate** 两种算法、且压缩后 ≤64MB 的条目；
  其它算法在浏览器里本来也没有解压器（与改建前一致）。加密条目仍只列清单。
- 大包的中央目录超过 32MB（约 60 万条目以上）时只解析前面能读到的部分。

---

## [1.6.8] - 2026-10-24

### 修复

- **重命名文件/文件夹时，空格被预览抢走，改名失败**

  用户在资源管理器里按 F2 改名，输入法选字是按空格的。全局钩子只判断
  「前台窗口是不是文件窗口」，而重命名框就在文件窗口里面 —— 于是空格被吞掉去开预览，
  输入法永远收不到这一下，字选不上，改名自然失败。英文名想打个空格（`my file.txt`）同样被打断。

  修法：吞键之前先问一句「此刻是不是正在某个输入框里打字」，是就放行。
  新增 `TextEntryProbe`（纯 Win32，无 COM，可在键盘钩子的输入同步调用上下文里安全执行）：

  - 取前台窗口所属线程的焦点控件（`GetGUIThreadInfo`），看它的类名是不是编辑框
    （`Edit` / `RichEdit*` / `*EditBox` / `Scintilla` / `TEdit`）。
    资源管理器的重命名框和地址栏就是 `Edit`，搜索框是 `SearchEditBox`。
  - 类名不认识时再看有没有**可见光标**（`GUITHREADINFO.hwndCaret` + `rcCaret`），
    兜住新版本资源管理器或第三方外壳换了控件实现的情况。
  - 判断失败一律当作「没在输入」，宁可保持原来的预览行为，也不能把空格彻底废掉。

  两处分支（预览未打开 / 预览已失焦后重新按空格）都加了这道判断，
  日志里会记一行 `空格放行（正在输入文字）：焦点在输入框（class=Edit）`，方便以后排查。

### 测试

- 新增 `test-samples/dev_text_entry_test.py`：现场建一个 console 工程把 `TextEntryProbe.cs`
  编进去，用原生 `CreateWindowEx("Edit")` 造一个真编辑框断言，19 项全通过：
  - 8 个编辑框类名判为「输入中」，7 个非编辑框类名（`CabinetWClass`、`DirectUIHWND`、
    `SHELLDLL_DefView`、`Chrome_WidgetWin_0`、`SysListView32`、空串、null）判为「没在输入」；
  - 焦点在 `Edit` → 判为输入中；焦点移开后 → 恢复可预览；
  - 对着真实资源管理器窗口（`CabinetWClass`）→ 判为可预览，确认没有过度拦截。

- 新增 `test-samples/dev_rename_space_test.py`：真实路径用例（`explorer /select` →
  真按 F2 → 真按空格 → 读重命名框文本是否多出空格、是否误弹预览窗）。
  本机常驻的截图工具会不停抢前台，F2 到不了资源管理器，脚本会以退出码 3 明确报告
  「环境不具备」而不是假装失败；关掉抢前台的程序即可实跑。

### 已知限制

- 判断依据是「焦点控件」与「光标」，不是输入法组词状态（跨进程 `ImmGetContext`
  在低层钩子里有阻塞风险，一旦超时 Windows 会直接摘掉钩子）。
  焦点在文件列表本身、用输入法做键入定位（type-ahead）时按空格仍会开预览。

---


## [1.6.7] - 2026-10-22

### 新增

- **`.mhtml` / `.mht` 单文件网页预览**（[#5](https://github.com/mengyuefeitian/quickpreview/issues/5)）

  以前 `.mhtml` 只是被当纯文本读，用户看到的是满屏 MIME 头和 `=3D` 转义字符 ——
  等于没解析这个格式。现在按 MIME `multipart/related` 真正拆开：

  - 按 `boundary` 切 part，跳过第一个分隔线之前的 preamble（`This is a multi-part message…`）；
    `boundary` 头被折成多行时按续行规则拼接。
  - 解出第一个 `text/html` 作主文档：`Content-Transfer-Encoding` 支持 `quoted-printable`
    （`=XX` 字节 + `=` 接换行的软换行）与 `base64`；`charset` 按声明解码，
    `gb2312` / `gb18030` / `cp936` 统一归一化为 `gbk`（TextDecoder 里它们就是同一套）。
  - 其余 part 转成 `data:` URI，同时建立 `cid:<Content-ID>` 与 `Content-Location` 两套索引，
    把正文里的 `cid:` 引用和绝对地址引用一起替换掉。
  - 渲染用 `srcdoc` + `sandbox="allow-scripts"`（**不给** `allow-same-origin`）：
    原页面的脚本能跑，但处于不透明源，读不到父页面，原页面的 CSS 也不会染到预览界面。

- 状态条显示片段数、内联资源数、外链资源数与文件体积。

### 修复

- **解析时把 MIME preamble 当成了一个资源**

  第一个 `boundary` 之前的说明文字（`This is a multi-part message in MIME format.`）被当成
  一个 part 计进片段数。真实样本的 preamble 是空的，所以一直没暴露；补了合成样本才现形。

- **外链资源数把正文超链接也算进去了**

  原来的统计是数 `https://` 出现次数，一篇满是外链的新闻页会被误报成「部分外链需联网」，
  实际图片早已全部内联。改为只统计 `img` / `script` / `link` / `source` / `video` / `audio` /
  `iframe` / `embed` 的 `src|href` 与 CSS `url()` 这类真正会去取的位置。

### 测试

- 新增 `test-samples/dev_mhtml_test.py`：esbuild 把 `mhtml.ts` 打成 CJS 在 node 里跑纯函数，
  与 Python 标准库 `email` 逐项对照（part 数、doctype、`cid:` 残留、data URI 数、体积、标题解码）。
  除 Downloads 里的真实样本（24 part / 18 图 / 5 CSS，7 项断言）外，
  额外现场生成两组合成样本覆盖真实文件没有的分支：`base64 + gb2312 + cid:`、
  `quoted-printable + Content-Location 绝对地址`。三组共 21 项断言全通过。

- 新增 `test-samples/mhtml_render_probe.cjs` 与 `mhtml_iframe_probe.cjs`：把解析结果落成独立 HTML，
  分别以「直接打开」与「srcdoc + sandbox iframe」两种方式交给无头 Edge 截图，
  两张图字节级相同 —— 确认沙箱 iframe 这条链路在真实 Chromium 里渲染效果与直接打开一致。

- 新增 `test-samples/dev_preview_probe.py`：按文件打印一次 `--preview` 期间的全部新日志，
  用于崩溃现场取证（哪个环节最后一条、之后多久断的）。

- 新增排查钩子 `QP_BROWSER_ARGS`（`MainForm.cs`）：向 WebView2 追加任意 Chromium 参数，
  与已有的 `QP_DEV_CDP_PORT` 同风格，只在显式设置时生效。
  本次就是靠它定位到「预览页其实渲染完成了，崩的是浏览器进程」——之前
  `AdditionalBrowserArguments` 被代码显式赋值，环境变量根本传不进去。

- `test-samples/check_ext_parity.py` 补上 `WEBARCHIVE_EXT` 分组（漏加会误报「只在 FileTypes.cs 里有」），
  两侧现为 143 个扩展名 + 16 个特殊文件名完全一致。

### 已知限制

- 存档里的资源指向外网且文件内没有对应 part 时，仍按原地址联网取；宿主页面是 `https://app.local`，
  所以 `http://` 的外链图片会被浏览器按混合内容拦掉（本篇实测样本所有图片均已内联，不受影响）。
- `.mht` 与 `.mhtml` 视作同一格式；不处理嵌套的 `multipart/alternative` 子包，
  只取顶层 part（邮件另存的复杂存档可能只显示纯文本分支）。
- CSS 里的相对 `url()`（背景图、字体）不会跟着内联，会按 `data:` 基准解析而失效；
  目前只保证正文 `<img>` 与 `<link rel=stylesheet>` 完整。

### 环境说明（非代码问题）

本机是无显卡的虚拟机，WebView2 的 GPU 进程从启动起就在崩溃重启（`GpuProcessExited` exitCode=7），
最终把浏览器进程一起带走（`BrowserProcessExited` exitCode=0x80000003）。
写这个版本期间该现象已扩散到 `sample.txt` / `sample.pdf` —— 用未改动的 1.6.6 安装版同样复现，
故判定为环境噪声而非回归。同一文件交替统计：

| 场景 | 通过率 |
|---|---|
| 1.6.7 `sample.png` | 3/5 |
| 1.6.7 真实 mhtml（1.0MB） | 0/6 |
| 1.6.6 安装版同一 mhtml（按纯文本渲染） | 1/3 |

`QP_BROWSER_ARGS=--disable-gpu` 实测能让页面正常渲染完成
（日志：`读取 1026279 字节，耗时 43 ms` → `渲染完成：…（耗时 165 ms）`），
但崩溃风暴仍在，稳定性没质变。

---

## [1.6.6] - 2026-10-22

### 修复

- **预览窗口全局置顶，挡住别的程序，没法切过去做对比**

  以前预览窗口是 `TopMost = true` 加 `SetWindowPos(HWND_TOPMOST)`，一旦弹出就压在整个桌面上，
  用户想把 Word 或另一个资源管理器窗口切上来对照，预览窗永远挡在前面，点不掉也拖不开。

  现在彻底不用全局置顶：

  - 去掉 `TopMost`，改为设置 **owner 关系**（`GWLP_HWNDPARENT` 指向触发预览的那个资源管理器窗口）。
    owned 窗口由系统保证贴在 owner 之上；owner 不在前台时，它也不会越到别的程序前面 ——
    正好是「只浮在当前文件所在的资源管理器上层」。
  - 新增前台变化跟随：切回那个资源管理器窗口时，预览窗自动浮到它上面（`SWP_NOACTIVATE`，不抢焦点）；
    切到 Word / 浏览器 / 另一个资源管理器窗口时什么都不做，预览窗自然沉到后面。
  - 宿主资源管理器窗口关闭后自动解除 owner 关系。
  - 实测：owner 窗口被关掉时系统只解除关系，不会连带销毁预览窗，托盘和空格键照常在。

- **开发与自动化测试时，弹出的预览窗口会抢焦点、挡在别人前面**

  `--preview` 排查入口新增 `--quiet`：内容照常渲染，但窗口用 `SW_SHOWNOACTIVATE` 显示，
  不抢焦点、不参与层级跟随。回归脚本（`render_test.py`、`perf_test.py`、`dev_*.py`）已统一切到该模式。

### 测试

- 新增 `test-samples/dev_topmost_check.py`：直接读窗口扩展样式位，确认 `WS_EX_TOPMOST` 不存在。
  对照组（1.6.4 安装版）为 `0x00010008`（置顶），新版为 `0x00010000`。
- 新增 `test-samples/dev_zorder_check.py`：三个场景 —— 打开即在前 / 切回资源管理器时浮到它上面且不抢焦点 /
  切到记事本时预览窗留在其下方。

---

## [1.6.5] - 2026-10-22

### 修复

- **播放 GB 级 mp4 时整个程序崩溃、托盘图标一起消失**（issue #5）

  用户日志里三次崩溃都发生在视频首包返回之后，且 `__local` 记的是这样一行：

  ```
  __local 206 xxx.mp4：Partial Content，1,975,618,907 字节（0–1,975,618,906 / 共 1,975,618,907）
  ```

  播放器首包固定发 `Range: bytes=0-`（没有结束位），本地文件服务按字面把**整个文件**
  塞进一个响应体。WebView2 要吃下 1.9GB，浏览器进程被打爆、连带宿主在
  `PInvoke.DispatchMessage` 抛 `SEHException` 直接退出 —— 用户看到的就是「程序没了」。
  同一台机器上 325MB / 57MB / 38MB 的片子都正常，1.3GB 与 1.9GB 必崩，
  **分界线在 GB 级、与编码（那几个都是 H265）无关**。

  现在单次响应最多 8MB，剩下的由浏览器继续发 `Range: bytes=<end+1>-`；
  对拖动进度条没有影响 —— 206 分片本来就是播放器的正常工作方式。
  区间计算抽成纯函数 `FileRange.Resolve`，配 17 条离线断言（含 GB 级首包/续包/末段/越界）。

- **预览引擎崩了之后，宿主要一起死**
  `SEHException` 会绕过 `Application.ThreadException`，一路冒到
  `AppDomain.UnhandledException`，而那里只能记日志、拦不住退出。
  现在消息循环外接了一层自愈：接住异常 → 重建主窗体 → 气泡提示
  「预览引擎异常退出，已自动恢复」，托盘和全局空格键继续可用；
  10 分钟内最多恢复 3 次，避免真的坏掉时死循环。

- **退出路径上再记日志会抛 `ObjectDisposedException`**
  `Log.Shutdown()` 之后落盘线程已停、`_wake` 已释放，此时任何 `Log.E`
  （崩溃自愈正要写日志）都会在异常处理里再抛一次。现在停止写入后改为同步落盘，
  这条日志既不会丢、也不会把进程带走。

- **`media.log` 看不到播放器到底要了哪一段**
  `__local` 记录里补上请求的 `Range` 原文；被分块时额外记一行
  「本次 N 字节（客户端本可拿 M 字节）」，下次排查不用再靠猜。

## [1.6.4] - 2026-10-21

### 修复

- **Word 长表格没有分页，整张表塞进一页把页面撑成长条**
  分页器只按块级边界（段落 / 表格）切页，且最后一条规则是「`acc === 0` 时不切，
  避免留空页」—— 本意保护单个超页段落，对表格却正好把整张表锁死在同一页。

  现在遇到「单块就超过一页」的表格，按 `<tr>` 行边界拆成多张表再分配：
  每段复制 `colgroup` 保住列宽、有 `thead` 时每段重复表头；
  第一段只占当前页剩余空间（前面有标题时接着填满，不整段换页留白），
  但剩余空间不足三成时不硬拆（否则拆出两三行独占一页更浪费），改为整表挪到新页再拆。

  实测对照（45 行表格样本，真实浏览器）：页高 1123~**2242**px → **1123px**（全部 A4）。

## [1.6.3] - 2026-10-21

### 修复

- **加密压缩包完全打不开，显示"不支持"**
  打开加密 ZIP 时页面只停在「解析压缩包…」。两层根因：
  ① JSZip 遇到加密条目会整个包一起抛错 `Encrypted zip are not supported`，
  连清单都列不出来 —— 但 ZIP 中央目录是明文的，文件名/大小/时间戳都不需要解密就能读；
  ② 这个异常没人接：`renderPreview` 是 `async`，调用处既没有 `await` 也没有 `.catch`，
  同步 `try/catch` 抓不到异步 reject，于是变成 unhandled rejection，页面永远停在加载中。

  现在新增中央目录直读器（`src/renderer/lib/zipdir.ts`）：JSZip 读不了的包自动退化成
  「清单模式」，照样列出全部文件名/大小/修改时间，顶部说明原因「🔒 该压缩包已加密，
  需要密码才能解压 —— 以下仅列出文件清单」，条目前缀显示 🔒，点击给出具体原因。
  同时给 `renderPreview` 补上 `.catch`，任何渲染失败都会显示「预览失败：原因」，
  **不再卡在加载状态 —— 这条影响所有格式，不只是压缩包**。

  覆盖的边界（均用 Python `zipfile` 逐项对照验证）：ZIP64（7 万条目）、
  中文文件名（UTF-8 与 GBK）、目录条目、存储模式、带注释的包。

## [1.6.2] - 2026-10-21（未对外发布，内容已并入 1.6.3）

### 修复
- **资源管理器多标签页下预览错位**（1.6.1 声称修好但**实际未生效**，本版是真正修复）。
  在新标签页里选中文件按空格，打开的仍是第一个标签页选中的文件。
  1.6.1 的三处缺陷导致判据全部落空、整体退化回老行为：
  - 标签子窗口用 `FindWindowEx` **只查直接子窗口**，标签窗口嵌深一层就返回 0
    → 改用 `EnumChildWindows` 递归枚举。
  - `IShellBrowser` 直接 `QueryInterface` 返回 `E_NOINTERFACE`
    → 改为先取 `IServiceProvider` 再 `QueryService`。
  - 标题匹配用完全相等，而多标签时标题是「下载 和 2 个其他选项卡 - 文件资源管理器」
    → 改为前缀匹配，命中多个时取名字最长的候选。

  候选层级：活动标签 → 标题 → 整窗口，逐级兜底，单个判据失效也不会退化成"取第一个标签页"。
- **空格补发死循环**：吞掉空格却没打开预览时补发的空格，又被自己的键盘钩子捕获，
  形成"补发 → 捕获 → 再补发"，一次按键刷出上千条日志并拖崩 WebView2。
  补发的按键现在在 `dwExtraInfo` 里带自补发标记，钩子见到直接放行。

---

## [1.6.1] - 2026-10-21

### 修复
- **资源管理器多标签页下预览错位**（Windows 11 22H2+）：在新标签页里选中文件按空格，
  打开的一直是第一个标签页选中的文件 —— 选图片、压缩包、文件夹出来的都是同一个文件。
  多标签页共享同一个顶层 hwnd，`ShellWindow.HWND` 无法区分标签页，
  程序把所有标签页的选中项都收了进来又取了第一个。
  用 `ShellTabWindowClass` 子窗口定位激活标签页，再用 `IShellBrowser::GetWindow()`
  反查每个 ShellWindow 属于哪个标签页，只取命中的那一个。
  **（该修复实际未生效，判据三处缺陷导致全部落空，真正修好见 1.6.2。）**

### 新增
- 「关于」窗口显示 GitHub 项目主页并可点击打开；安装包支持链接同步指向仓库。

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
