<!--
发布说明模板（模板文件，不发布）

写作原则：CHANGELOG 可以写细，Release note 只写「用户能感知的变化」。
硬性要求：正文 ≤ 1600 字（最佳 400~600 字），超过 1600 字发布脚本会直接拒绝。

不该出现在这里的内容：
  × 实现细节（API 名、P/Invoke、断言条数、代码路径）
  × 排查过程、根因推导、对照实验数据
  × 大段代码块、多张对照表
这些一律留在 CHANGELOG.md 和 PR/commit 里。

该有的内容：
  √ 一句话概括这版解决什么
  √ 3~5 条「以前怎样 → 现在怎样」，按用户能感知的现象写
  √ 怎么装、要不要注意什么
  √ 指向完整 CHANGELOG 的链接
-->

## vX.Y.Z

一句话概括这版解决了什么。

### 修复

- **一句话标题**：以前的现象 → 现在的行为。（<!-- 有 issue 就带链接 -->）
- ...

### 新增

- **一句话标题**：能做什么，怎么用。

### 安装

下载 `QuickPreview-Setup-X.Y.Z-x64.exe` 覆盖安装即可，窗口位置和设置都会保留。

逐条变更见 [CHANGELOG](https://github.com/mengyuefeitian/quickpreview/blob/main/CHANGELOG.md)。
