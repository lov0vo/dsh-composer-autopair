# Changelog

本插件的版本号与代码里的内部修订号一一对应：`0.x.0` ↔ 内部 `vx`。
All notable changes to this plugin. Package versions map to the internal revisions the same way:
`0.x.0` ↔ internal `vx`.

## 0.6.0 — 2026-10-27（内部 v9）

**新：DSH 问答卡片里的输入框也支持配对。**
New: auto-pair now works inside the DSH question card's composer.

- 场景：`AskUserQuestion` 那种问答卡片（标题 + 说明 + 输入框 + 跳过/下一题）里的输入框是个普通
  `<textarea>`（React 受控组件），既不是 contenteditable 也不是 Lexical —— 之前完全不在插件的
  作用范围内，所以在那里打括号不会配对。
- 认人方式（只认问答类，别的 textarea 一律不碰）：输入框旁边有个 `aria-hidden="true"` 的等高镜像
  `<div>`，或类名里带 `fieldInput`；本机想再加别的输入框，往 localStorage 的
  `dsh-composer-autopair:textareas` 写逗号分隔的选择器即可。
- 实现：新增纯函数 `planTextareaEdit`（复用 `planInsert`/`planBackspace`）与 `planTextareaIme`；
  写入走 `setRangeText` + 手动设选区 + 自己发一个 `input` 事件（受控组件靠它同步 state）。
- 覆盖：直接打字配对 / 选中文字包裹 / 右半边越过 / 空引号对再嵌一对 / 退格删空对 / 中文输入法提交
  补右半边 / 输入法替换选区时改回包裹（`compositionstart` 先记原文，`compositionend` 后 `setTimeout 0`
  再处理，因为 `insertCompositionText` 不可拦截）。
- 诊断：新增 `stats.viaTextarea`、`caps.answerTextareas`，trace 记 `ta-*`。
- 单测 65 → 80（含假 textarea 的端到端用例与「别的 textarea 不插手」用例）。

## 0.5.3 — 2026-10-22（内部 v8）

**修 0.5.2：真实编辑器里「选中文字再按符号」仍然被替换 —— 判据用了会被重建的节点身份。**
Fix for 0.5.2: the wrap still did not fire in the real editor, because the guard compared node
identity that Lexical re-creates.

- 现场证据（报告 trace）：`cs` 记到了原文（`少时诵诗书少时诵`）、`ce` 收到 `（`，随后却是 `pair`
  而不是 `wrap-ime` —— 说明捕获成功、改写被守卫挡掉了。
- 根因：`wrapCommittedOpenInEditor` 要求「提交后的文本节点 key 与组合开始时一致，且偏移等于
  `起点 + 符号长度`」。Lexical 删掉选区时会把文本节点**拆开重建**，key 已经变了；偏移也随节点
  切分而失效。于是守卫永远不通过，落到原来的「补一对」分支。
- 修法：判据只留「光标左边紧挨着刚提交的那个符号」；另加一条防守——原文还紧挨在符号左边时说明
  选区没被替换，直接放弃，避免把文字复制两遍。失败原因记进 trace（`wrap-miss`: `no-caret` /
  `no-char` / `not-replaced` / `no-writer` / `no-range`），下次出问题能一眼定位。
- 单测 63 → 65（新增：节点 key 被重建仍要包裹；原文没被替换时不重复塞一遍）。

## 0.5.2 — 2026-10-22（内部 v7）

**中文输入法下选中一段文字再按符号，不再把原文替换掉，而是包住原文。**
With a Chinese IME, selecting text and then typing a symbol now wraps the selection instead of
replacing it.

- 根因：输入法提交符号时，浏览器先把选中的文字删掉、再插入它自己提交的那个字符；等
  `compositionend` 到达时原文已经没了，插件只能看到「光标左边多了一个 `（`」，于是按「补一对」
  处理 —— 原文被替换成了 `（）`。The IME deletes the selection before committing, so by the time
  `compositionend` arrives the selected text is already gone and the plugin could only see the
  freshly committed bracket.
- 修法：在 `compositionstart`（以及 `beforeinput` 的 `insertCompositionText`，兜底那些先删选区
  再发事件的浏览器）把**选区原文**记下来；`compositionend` 确认提交字符落进模型后，把光标左边
  那个符号改写成 `open + 原文 + close`，并把原文重新选中 —— 与直接打字时的包裹表现完全一致。
  The selection text is captured before the IME destroys it and re-applied as a wrap on commit.
