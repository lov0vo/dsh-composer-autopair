# Changelog

本插件的版本号与代码里的内部修订号一一对应：`0.x.0` ↔ 内部 `vx`。
All notable changes to this plugin. Package versions map to the internal revisions the same way:
`0.x.0` ↔ internal `vx`.

## 0.4.1 — 2026-10-15（安装器修复；客户端逻辑未变，仍是内部 v4）

**修复：同一个 loader id 不再挂两层。**
Fix: the same loader id is no longer mounted twice.

- `deploy.mjs` 现在按 profile 现状**二选一**挂 Loader 条目：profile 的 `dsh.profile.bundles`
  里已登记本包 → 走 bundle 路线，并把 user-patch 里的托管块**删掉**；否则才在
  `cordis.patch.yml` 里插一行。两条都插会让 `composer-autopair` 出现 2 行，
  dshmarket 安装/更新插件后的「组合能否启动」检查会判成重复条目并自动回滚整次更新。
  `deploy.mjs` now picks exactly one mounting route and never leaves both rows behind.
- 托管块改成摘掉**全部**（旧版只摘第一个，重复运行会留下两行）。
  The managed block is now stripped in full, not just its first occurrence.
- `file:` 依赖改为指向稳定副本 `<DSH_HOME>/plugins/dsh-composer-autopair`，不再指向仓库目录：
  仓库换位置时旧写法会变成悬空依赖，被 `pnpm install` 清掉后插件静默失效。
  The `file:` dependency now points at a stable copy under `<DSH_HOME>/plugins/`.
- `--remove` 顺带摘掉 `dsh.profile.bundles` 里的登记，不留悬空条目。
- 新增 `src/deploy.test.mjs`（8 个用例：块摘除 / 路线选择 / 两条路线各装一遍 / `--check` 不写盘 / 卸载）；单测 41 → 49。

## 0.4.0 — 2026-10-05（内部 v4）

**修复：引号不再「跳过去」，而是再嵌一对。**
Fix: quotes now nest instead of skipping.

- 已有一对引号（`“”` / `""`）时，光标在中间再按引号键 → 再嵌一对（`““””`）。
  Chinese IMEs emit the *closing* quote after an opening one, which used to hit the "skip over the
  closing half" rule and made nesting impossible.
- 「跳过」按「这一对是不是空的」拆开：空的一对 → 嵌一对；已有内容 → 仍然跳过收尾。
  Skip vs. nest now depends on whether the pair is empty; a pair with content still just closes.
- 括号不受影响。Brackets are unaffected.
- 新增计数 `nested`；单测 36 → 41。

## 0.3.0 — 2026-10-05（内部 v3）

**修复：输入法下嵌套变成「半个」。**
Fix: nesting under an IME produced a half pair (`（（）`).

- 「我自己补的右半边」改成带指纹的记录（文本节点 key + 光标位置 + 左右半边 + 时间），
  重复的 `compositionend` 不再多补，也不会误判「删掉整对后在原地重打」。
  The self-inserted closing half is now tracked by a fingerprint, so duplicate `compositionend`
  events neither double-insert nor suppress a genuine new input.
- 输入法手动提交右半边时，也跟直接打字一样跳过已存在的右半边。
  A manually committed closing half now skips an existing one, matching direct typing.
- 新增计数 `imeCommits` / `imePaired` / `imeSkippedCloser` / `imeDuplicate`；单测 32 → 36。

## 0.2.0 — 2026-10-04（内部 v2）

**修复：光标居中 / 中间的删除键 / 选中包裹 —— 三件事同一个根因。**
Fix: caret position, Delete inside a pair, and wrapping a selection — one shared root cause.

- 动作层从「只用 DOM 移动光标」改为在 `editor.update()` 里操作 Lexical 的 pending selection，
  插入与光标在同一次 update 内原子完成，模型选区与 DOM 不再脱节。
  Actions moved from DOM-only caret surgery to the Lexical model layer, so the model selection and
  the DOM can never drift apart.
- DOM 路径保留为兜底；新增 `caps.editorError` 与 `stats.viaEditor` / `stats.viaDom`。
- 单测 23 → 32（引入「假 Lexical」模型层用例）。

## 0.1.0 — 2026-10-04（内部 v1）

首个版本。First release.

- 聊天输入框自动配对：半角 + 全角共 17 组符号，光标落在中间。
  Auto-pair for the chat composer: 17 ASCII + full-width pairs, caret in between.
- 越过已有右半边、退格删空对、选中文字包裹、输入法提交左半边时补右半边。
  Skip over an existing closing half, Backspace deletes an empty pair, wrap a selection, and handle
  IME-committed opening halves.
- 以标准 DSH 客户端插件形式交付（`dsh.client` + `dsh.bundle.patch` + `deploy.mjs`）。
  Shipped as a standard DSH client plugin package.
