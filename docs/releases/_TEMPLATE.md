# 发布说明规范

`CHANGELOG.md` 可以写细；GitHub 的 Release **只写用户能感知的变化**。本文件是唯一标准，
`test-samples/check_release_notes.py` 会逐条检查，`dev_gh.py` 发布时再拦一道。

---

## 一、标题（Release name）

**格式：`vX.Y.Z — 主题`**

| 要求 | 说明 |
|---|---|
| 前缀 | 小写 `v` + 三段版本号 |
| 分隔符 | ` — `（空格 + 破折号 + 空格），不用 `-`、`+`、`：`、`/` |
| 主题长度 | **8~22 字** |
| 主语 | 「做了什么」，不是「修了什么 bug 的哪个函数」 |
| 产品名 | **不写 `QuickPreview`** —— 页面左上角已经是仓库名 |

✅ `v1.6.6 — 预览窗不再置顶，大视频不再崩溃`
❌ `QuickPreview 1.6.6` —— 没主题
❌ `v1.6.6 - 预览窗不再全局置顶，GB 级视频不再崩进程，顺带修了日志` —— 超长且堆了三件事
❌ `v1.6.6：修复窗口层级问题` —— 分隔符不合规

同一版有多项改动时，用**一个短句**概括主次，不要堆清单。

---

## 二、正文结构

固定四段，一段都不能少：

```
① 一句话概括（≤50 字，不写版本标题行）
② ### 修复 / ### 新增 / ### 变更 / ### 性能（按需，最多 3 个小节）
③ ### 安装
④ 逐条变更见 [CHANGELOG](https://github.com/mengyuefeitian/quickpreview/blob/main/CHANGELOG.md)
```

条目写法统一为：

```
- **一句话标题**：以前的现象 → 现在的行为。
```

一条 1~3 行，讲用户能看到的差别，不讲怎么实现的。

---

## 三、长度

| 项 | 数值 |
|---|---|
| 正文最佳区间 | 500 ~ 800 字 |
| 警告线 | 1200 字 |
| 硬上限（脚本直接拒绝发布） | 1600 字 |

历史教训：`v1.6.0` 2017 字、`v1.6.4` 2405 字、`v1.6.6` 2830 字 —— 越写越长，
2026-10-22 已全部回刷成 428~765 字。

---

## 四、不要出现在 Release 里的内容

| 禁止项 | 原因 |
|---|---|
| API 名、`P/Invoke`、类名、内部常量 | 用户看不懂，也和他无关 |
| 断言条数、回归通过率（17/17） | 内部测试结论，不是发布内容 |
| 排查过程、根因推导、对照数据表 | 放 CHANGELOG |
| 大段代码块、多张表格 | 撑长正文，阅读成本高 |
| `_发布日期_`、`## vX.Y.Z` 标题行 | 页面顶部已经显示，重复 |
| 与上一版逐条重复的说明 | 旧版说明不会消失 |

**判断标准**：这段话，一个普通用户读完会不会更愿意升级？
不会 → 删掉，写进 CHANGELOG。

---

## 五、模板（复制这份开始写）

```markdown
一句话概括这版解决了什么。

### 修复

- **一句话标题**：以前的现象 → 现在的行为。
- **一句话标题**：以前的现象 → 现在的行为。

### 安装

下载 `QuickPreview-Setup-X.Y.Z-x64.exe` 覆盖安装即可，设置与窗口位置保留。Windows 10 1903+ / 11 x64，
自包含 .NET 8 运行时，无需管理员权限；安装包未签名，首次运行如遇 SmartScreen 请点「更多信息 → 仍要运行」。

逐条变更见 [CHANGELOG](https://github.com/mengyuefeitian/quickpreview/blob/main/CHANGELOG.md)。
```

新增功能时把 `### 修复` 换成 `### 新增`；两类都有就都写，最多三个小节。
纯性能版本可以用 `### 性能`。

---

## 六、检查与发布

```bash
# 1) 写完后自检（标题格式 / 结构 / 字数 / 禁止项）
python test-samples/check_release_notes.py            # 全部
python test-samples/check_release_notes.py v1.6.6     # 单个

# 2) 发布（脚本会再校验标题与正文长度，不合规直接拒绝）
python test-samples/dev_gh.py release mengyuefeitian/quickpreview v1.6.7 "v1.6.7 — 主题" docs/releases/v1.6.7.md installer/QuickPreview-Setup-1.6.7-x64.exe

# 3) 只改文案、不动资产
python test-samples/dev_gh.py body mengyuefeitian/quickpreview v1.6.7 docs/releases/v1.6.7.md
```

标题的唯一事实源是 `docs/releases/_titles.json`（tag → Release name），
发新版本时记得加一行。