- 位置对不上（普通插入而不是替换选区）时不动，交给原来的「补右半边」逻辑。
- 诊断：新增 `stats.imeWrapped`，trace 记 `cs` / `bi-cs` / `wrap-ime`。
- 单测 55 → 63（新增 4 个：全角/半角包裹、无选区不误判、非配对字符不插手）。

## 0.5.1 — 2026-10-17（内部 v6）

**修复 0.5.0 的回归：中文输入法下所有符号都不成对了（只出一个）。**
Fix for a 0.5.0 regression: with a Chinese IME no symbol paired up at all.

- 根因：0.5.0 把 `currentCaret()` 当成主判据，而它在 Lexical 的读取上下文之外裸调
  `point.getNode()` —— 真实 Lexical 里这会抛「找不到活动编辑器状态」（`Unable to find an
  active editor state`），异常被吞掉后表现为「永远读不到光标」：轮询一路超时，每次输入法
  提交都记 `imeNotSettled`，于是什么都不补。In 0.5.0 `currentCaret()` called
  `point.getNode()` outside a Lexical read context; real Lexical throws there, the error was
  swallowed, the poll timed out every time and nothing was ever paired.
- 修法一：`currentCaret()` 改在 `editorState.read(...)` 里取节点，模型探针重新可用。
  Now reads the node inside `editorState.read(...)`.
- 修法二：**任何情况下都不再「什么都不做」**——读不到模型光标（trace 记 `ce-nocaret`）或等满
  12 帧仍没吸收（trace 记 `ce-stale`）时，立刻回退到 DOM 兜底路径补全。A DOM fallback now
  covers both the unreadable-caret and never-absorbed cases.
- 单测 55 → 58：新增「必须在读取上下文里取节点」（模拟真实 Lexical，裸调即抛错）、
  「读不到光标 → 立刻 DOM 兜底」、「一直没吸收 → 12 帧后 DOM 兜底」。

## 0.5.0 — 2026-10-17（内部 v5）

**修复：中文输入法下引号每次都要成对，不再「第一次成对、第二次只出一个」。**
Fix: with a Chinese IME, quotes now pair up every time instead of only the first time.

- 根因：`compositionend` 到达时 Lexical 还没把这次提交写进模型，DOM 探针也还停在提交前。
  旧实现只等一帧、且完全依赖 DOM 探针，对不上就整段放弃 → 第二次按引号键提交的右引号
  孤零零留在正文里。The committed character lands in Lexical's model a frame or two after
  `compositionend`; the old code waited a single frame on a DOM-only probe and gave up
  entirely when it did not match, leaving a lone closing quote behind.
- 改成**轮询模型**：每帧检查这次提交是否已经落到光标左边，最多等 12 帧；
  超时就记 `imeNotSettled` 并**什么都不做**（宁可不动，也绝不删输入法刚提交的字符）。
  Now polls the model for up to 12 frames; on timeout it records `imeNotSettled` and
  deliberately does nothing rather than risk deleting what the IME just committed.
- 删掉了那条会误伤嵌套的 DOM 守卫（`nestQuoteInEditor` / `skipCommittedCloserInEditor`
  自己会校验光标右边是不是同一个右半边）。Removed the DOM guard that mis-fired on nesting.
- 新增一条兜底：提交的右引号左边**没有任何等着收尾的左引号**时（典型场景：光标停在一对
  **已经有内容**的引号之后，输入法却按自己的节奏给了右引号），把它就地改写成一对，
  光标停在中间 —— 这样「无论怎么输入引号都成对」。左边真有没收尾的左引号时不动它，
  那才是正常收尾。A committed closing quote with no unmatched opening quote to its left is
  rewritten into a fresh pair, so quotes pair up no matter what the IME emits.
- 新增 `trace`（最近 24 条事件流水：`bi` / `bi-other` / `kd` / `ce` / `ce-dom` / `ce-stale` /
  `dup` / `pair` / `nest` / `skip` / `noop`），随诊断报告一起落盘，事后能还原现场；
  `api.trace` 也可直接读。A 24-entry event trace now ships inside the diagnostic report.
- 新增 6 个用例（模型晚一拍 / 连按引号键 / 输入法始终提交左引号 / 已有内容的一对之后 / 正常收尾不受影响 / trace 落盘）；单测总数 49 → 55（客户端 41 → 47）。

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
