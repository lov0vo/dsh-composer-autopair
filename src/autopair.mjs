/**
 * dsh-composer-autopair — 输入左半边自动补右半边，光标落在中间。
 *
 * 本文件是插件 `dsh-composer-autopair` 的客户端源码；`build.mjs` 把它包成
 * DSH 客户端模块系统要的 bundle（`lib/client.js`），插件入口是文件末尾的 `apply(ctx)`。
 *
 * 作用面：DSH Web GUI / 桌面端聊天输入框（Lexical 编辑器，根节点为 [data-composer-input]）。
 * 实现要点：
 *  1. 纯逻辑（planInsert / planBackspace）与 DOM 适配分离，纯逻辑可在 Node 里单测；
 *  2. 拦截点用 `beforeinput`（capture）而不是 keydown —— 这样中文输入法把 `(` 提交成
 *     `（`、或者输入法走 insertText 的路径，都能统一覆盖；
 *  3. 插入动作仍交给编辑器自己：`document.execCommand('insertText')` 会派发一次
 *     合成的 beforeinput，Lexical 收到后按正常路径写入模型，因此撤销栈、草稿状态都正常；
 *  4. 插入后在同一帧（或随后几帧）把 DOM 光标左移一格，浏览器派发 selectionchange，
 *     Lexical 自行把 DOM 选区同步回模型；不需要碰 Lexical 内部 API。
 */

export const VERSION = 'v9';
export const STORAGE_PREFIX = 'dsh-composer-autopair';
export const COMPOSER_SELECTOR = '[data-composer-input]';

/** 默认配对表：半角 + 全角/中文。 */
export const DEFAULT_PAIRS = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['（', '）'],
  ['［', '］'],
  ['｛', '｝'],
  ['【', '】'],
  ['《', '》'],
  ['〈', '〉'],
  ['「', '」'],
  ['『', '』'],
  ['〔', '〕'],
  ['“', '”'],
  ['‘', '’'],
];

/** 把配对表编成两张索引：左半边 -> 右半边；右半边集合。 */
export function createPairIndex(pairs = DEFAULT_PAIRS) {
  const openToClose = new Map();
  const closers = new Set();
  for (const pair of pairs) {
    if (!pair || pair.length !== 2) continue;
    openToClose.set(pair[0], pair[1]);
    closers.add(pair[1]);
  }
  return { openToClose, closers };
}

/** 码点长度（`“` 与 emoji 都按 1 个字符算）。 */
export function charLength(text) {
  return Array.from(String(text)).length;
}

/**
 * 引号类左半边。为什么要单独拎出来：中文输入法在「已经打开引号」的状态下再按一次引号键，
 * 输出的是**右引号**（`“` 之后再按会得到 `”`），所以在一对空引号中间再按引号键时，
 * 我们收到的是右半边。对括号来说「跳过已有的右半边」是对的（想嵌套直接打左括号就行），
 * 对引号来说却会让嵌套变得不可能 —— 因此引号要走「再嵌一对」。
 */
export const QUOTE_OPENERS = new Set(['"', "'", '`', '“', '‘']);

/** 找出某个右半边对应的、引号类的左半边（没有就返回 null）。 */
export function quoteOpenerFor(index, close) {
  for (const [open, mapped] of index.openToClose) {
    if (mapped === close && QUOTE_OPENERS.has(open)) return open;
  }
  return null;
}

/** 光标是否正好夹在一对**空**引号中间：左侧是 open、右侧是 close。 */
export function isEmptyQuotePair(text, offset, open, close) {
  if (typeof text !== 'string') return false;
  const left = text.slice(offset - open.length, offset);
  const right = text.slice(offset, offset + close.length);
  return left === open && right === close;
}

/**
 * 决定一次 insertText 该怎么处理。
 * @returns null（按默认行为）| {kind:'pair'|'wrap'|'skip'|'nest'}
 */
export function planInsert(data, state, index) {
  if (typeof data !== 'string' || charLength(data) !== 1) return null;
  const collapsed = state && state.collapsed !== undefined ? state.collapsed : true;
  const charAfter = (state && state.charAfter) || '';
  const charBefore = (state && state.charBefore) || '';
  const textSelection = !!(state && state.textSelection);
  const close = index.openToClose.get(data);
  if (close !== undefined) {
    if (!collapsed) return textSelection ? { kind: 'wrap', open: data, close } : null;
    return { kind: 'pair', open: data, close };
  }
  if (index.closers.has(data)) {
    if (!collapsed) return null;
    // 一对空引号中间再按引号键（输入法只会给右半边）→ 再嵌一对，而不是跳过去
    const quoteOpen = quoteOpenerFor(index, data);
    if (quoteOpen !== null && charBefore === quoteOpen && charAfter === data) {
      return { kind: 'nest', open: quoteOpen, close: data };
    }
    return charAfter === data ? { kind: 'skip' } : null;
  }
  return null;
}

/** 退格：光标正好夹在一对空括号中间时，一次删掉两个。 */
export function planBackspace(state, index) {
  const collapsed = state && state.collapsed !== undefined ? state.collapsed : true;
  if (!collapsed) return null;
  const charBefore = (state && state.charBefore) || '';
  const charAfter = (state && state.charAfter) || '';
  const close = index.openToClose.get(charBefore);
  if (close !== undefined && charAfter === close) return { kind: 'deletePair' };
  return null;
}

/**
 * 普通 textarea（DSH 问答卡片里那种）的配对决策：纯函数，不碰 DOM。
 * state = { value, start, end, data }；`data === null` 表示退格。
 * 返回 null（按默认行为）或 { kind, start, end, text, selStart, selEnd }：
 * 用 text 替换 [start, end)，然后把选区放到 [selStart, selEnd)。
 */
export function planTextareaEdit(state, index) {
  const value = state && typeof state.value === 'string' ? state.value : '';
  let start = Math.max(0, Math.min(state.start | 0, value.length));
  let end = Math.max(0, Math.min(state.end | 0, value.length));
  if (start > end) { const swap = start; start = end; end = swap; }
  const selected = value.slice(start, end);
  const collapsed = start === end;
  const data = state.data;

  if (data === null || data === undefined) {
    const plan = planBackspace({
      collapsed,
      charBefore: value.slice(start - 1, start),
      charAfter: value.slice(start, start + 1),
    }, index);
    if (!plan) return null;
    return { kind: 'deletePair', start: start - 1, end: start + 1, text: '', selStart: start - 1, selEnd: start - 1 };
  }

  const plan = planInsert(data, {
    collapsed,
    charBefore: value.slice(start - 1, start),
    charAfter: value.slice(start, start + 1),
    textSelection: !collapsed,
  }, index);
  if (!plan) return null;

  if (plan.kind === 'pair' || plan.kind === 'nest') {
    const caret = start + plan.open.length;
    return { kind: plan.kind, start, end, text: plan.open + plan.close, selStart: caret, selEnd: caret };
  }
  if (plan.kind === 'wrap') {
    const caret = start + plan.open.length;
    return {
      kind: 'wrap', start, end,
      text: plan.open + selected + plan.close,
      selStart: caret, selEnd: caret + selected.length,
    };
  }
  if (plan.kind === 'skip') {
    const caret = start + data.length;
    return { kind: 'skip', start, end, text: '', selStart: caret, selEnd: caret };
  }
  return null;
}

/**
 * textarea 里的输入法提交：字符已经落在 caret 之前了，只补右半边 / 还原被替换的选区。
 * snapshot 是 compositionstart 时记下的选区（`{ text }`），没有就当作光标输入。
 */
export function planTextareaIme(state, index) {
  const value = state && typeof state.value === 'string' ? state.value : '';
  const data = state.data;
  if (typeof data !== 'string' || charLength(data) !== 1) return null;
  const caret = Math.max(0, Math.min(state.caret | 0, value.length));
  const start = caret - data.length;
  if (start < 0 || value.slice(start, caret) !== data) return null;

  const close = index.openToClose.get(data);
  if (close !== undefined) {
    const original = state.snapshot && typeof state.snapshot.text === 'string' ? state.snapshot.text : '';
    if (original) {
      // 输入法把选中的原文替换成了左半边：还原成「包住原文」。
      // 但原文要是还紧挨在符号左边，说明选区根本没被替换，别把它复制一遍。
      if (value.slice(0, start).endsWith(original)) return null;
      return {
        kind: 'wrap', start, end: caret,
        text: data + original + close,
        selStart: start + data.length,
        selEnd: start + data.length + original.length,
      };
    }
    return { kind: 'pair', start, end: caret, text: data + close, selStart: start + data.length, selEnd: start + data.length };
  }

  if (index.closers.has(data)) {
    const quoteOpen = quoteOpenerFor(index, data);
    // 一对空引号中间再提交一个右引号（输入法只会给右半边）→ 再嵌一对
    if (quoteOpen !== null && value.slice(start - 1, start) === quoteOpen && value.slice(caret, caret + 1) === data) {
      return {
        kind: 'nest', start, end: caret,
        text: quoteOpen + data,
        selStart: start + quoteOpen.length,
        selEnd: start + quoteOpen.length,
      };
    }
    // 右边已经是同一个右半边 → 越过它
    if (value.slice(caret, caret + 1) === data) {
      return { kind: 'skip', start, end: caret, text: '', selStart: start, selEnd: start };
    }
  }
  return null;
}

/** 选区是否只是纯文本（没有 @ 引用 chip / 装饰节点），只有这种才敢整体包裹。 */
export function isPlainTextRange(range) {
  if (!range) return false;
  if (range.startContainer.nodeType !== 3 || range.endContainer.nodeType !== 3) return false;
  let text = '';
  try {
    text = range.toString();
  } catch (error) {
    return false;
  }
  if (text.length === 0) return false;
  try {
    const fragment = range.cloneContents();
    if (fragment && typeof fragment.querySelector === 'function') {
      if (fragment.querySelector('[data-lexical-decorator],[data-composer-chip],[data-composer-text-ref]')) return false;
    }
  } catch (error) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lexical 模型层适配
//
// 为什么必须有这一层：只用 DOM 移动光标（Selection.modify）时，Lexical 的模型选区还停在
// 右半边之后，于是
//   · 有时它会把 DOM 光标重新写回右半边之后 → 光标不在中间；
//   · 视觉上在中间、但模型里光标在右半边之后 → 删除键删的是「后面」→ 按了没反应；
//   · 有选区时模型与 DOM 判断不一致 → 走默认行为，把选中的文字直接替换掉。
// 改成在 `editor.update()` 里操作 pending selection，插入与光标一次原子完成，Lexical 自己
// 会把 DOM 写对。DOM 路径保留为兜底（拿不到编辑器实例时仍能工作，只是回到旧行为）。
// ---------------------------------------------------------------------------

/** 取到 Lexical 编辑器实例：Lexical 会给 contenteditable 根节点挂 `__lexicalEditor`。 */
export function editorOf(root) {
  try {
    return root && root.__lexicalEditor ? root.__lexicalEditor : null;
  } catch (error) {
    return null;
  }
}

/** 模型层最近一次异常（写进诊断报告，便于从磁盘定位）。 */
let editorLastError = null;

/** 诊断用：模型层最近一次异常信息。 */
export function editorDiagnostics() {
  return { lastError: editorLastError };
}

/** 在模型层跑一次 update，回调拿到 pending EditorState 的 selection（= Lexical 的 $getSelection()）。 */
function withEditorSelection(editor, run) {
  if (!editor || typeof editor.update !== 'function') return false;
  let ok = false;
  try {
    editor.update(() => {
      // 回调内部自己兜错：绝不让异常穿出 editor.update()，否则 Lexical 可能卡在 updating 状态
      try {
        const state = editor._pendingEditorState || editor._editorState;
        const selection = state ? state._selection : null;
        if (!selection) return;
        ok = run(selection, state) === true;
      } catch (error) {
        editorLastError = String((error && error.message) || error).slice(0, 200);
        ok = false;
      }
    });
  } catch (error) {
    editorLastError = String((error && error.message) || error).slice(0, 200);
    return false;
  }
  return ok;
}

/** 光标所在文本点：{ node, text, offset }；不是文本点就返回 null。 */
function caretPoint(selection) {
  const point = selection && selection.anchor;
  if (!point || point.type !== 'text' || typeof point.getNode !== 'function') return null;
  const node = point.getNode();
  if (!node || typeof node.getTextContent !== 'function') return null;
  return { node, text: node.getTextContent(), offset: point.offset };
}

/** 把光标放到同一个文本节点的 offset 处（anchor/focus 都落在这里）。 */
function setCaretOnNode(selection, node, offset) {
  return setRangeOnNode(selection, node, offset, offset);
}

/** 在同一文本节点上建一个 [start, end] 选区。 */
function setRangeOnNode(selection, node, start, end) {
  const key = node && node.__key;
  if (!key || !selection.anchor || !selection.focus) return false;
  try {
    if (typeof selection.anchor.set === 'function' && typeof selection.focus.set === 'function') {
      selection.anchor.set(key, start, 'text');
      selection.focus.set(key, end, 'text');
    } else {
      selection.anchor.key = key;
      selection.anchor.offset = start;
      selection.anchor.type = 'text';
      selection.focus.key = key;
      selection.focus.offset = end;
      selection.focus.type = 'text';
    }
    selection.dirty = true;
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 选区是否可以整体包起来：
 *  · 至少要有一段文本；
 *  · 允许出现段落/列表这类元素节点（Lexical 的 getNodes 会把它们带进来）；
 *  · 出现装饰节点（@ 引用 chip、图片等没有 getChildren 的叶子）就拒绝，别把 chip 删掉；
 *  · 选区跨段落也拒绝（把整段文字塞进一个文本节点会打乱结构）。
 */
function isTextOnlySelection(selection) {
  if (!selection || typeof selection.getNodes !== 'function') return false;
  const nodes = selection.getNodes();
  if (!nodes || nodes.length === 0) return false;
  let sawText = false;
  for (const node of nodes) {
    const type = typeof node.getType === 'function' ? node.getType() : null;
    if (type === 'text') {
      sawText = true;
      continue;
    }
    if (typeof node.getChildren === 'function') continue; // 段落/列表等元素节点
    return false; // 装饰节点
  }
  if (!sawText) return false;
  try {
    const first = selection.anchor.getNode();
    const last = selection.focus.getNode();
    if (
      first && last
      && typeof first.getParent === 'function'
      && typeof last.getParent === 'function'
      && first.getParent() !== last.getParent()
    ) {
      return false;
    }
  } catch (error) {
    return false;
  }
  return true;
}

/** 选区里的纯文本。 */
function selectionText(selection) {
  if (typeof selection.getTextContent === 'function') return selection.getTextContent();
  if (typeof selection.getNodes !== 'function') return '';
  return selection.getNodes()
    .map((node) => (typeof node.getTextContent === 'function' ? node.getTextContent() : ''))
    .join('');
}

/**
 * 只看选区做判断，不改任何东西 —— 这样「决定不处理」时可以安全地回退到 DOM 路径。
 * @returns null | {kind:'pair'|'wrap'|'skip'|'nest', ...}
 */
export function planFromSelection(selection, data, index) {
  if (!selection || typeof selection.isCollapsed !== 'function') return null;
  const collapsed = selection.isCollapsed() === true;
  const close = index.openToClose.get(data);
  if (close !== undefined) {
    if (collapsed) return { kind: 'pair', open: data, close };
    if (isTextOnlySelection(selection)) return { kind: 'wrap', open: data, close };
    return null; // 选区里有 chip 之类，交给编辑器默认行为
  }
  if (collapsed && index.closers.has(data)) {
    const ctx = caretPoint(selection);
    if (!ctx) return null;
    // 一对空引号中间再按引号键（输入法只会给右半边）→ 再嵌一对，而不是跳过去
    const quoteOpen = quoteOpenerFor(index, data);
    if (quoteOpen !== null && isEmptyQuotePair(ctx.text, ctx.offset, quoteOpen, data)) {
      return { kind: 'nest', open: quoteOpen, close: data };
    }
    if (ctx.text.slice(ctx.offset, ctx.offset + data.length) === data) {
      return { kind: 'skip', open: data, close: data };
    }
  }
  return null;
}

/** 插入一对符号并把光标放到中间（模型层）。 */
export function insertPairInEditor(editor, open, close) {
  return withEditorSelection(editor, (selection) => {
    if (typeof selection.insertText !== 'function') return false;
    selection.insertText(open + close);
    return placeCaretInsidePair(selection, open, close);
  });
}

/** 把「刚插入的整对」之后的光标挪到中间；已经在中间就算成功。 */
function placeCaretInsidePair(selection, open, close) {
  const ctx = caretPoint(selection);
  if (!ctx) return false;
  const pair = open + close;
  if (ctx.text.slice(ctx.offset - pair.length, ctx.offset) === pair) {
    return setCaretOnNode(selection, ctx.node, ctx.offset - close.length);
  }
  if (ctx.text.slice(ctx.offset - open.length, ctx.offset) === open) {
    return setCaretOnNode(selection, ctx.node, ctx.offset);
  }
  return false;
}

/**
 * 输入法已经把右引号插进来了：状态是 `open close | close`（原本是一对空引号），
 * 把它变成 `open open close close` 并把光标放到中间那对新引号里。
 * 只有「原本是空的一对」才会命中；`“你好”` 这种已经有内容的会落到「跳过」。
 */
export function nestQuoteInEditor(editor, open, close) {
  return withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    const openLen = open.length;
    const closeLen = close.length;
    const start = ctx.offset - closeLen; // 刚提交的那个右引号
    if (ctx.text.slice(start, ctx.offset) !== close) return false;
    if (ctx.text.slice(start - openLen, start) !== open) return false;
    if (ctx.text.slice(ctx.offset, ctx.offset + closeLen) !== close) return false;
    const next = ctx.text.slice(0, start) + open + close + ctx.text.slice(ctx.offset);
    if (typeof ctx.node.setTextContent === 'function') ctx.node.setTextContent(next);
    else if (typeof ctx.node.spliceText === 'function') ctx.node.spliceText(start, closeLen, open + close);
    else return false;
    return setCaretOnNode(selection, ctx.node, start + openLen);
  });
}

/** 用符号把选中的文字包起来，并选回原文（模型层）。 */
export function wrapInEditor(editor, open, close) {
  return withEditorSelection(editor, (selection) => {
    if (typeof selection.insertText !== 'function') return false;
    const text = selectionText(selection);
    if (text.length === 0) return false;
    selection.insertText(open + text + close);
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    const inserted = open + text + close;
    if (ctx.text.slice(ctx.offset - inserted.length, ctx.offset) !== inserted) return false;
    const innerEnd = ctx.offset - close.length;
    return setRangeOnNode(selection, ctx.node, innerEnd - text.length, innerEnd);
  });
}

/**
 * 输入法把选中的文字**替换**成了左半边：用组合开始前记下的原文把这一对补回去 ——
 * 把光标左边那个刚提交的 `open` 改写成 `open + 原文 + close`，并把原文重新选中
 * （与直接打字时的「包裹」表现一致）。
 *
 * 判据只看「光标左边紧挨着的就是刚提交的那个符号」——**不能**拿节点 key 或偏移去比对：
 * Lexical 在替换选区时会把文本节点拆开重建，提交后的节点 key 跟组合开始时那个已经不是同一个。
 *
 * @returns {ok:true} | {ok:false, reason:string}
 */
export function wrapCommittedOpenInEditor(editor, open, close, snapshot) {
  if (!snapshot || typeof snapshot.text !== 'string' || snapshot.text.length === 0) {
    return { ok: false, reason: 'no-snapshot' };
  }
  let reason = 'ok';
  const done = withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) {
      reason = 'no-caret';
      return false;
    }
    const openLen = open.length;
    if (ctx.text.slice(ctx.offset - openLen, ctx.offset) !== open) {
      reason = 'no-char'; // 提交的符号不在光标左边
      return false;
    }
    const start = ctx.offset - openLen;
    // 原文还紧挨在符号左边 → 选区其实没被替换掉，别把文字再复制一遍
    if (start >= snapshot.text.length
      && ctx.text.slice(start - snapshot.text.length, start) === snapshot.text) {
      reason = 'not-replaced';
      return false;
    }
    const replacement = open + snapshot.text + close;
    const next = ctx.text.slice(0, start) + replacement + ctx.text.slice(ctx.offset);
    if (typeof ctx.node.setTextContent === 'function') ctx.node.setTextContent(next);
    else if (typeof ctx.node.spliceText === 'function') ctx.node.spliceText(start, openLen, replacement);
    else {
      reason = 'no-writer';
      return false;
    }
    const innerEnd = start + openLen + snapshot.text.length;
    if (!setRangeOnNode(selection, ctx.node, innerEnd - snapshot.text.length, innerEnd)) {
      reason = 'no-range';
      return false;
    }
    return true;
  });
  return done ? { ok: true } : { ok: false, reason };
}

/** 已有右半边时再打一次右半边 → 光标跳过它（模型层）。 */
export function skipClosingInEditor(editor, close) {
  return withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    if (ctx.text.slice(ctx.offset, ctx.offset + close.length) !== close) return false;
    return setCaretOnNode(selection, ctx.node, ctx.offset + close.length);
  });
}

/** 一对空符号中间的退格 → 一次删掉两个（模型层）。 */
export function deletePairInEditor(editor, index) {
  return withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    const before = ctx.text.slice(0, ctx.offset);
    let open = null;
    let close = null;
    for (const [candidateOpen, candidateClose] of index.openToClose) {
      if (before.endsWith(candidateOpen)) {
        open = candidateOpen;
        close = candidateClose;
        break;
      }
    }
    if (open === null) return false;
    if (ctx.text.slice(ctx.offset, ctx.offset + close.length) !== close) return false;
    const start = ctx.offset - open.length;
    const next = ctx.text.slice(0, start) + ctx.text.slice(ctx.offset + close.length);
    if (typeof ctx.node.setTextContent === 'function') ctx.node.setTextContent(next);
    else if (typeof ctx.node.spliceText === 'function') ctx.node.spliceText(start, open.length + close.length, '');
    else return false;
    return setCaretOnNode(selection, ctx.node, start);
  });
}

/**
 * 我们自己补上去的最后一个右半边：{ key, caretOffset, close, at }。
 * 用来把「重复的 compositionend」和「用户在已有的一对里再打一个左半边（嵌套）」区分开 ——
 * 两种情况在光标附近长得一模一样，只能靠「那个右半边是不是我留的、位置有没有被改动」来判定。
 */
let lastAppend = null;

/** 诊断/内部用：我们自己补上的最后一个右半边。 */
export function lastAppendedCloser() {
  return lastAppend;
}

/** 读当前（已提交）模型光标：{ key, offset, text }；拿不到返回 null。 */
export function currentCaret(root) {
  const editor = editorOf(root);
  if (!editor) return null;
  try {
    const state = editor._editorState;
    if (!state) return null;
    let out = null;
    const inspect = () => {
      const selection = state._selection;
      const point = selection && selection.anchor;
      if (!point || point.type !== 'text') return;
      const node = typeof point.getNode === 'function' ? point.getNode() : null;
      const text = node && typeof node.getTextContent === 'function' ? node.getTextContent() : '';
      out = { key: point.key, offset: point.offset, text };
    };
    // 必须在 EditorState 的读取上下文里取节点：裸调 point.getNode() 时 Lexical 找不到
    // 「活动编辑器状态」，$getNodeByKey 会直接抛错 —— 被外层 catch 吞掉后表现为
    // 「永远读不到光标」（输入法提交时就会一路超时、什么都不补）。
    if (typeof state.read === 'function') state.read(inspect);
    else inspect();
    return out;
  } catch (error) {
    return null;
  }
}

/**
 * 读当前（已提交）模型选区里的一段纯文本：`{ key, start, end, text }`；
 * 不是「可以整体包起来的一段文字」就返回 null。
 *
 * 输入法开始组合时记一次：提交完成时那段文字已经被替换掉了，只有这一刻还读得到原文。
 */
export function readTextSelection(root) {
  const editor = editorOf(root);
  if (!editor) return null;
  try {
    const state = editor._editorState;
    if (!state) return null;
    let out = null;
    const inspect = () => {
      const selection = state._selection;
      if (!selection || typeof selection.isCollapsed !== 'function') return;
      if (selection.isCollapsed() === true) return;
      if (!isTextOnlySelection(selection)) return;
      const anchor = selection.anchor;
      const focus = selection.focus;
      if (!anchor || !focus || anchor.type !== 'text' || focus.type !== 'text') return;
      if (anchor.key !== focus.key) return; // 跨节点不包裹，和直接打字时的规则一致
      const text = selectionText(selection);
      if (text.length === 0) return;
      out = {
        key: anchor.key,
        start: Math.min(anchor.offset, focus.offset),
        end: Math.max(anchor.offset, focus.offset),
        text,
      };
    };
    if (typeof state.read === 'function') state.read(inspect);
    else inspect();
    return out;
  } catch (error) {
    return null;
  }
}

/** 输入法把左半边提交上来后补右半边（模型层）。 */
export function appendCloseInEditor(editor, close, open) {
  let record = null;
  const ok = withEditorSelection(editor, (selection) => {
    if (typeof selection.insertText !== 'function') return false;
    selection.insertText(close);
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    if (ctx.text.slice(ctx.offset - close.length, ctx.offset) !== close) return false;
    const caretOffset = ctx.offset - close.length;
    if (!setCaretOnNode(selection, ctx.node, caretOffset)) return false;
    record = {
      key: ctx.node.__key,
      caretOffset,
      open: typeof open === 'string' ? open : '',
      close,
      at: Date.now(),
    };
    return true;
  });
  if (ok && record !== null) lastAppend = record;
  return ok;
}

/**
 * 输入法把右半边也提交了上来，而光标右边正好还是同一个右半边：
 * 删掉刚提交的这一个，光标越过原来那个（与直接打字的「跳过」一致）。
 */
export function skipCommittedCloserInEditor(editor, close) {
  return withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    const len = close.length;
    if (ctx.text.slice(ctx.offset - len, ctx.offset) !== close) return false; // 光标前是刚提交的那个
    if (ctx.text.slice(ctx.offset, ctx.offset + len) !== close) return false; // 光标后是已经存在的那个
    const next = ctx.text.slice(0, ctx.offset - len) + ctx.text.slice(ctx.offset);
    if (typeof ctx.node.setTextContent === 'function') ctx.node.setTextContent(next);
    else if (typeof ctx.node.spliceText === 'function') ctx.node.spliceText(ctx.offset - len, len, '');
    else return false;
    return setCaretOnNode(selection, ctx.node, ctx.offset);
  });
}

/**
 * 输入法提交之后的收尾：提交的是左半边就补右半边；提交的是右半边且右边还是同一个就跳过。
 * @returns 'pair' | 'skip' | null
 */
export function finishCompositionInEditor(root, last, index) {
  const editor = editorOf(root);
  if (!editor) return null;
  const open = index.openToClose.get(last);
  if (open !== undefined) {
    return appendCloseInEditor(editor, open, last) ? 'pair' : null;
  }
  if (index.closers.has(last)) {
    const quoteOpen = quoteOpenerFor(index, last);
    if (quoteOpen !== null && nestQuoteInEditor(editor, quoteOpen, last)) return 'nest';
    if (skipCommittedCloserInEditor(editor, last)) return 'skip';
    if (quoteOpen !== null && pairUpCommittedCloserInEditor(editor, quoteOpen, last)) return 'pair';
    return null;
  }
  return null;
}

/** 从左往右数：text 里是否还有没被收尾的 open（按 open/close 配对）。 */
export function hasUnmatchedOpener(text, open, close) {
  let depth = 0;
  for (const ch of text) {
    if (ch === open) depth += 1;
    else if (ch === close && depth > 0) depth -= 1;
  }
  return depth > 0;
}

/**
 * 输入法提交了一个右引号，但它左边没有任何「还没被收尾的左引号」可收 ——
 * 说明用户其实是想在这里再开一对（典型场景：光标停在一对**已经有内容**的引号之后，
 * 输入法却按自己的节奏给了右引号）。这时把刚提交的那个右引号就地改写成一对，
 * 光标停在中间，保证引号永远成对；左边真有等着收尾的左引号时不动它（那才是正常收尾）。
 * @returns boolean 是否改写了
 */
export function pairUpCommittedCloserInEditor(editor, open, close) {
  return withEditorSelection(editor, (selection) => {
    const ctx = caretPoint(selection);
    if (!ctx) return false;
    const len = close.length;
    if (ctx.text.slice(ctx.offset - len, ctx.offset) !== close) return false; // 光标前是刚提交的那个
    if (hasUnmatchedOpener(ctx.text.slice(0, ctx.offset - len), open, close)) return false;
    const next = ctx.text.slice(0, ctx.offset - len) + open + close + ctx.text.slice(ctx.offset);
    if (typeof ctx.node.setTextContent === 'function') ctx.node.setTextContent(next);
    else if (typeof ctx.node.spliceText === 'function') ctx.node.spliceText(ctx.offset - len, len, open + close);
    else return false;
    return setCaretOnNode(selection, ctx.node, ctx.offset - len + open.length);
  });
}

/**
 * 一次性把「这次输入」在模型层做完：决策与动作在同一个 update 回调里原子完成，
 * 决策为 null 时不会改任何东西（调用方可以安全地回退到 DOM 路径）。
 * @returns 'pair' | 'wrap' | 'skip' | null
 */
export function applyInputInEditor(root, data, index) {
  const editor = editorOf(root);
  if (!editor) return null;
  let outcome = null;
  const ok = withEditorSelection(editor, (selection) => {
    const plan = planFromSelection(selection, data, index);
    if (!plan) return false;
    if (typeof selection.insertText !== 'function' && plan.kind !== 'skip') return false;
    if (plan.kind === 'pair' || plan.kind === 'nest') {
      selection.insertText(plan.open + plan.close);
      placeCaretInsidePair(selection, plan.open, plan.close);
      outcome = plan.kind;
      return true;
    }
    if (plan.kind === 'wrap') {
      const text = selectionText(selection);
      if (text.length === 0) return false;
      selection.insertText(plan.open + text + plan.close);
      const ctx = caretPoint(selection);
      const inserted = plan.open + text + plan.close;
      if (ctx && ctx.text.slice(ctx.offset - inserted.length, ctx.offset) === inserted) {
        const innerEnd = ctx.offset - plan.close.length;
        setRangeOnNode(selection, ctx.node, innerEnd - text.length, innerEnd);
      }
      outcome = 'wrap';
      return true;
    }
    if (plan.kind === 'skip') {
      const ctx = caretPoint(selection);
      if (ctx) setCaretOnNode(selection, ctx.node, ctx.offset + plan.close.length);
      outcome = 'skip';
      return true;
    }
    return false;
  });
  return ok ? outcome : null;
}

/** 退格：光标正好夹在一对空符号中间时在模型层删掉两个。 */
export function applyBackspaceInEditor(root, index) {
  const editor = editorOf(root);
  if (!editor) return false;
  return deletePairInEditor(editor, index);
}

/**
 * 建立一套监听。返回 { version, stats, log, enabled, setEnabled, dispose }。
 * 动作优先走 Lexical 模型层，拿不到编辑器实例时回退到纯 DOM 操作。
 */
export function createAutoPair(win, doc, options = {}) {
  const index = createPairIndex(options.pairs || DEFAULT_PAIRS);
  const frame = typeof win.requestAnimationFrame === 'function'
    ? win.requestAnimationFrame.bind(win)
    : (fn) => win.setTimeout(fn, 16);

  const stats = {
    paired: 0, wrapped: 0, skipped: 0, deleted: 0, blocked: 0, errors: 0,
    nested: 0, viaEditor: 0, viaDom: 0, viaTextarea: 0,
    imeCommits: 0, imePaired: 0, imeSkippedCloser: 0, imeDuplicate: 0, imeNotSettled: 0,
    imeWrapped: 0,
  };
  const log = [];
  /** 诊断用的事件流水（最近 24 条）：事后能从磁盘上的报告里还原「到底发生了什么事件」。 */
  const trace = [];

  function traceEvent(kind, detail) {
    try {
      trace.push({ t: Date.now(), kind, d: detail === undefined ? '' : String(detail).slice(0, 16) });
      if (trace.length > 24) trace.shift();
    } catch (error) {
      /* 诊断失败不能影响功能 */
    }
  }
  let disposed = false;
  let internal = false;
  let enabled = true;
  let publishTimer = null;
  /**
   * 输入法开始组合时，模型里如果选中了一段文字，就把原文记在这里。
   * 提交完成时那段文字已经被输入法替换掉，只有这一刻还读得到 —— 用它把「替换」改回「包裹」。
   */
  let pendingWrap = null;
  /** 同理，问答卡片那种普通 textarea 在输入法开始组合时记下选区，提交后再补包裹。 */
  let pendingTextarea = null;

  const report = { version: VERSION, installedAt: new Date().toISOString(), stats, log, enabled: true };

  /** 运行环境自检：报告里能直接看出「锚点找得到吗 / modify 可用吗」。 */
  function capabilities() {
    let composer = null;
    try {
      composer = doc.querySelector ? doc.querySelector(COMPOSER_SELECTOR) : null;
    } catch (error) {
      composer = null;
    }
    let modify = false;
    try {
      const sel = doc.getSelection ? doc.getSelection() : null;
      modify = !!sel && typeof sel.modify === 'function';
    } catch (error) {
      modify = false;
    }
    const editor = editorOf(composer);
    return {
      composerFound: composer !== null,
      composerEditable: composer === null ? null : composer.getAttribute('contenteditable'),
      selectionModify: modify,
      execCommand: typeof doc.execCommand === 'function',
      lexicalEditor: editor !== null,
      lexicalUpdate: !!(editor && typeof editor.update === 'function'),
      composerReady: composer !== null && editor !== null,
      editorError: editorDiagnostics().lastError,
      answerTextareas: countAnswerTextareas(),
    };
  }

  function writeReport() {
    report.enabled = enabled;
    report.at = new Date().toISOString();
    report.log = log.slice(-12);
    report.trace = trace.slice(-24);
    report.caps = capabilities();
    try {
      win.localStorage.setItem(STORAGE_PREFIX, VERSION + ' ' + report.at);
      win.localStorage.setItem(STORAGE_PREFIX + '-report', JSON.stringify(report));
    } catch (error) {
      /* 存储不可用时静默 */
    }
  }

  function publish() {
    if (publishTimer !== null) return;
    publishTimer = -1; // 先占位：即使 setTimeout 同步执行也不会把定时器状态弄乱
    const run = () => {
      publishTimer = null;
      writeReport();
    };
    try {
      win.setTimeout(run, 1000);
    } catch (error) {
      run();
    }
  }

  function note(kind, detail) {
    log.push({ t: Date.now(), kind, d: detail === undefined ? '' : String(detail).slice(0, 12) });
    if (log.length > 12) log.shift();
    publish();
  }

  function selection() {
    try {
      if (typeof doc.getSelection === 'function') return doc.getSelection();
      return win.getSelection ? win.getSelection() : null;
    } catch (error) {
      return null;
    }
  }

  function composerOf(target) {
    if (!target) return null;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || typeof el.closest !== 'function') return null;
    const root = el.closest(COMPOSER_SELECTOR);
    if (!root) return null;
    if (root.getAttribute('contenteditable') !== 'true') return null;
    return root;
  }

  // ---- 问答卡片里的普通 textarea -------------------------------------------
  // DSH 的 user-questions 卡片用的是 <textarea>（React 受控组件），既不是 contenteditable
  // 也不是 Lexical：模型层那套全用不上，这里走「原生选区 + setRangeText」。

  /** 用户在 localStorage 里给的额外选择器（逗号分隔），用来覆盖本机别的输入框。 */
  function extraTextareaSelectors() {
    try {
      const raw = win.localStorage.getItem(STORAGE_PREFIX + ':textareas');
      if (!raw) return [];
      return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  /**
   * 只认「问答类」textarea：卡片里的输入框旁边有个 aria-hidden 的等高镜像 div、类名带
   * fieldInput。别处的 textarea（终端、命令面板……）一律不碰。
   */
  function isAnswerTextarea(el) {
    const parent = el.parentElement;
    if (parent && typeof parent.querySelector === 'function') {
      try {
        if (parent.querySelector('[aria-hidden="true"]')) return true;
      } catch (error) {
        /* 忽略 */
      }
    }
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls && cls.indexOf('fieldInput') >= 0) return true;
    return extraTextareaSelectors().some((selector) => {
      try {
        return typeof el.matches === 'function' && el.matches(selector);
      } catch (error) {
        return false;
      }
    });
  }

  function textareaOf(target) {
    if (!target) return null;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || String(el.tagName || '').toUpperCase() !== 'TEXTAREA') return null;
    if (el.disabled || el.readOnly) return null;
    if (typeof el.setRangeText !== 'function') return null;
    if (!isAnswerTextarea(el)) return null;
    return el;
  }

  function countAnswerTextareas() {
    try {
      const list = doc.querySelectorAll ? doc.querySelectorAll('textarea') : [];
      let count = 0;
      for (let i = 0; i < list.length; i += 1) if (isAnswerTextarea(list[i])) count += 1;
      return count;
    } catch (error) {
      return 0;
    }
  }

  /** 受控组件只认 input 事件：改完值必须自己发一个，否则它的 state 不会跟上。 */
  function dispatchInputEvent(el, data, inputType) {
    try {
      const Ctor = win.InputEvent || win.Event;
      el.dispatchEvent(new Ctor('input', { bubbles: true, inputType, data: data === undefined ? null : data }));
    } catch (error) {
      try {
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      } catch (inner) {
        /* 忽略 */
      }
    }
  }

  function applyTextareaEdit(el, edit, inputType) {
    const value = typeof el.value === 'string' ? el.value : '';
    if (value.slice(edit.start, edit.end) !== edit.text) {
      try {
        el.setRangeText(edit.text, edit.start, edit.end, 'end');
      } catch (error) {
        stats.errors += 1;
      }
    }
    try {
      el.selectionStart = edit.selStart;
      el.selectionEnd = edit.selEnd;
    } catch (error) {
      /* 某些环境不支持，忽略 */
    }
    dispatchInputEvent(el, edit.text, inputType);
  }

  function handleTextareaBeforeInput(area, event) {
    const data = event.data;
    if (typeof data !== 'string' || charLength(data) !== 1) return;
    if (!index.openToClose.has(data) && !index.closers.has(data)) return;
    const edit = planTextareaEdit({
      value: area.value,
      start: area.selectionStart,
      end: area.selectionEnd,
      data,
    }, index);
    traceEvent('ta-bi', data + '>' + (edit ? edit.kind : 'none'));
    if (!edit) return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    applyTextareaEdit(area, edit, event.inputType || 'insertText');
    stats.viaTextarea += 1;
    if (edit.kind === 'wrap') {
      stats.wrapped += 1;
      note('wrap-textarea', data);
    } else if (edit.kind === 'skip') {
      stats.skipped += 1;
    } else {
      stats.paired += 1;
      if (edit.kind === 'nest') stats.nested += 1;
      note('pair-textarea', data);
    }
    traceEvent('ta-' + edit.kind, data);
  }

  function handleTextareaBackspace(area, event) {
    const edit = planTextareaEdit({
      value: area.value,
      start: area.selectionStart,
      end: area.selectionEnd,
      data: null,
    }, index);
    if (!edit) return false;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    applyTextareaEdit(area, edit, 'deleteContentBackward');
    stats.deleted += 1;
    stats.viaTextarea += 1;
    note('delete-pair-textarea', 'deletePair');
    traceEvent('ta-deletePair', '');
    return true;
  }

  /**
   * 输入法提交：`insertCompositionText` 不可拦截，字符已经进 value 了，
   * 等浏览器自己那一轮 input 走完（setTimeout 0）再补右半边。
   */
  function scheduleTextareaComposition(area, data) {
    const snapshot = pendingTextarea && pendingTextarea.el === area ? pendingTextarea : null;
    pendingTextarea = null;
    const run = () => {
      if (disposed || !enabled) return;
      try {
        const caret = typeof area.selectionEnd === 'number' ? area.selectionEnd : area.value.length;
        const edit = planTextareaIme({ value: area.value, caret, data, snapshot }, index);
        if (!edit) {
          traceEvent('ta-ce-none', String(data));
          return;
        }
        applyTextareaEdit(area, edit, 'insertCompositionText');
        stats.viaTextarea += 1;
        if (edit.kind === 'wrap') {
          stats.wrapped += 1;
          stats.imeWrapped += 1;
          note('wrap-textarea-ime', String(data));
        } else if (edit.kind === 'skip') {
          stats.skipped += 1;
        } else {
          stats.paired += 1;
          if (edit.kind === 'nest') stats.nested += 1;
          note('pair-textarea-ime', String(data));
        }
        traceEvent('ta-ce-' + edit.kind, String(data));
      } catch (error) {
        stats.errors += 1;
      }
    };
    try {
      win.setTimeout(run, 0);
    } catch (error) {
      run();
    }
  }

  function activeRange(root) {
    const sel = selection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range || !range.startContainer) return null;
    if (root && typeof root.contains === 'function' && !root.contains(range.startContainer)) return null;
    return { sel, range };
  }

  function canModify(sel) {
    return !!sel && typeof sel.modify === 'function';
  }

  /** 读光标前/后一个字符（借 modify 选区，跨文本节点也准），读完恢复原选区。 */
  function probeChar(direction) {
    const sel = selection();
    if (!canModify(sel) || sel.rangeCount === 0) return '';
    const saved = sel.getRangeAt(0).cloneRange();
    let text = '';
    try {
      sel.modify('extend', direction, 'character');
      text = sel.toString();
    } catch (error) {
      text = '';
    }
    try {
      sel.removeAllRanges();
      sel.addRange(saved);
    } catch (error) {
      /* 恢复失败也不能崩 */
    }
    return text;
  }

  /** 读光标前 n 个字符（用于确认“我刚插入的内容确实已经落到 DOM 里”）。 */
  function textBeforeCaret(count) {
    const sel = selection();
    if (!canModify(sel) || sel.rangeCount === 0) return '';
    const saved = sel.getRangeAt(0).cloneRange();
    let text = '';
    try {
      for (let i = 0; i < count; i += 1) sel.modify('extend', 'backward', 'character');
      text = sel.toString();
    } catch (error) {
      text = '';
    }
    try {
      sel.removeAllRanges();
      sel.addRange(saved);
    } catch (error) {
      /* 同上 */
    }
    return text;
  }

  function moveCaret(direction) {
    const sel = selection();
    if (!canModify(sel)) return false;
    try {
      sel.modify('move', direction, 'character');
      return true;
    } catch (error) {
      stats.errors += 1;
      return false;
    }
  }

  function extendCaret(direction) {
    const sel = selection();
    if (!canModify(sel)) return false;
    try {
      sel.modify('extend', direction, 'character');
      return true;
    } catch (error) {
      stats.errors += 1;
      return false;
    }
  }

  function notifySelection() {
    try {
      const Ctor = win.Event || (doc.defaultView && doc.defaultView.Event);
      if (Ctor && typeof doc.dispatchEvent === 'function') doc.dispatchEvent(new Ctor('selectionchange'));
    } catch (error) {
      /* 可选动作 */
    }
  }

  function exec(command, value) {
    internal = true;
    try {
      if (typeof doc.execCommand !== 'function') return false;
      return doc.execCommand(command, false, value) !== false;
    } catch (error) {
      stats.errors += 1;
      return false;
    } finally {
      internal = false;
    }
  }

  /**
   * 等编辑器把插入真正提交到 DOM 后再调整光标：
   * 先同步试一次（discrete update 会立刻提交），不满足就下一帧再试，最多 8 帧。
   */
  function settle(check, action, tries = 0) {
    if (disposed) return;
    let ready = false;
    try {
      ready = check() === true;
    } catch (error) {
      ready = false;
    }
    if (ready) {
      try {
        action();
      } catch (error) {
        stats.errors += 1;
      }
      return;
    }
    if (tries >= 8) return;
    frame(() => settle(check, action, tries + 1));
  }

  function doPair(open, close) {
    if (!exec('insertText', open + close)) {
      stats.blocked += 1;
      note('blocked', open);
      return;
    }
    settle(
      () => textBeforeCaret(charLength(open + close)) === open + close,
      () => {
        moveCaret('backward');
        notifySelection();
        stats.paired += 1;
        note('pair', open + close);
      },
    );
  }

  function doWrap(open, close, selected) {
    const inserted = open + selected + close;
    if (!exec('insertText', inserted)) {
      stats.blocked += 1;
      note('blocked', open);
      return;
    }
    const inner = charLength(selected);
    settle(
      () => textBeforeCaret(charLength(inserted)) === inserted,
      () => {
        moveCaret('backward'); // 越过右半边
        for (let i = 0; i < inner; i += 1) extendCaret('backward'); // 选回原文字
        notifySelection();
        stats.wrapped += 1;
        note('wrap', open + close);
      },
    );
  }

  /** 输入法把 `（` 这类左半边直接提交上来时，补上右半边。 */
  function doAppendClose(close) {
    if (!exec('insertText', close)) {
      stats.blocked += 1;
      note('blocked', close);
      return;
    }
    settle(
      () => textBeforeCaret(charLength(close)) === close,
      () => {
        moveCaret('backward');
        notifySelection();
        stats.paired += 1;
        note('pair-ime', close);
      },
    );
  }

  /** DOM 兜底：输入法多提交了一个右半边 —— 删掉刚提交的那个，光标越过原来那个。 */
  function doSkipCommittedCloser() {
    if (!extendCaret('backward')) return; // 选中刚提交的重复右半边
    exec('delete');
    if (moveCaret('forward')) notifySelection();
    stats.skipped += 1;
    note('skip-ime-dom');
  }

  function doDeletePair() {
    moveCaret('backward'); // 光标移到左半边前
    extendCaret('forward'); // 选中左半边
    extendCaret('forward'); // 选中左+右
    exec('delete');
    notifySelection();
    stats.deleted += 1;
    note('delete-pair');
  }

  function onBeforeInput(event) {
    if (disposed || !enabled || internal) return;
    if (event.defaultPrevented) return;
    const area = textareaOf(event.target);
    if (area) {
      // 问答卡片的普通 textarea：只有可直接打字的输入才拦得住，输入法走 composition 那条路
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
        handleTextareaBeforeInput(area, event);
      }
      return;
    }
    const type = event.inputType;
    const data = event.data;
    const pairChar = typeof data === 'string' && charLength(data) === 1
      && (index.openToClose.has(data) || index.closers.has(data));
    if (type !== 'insertText' && type !== 'insertReplacementText') {
      // 例：insertCompositionText —— 输入法正在组合，这种事件不可拦截，只能记下来事后处理
      if (pairChar) traceEvent('bi-other', type + ':' + data);
      // 兜底：有的浏览器先删选区再发 compositionstart，那里就记不到原文了。
      // beforeinput 在 DOM 变动之前发出，这时模型里通常还留着那段选区。
      if (pendingWrap === null && type === 'insertCompositionText') {
        const root = composerOf(event.target);
        if (root) {
          pendingWrap = readTextSelection(root);
          if (pendingWrap) traceEvent('bi-cs', pendingWrap.text.slice(0, 8));
        }
      }
      return;
    }
    if (typeof data !== 'string' || charLength(data) !== 1) return;
    const isOpen = index.openToClose.has(data);
    const isClose = index.closers.has(data);
    if (!isOpen && !isClose) return; // 普通字符完全不插手
    traceEvent('bi', data);
    const root = composerOf(event.target);
    if (!root) return;
    if (isClose && !isOpen && probeChar('forward') !== data) return; // 不是「跳过右半边」的场景

    // 1) 模型层：插入与光标在一次 editor.update 里原子完成，模型与 DOM 不再脱节
    const viaEditor = applyInputInEditor(root, data, index);
    if (viaEditor !== null) {
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      stats.viaEditor += 1;
      if (viaEditor === 'pair') {
        stats.paired += 1;
        note('pair', data);
      } else if (viaEditor === 'nest') {
        stats.paired += 1;
        stats.nested += 1;
        note('nest-quote', data);
      } else if (viaEditor === 'wrap') {
        stats.wrapped += 1;
        note('wrap', data);
      } else if (viaEditor === 'skip') {
        stats.skipped += 1;
        note('skip', data);
      }
      return;
    }

    // 2) DOM 兜底：拿不到 Lexical 编辑器实例时才走（行为回到旧版）
    const context = activeRange(root);
    if (!context) return;
    const range = context.range;
    const collapsed = range.collapsed === true;
    const textSelection = collapsed ? false : isPlainTextRange(range);
    const charAfter = collapsed ? probeChar('forward') : '';
    const charBefore = collapsed ? probeChar('backward') : '';
    const plan = planInsert(data, { collapsed, charAfter, charBefore, textSelection }, index);
    if (!plan) return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    stats.viaDom += 1;
    if (plan.kind === 'pair') doPair(plan.open, plan.close);
    else if (plan.kind === 'nest') {
      stats.nested += 1;
      note('nest-quote', data);
      doPair(plan.open, plan.close);
    } else if (plan.kind === 'wrap') doWrap(plan.open, plan.close, context.sel.toString());
    else if (plan.kind === 'skip') {
      if (moveCaret('forward')) {
        notifySelection();
        stats.skipped += 1;
        note('skip', data);
      }
    }
  }

  function onKeyDown(event) {
    if (disposed || !enabled || internal) return;
    if (event.defaultPrevented) return;
    if (typeof event.key === 'string' && event.key.length === 1
      && (index.openToClose.has(event.key) || index.closers.has(event.key))) {
      // 只记配对键的按下：用来区分「输入法没给事件」和「我们判断错了」
      traceEvent('kd', event.key + (event.isComposing ? ':c' : ''));
    }
    if (event.key !== 'Backspace' && event.keyCode !== 8) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    const area = textareaOf(event.target);
    if (area) {
      handleTextareaBackspace(area, event);
      return;
    }
    const root = composerOf(event.target);
    if (!root) return;
    const context = activeRange(root);
    if (!context || context.range.collapsed !== true) return;
    const plan = planBackspace({
      collapsed: true,
      charBefore: probeChar('backward'),
      charAfter: probeChar('forward'),
    }, index);
    if (!plan || plan.kind !== 'deletePair') return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    // 优先模型层删（保证模型选区与 DOM 一致），拿不到编辑器再走 DOM
    if (applyBackspaceInEditor(root, index)) {
      stats.deleted += 1;
      stats.viaEditor += 1;
      note('delete-pair', plan.kind);
      return;
    }
    stats.viaDom += 1;
    doDeletePair();
  }

  function onCompositionStart(event) {
    if (disposed || !enabled || internal) return;
    const area = textareaOf(event.target);
    if (area) {
      const start = typeof area.selectionStart === 'number' ? area.selectionStart : 0;
      const end = typeof area.selectionEnd === 'number' ? area.selectionEnd : start;
      pendingTextarea = { el: area, start, end, text: String(area.value || '').slice(start, end) };
      if (pendingTextarea.text) traceEvent('ta-cs', pendingTextarea.text.slice(0, 8));
      return;
    }
    const root = composerOf(event.target);
    if (!root) return;
    // 输入法一开始组合，浏览器就会把选中的文字删掉换成它自己的内容 —— 原文只在这一刻还在
    pendingWrap = readTextSelection(root);
    if (pendingWrap) traceEvent('cs', pendingWrap.text.slice(0, 8));
  }

  function onCompositionEnd(event) {
    if (disposed || !enabled || internal) return;
    const area = textareaOf(event.target);
    if (area) {
      scheduleTextareaComposition(area, event.data);
      return;
    }
    const wrapSnapshot = pendingWrap;
    pendingWrap = null;
    const root = composerOf(event.target);
    if (!root) return;
    const data = event.data;
    if (typeof data !== 'string' || data.length === 0) return;
    const chars = Array.from(data);
    const last = chars[chars.length - 1];
    const isOpen = index.openToClose.has(last);
    const isClose = index.closers.has(last);
    if (!isOpen && !isClose) return;
    stats.imeCommits += 1;
    traceEvent('ce', last);
    const closer = isOpen ? index.openToClose.get(last) : last;
    // DOM 兜底路径：v2 之前一直用它，能用但不保证模型选区跟着走。现在只在
    // 「拿不到 Lexical 实例」或「模型迟迟读不到这次提交」时才走，保证任何情况下都补得上。
    const domFallback = () => {
      if (disposed || internal) return;
      const context = activeRange(root);
      if (!context || context.range.collapsed !== true) return;
      if (probeChar('backward') !== last) return;
      if (isClose && !isOpen && probeChar('forward') !== last) return; // 不是「跳过右半边」的场景
      stats.viaDom += 1;
      traceEvent('ce-dom', last);
      if (isOpen) doAppendClose(index.openToClose.get(last));
      else doSkipCommittedCloser();
    };
    const editor = editorOf(root);
    if (!editor) {
      // 拿不到 Lexical 实例（极老版本）：只走 DOM 兜底
      frame(domFallback);
      return;
    }
    // 输入法提交的时刻与 Lexical 把这次提交写进模型的时刻差的不止一拍：DOM 探针和模型
    // 都可能还停在提交前。老实现「等一帧 → 用 DOM 探针判断 → 对不上就整段放弃」，在中文
    // 输入法下会让第二次按引号键提交的右引号孤零零留在正文里（第一次成对、第二次不成对）。
    // 改成轮询模型，直到这次提交真的落进模型（提交的字符就在光标左边），再做判断。
    let tries = 0;
    const step = () => {
      if (disposed || internal) return;
      const caret = currentCaret(root);
      if (!caret) {
        // 这个 DSH 版本读不到模型光标：不空等，直接走 DOM 兜底（否则会「什么都不补」）
        stats.imeNotSettled += 1;
        traceEvent('ce-nocaret', last);
        domFallback();
        return;
      }
      const absorbed = caret.text.slice(caret.offset - last.length, caret.offset) === last;
      if (!absorbed) {
        if (tries < 12) {
          tries += 1;
          frame(step);
          return;
        }
        // 模型迟迟没吸收这次提交：交给 DOM 兜底，而不是什么都不做
        stats.imeNotSettled += 1;
        traceEvent('ce-stale', last + ' @' + caret.offset + ' …' + caret.text.slice(-4));
        domFallback();
        return;
      }
      if (wrapSnapshot && isOpen && data === last) {
        const outcome = wrapCommittedOpenInEditor(editor, last, index.openToClose.get(last), wrapSnapshot);
        if (outcome.ok) {
          // 输入法把选中的文字替换成了左半边：还原成「包住原文」
          stats.wrapped += 1;
          stats.imeWrapped += 1;
          stats.viaEditor += 1;
          note('wrap-ime', last);
          traceEvent('wrap-ime', last);
          return;
        }
        traceEvent('wrap-miss', outcome.reason);
      }
      if (isOwnCompletion(root, isOpen ? last : '', closer)) {
        // 重复的 compositionend：右边那个右半边是我们自己刚补的，不是新输入
        stats.imeDuplicate += 1;
        traceEvent('dup', last);
        return;
      }
      const viaEditor = finishCompositionInEditor(root, last, index);
      if (viaEditor === 'pair') {
        stats.paired += 1;
        stats.imePaired += 1;
        stats.viaEditor += 1;
        note('pair-ime', last);
        traceEvent('pair', last);
        return;
      }
      if (viaEditor === 'nest') {
        stats.paired += 1;
        stats.nested += 1;
        stats.viaEditor += 1;
        note('nest-quote-ime', last);
        traceEvent('nest', last);
        return;
      }
      if (viaEditor === 'skip') {
        stats.skipped += 1;
        stats.imeSkippedCloser += 1;
        stats.viaEditor += 1;
        note('skip-ime', last);
        traceEvent('skip', last);
        return;
      }
      // 判断结果就是「不动」：例如收尾的右引号、光标不在空引号对中间 —— 保持原样
      traceEvent('noop', last);
    };
    frame(step);
  }

  /**
   * 光标右边那个右半边，是不是我们自己刚补上去的？
   * 只有「重复的 compositionend」会命中；三种情况都要同时对上才算：
   *   ① 同一个文本节点、同一处光标位置；
   *   ② 周遭文字就是「左侧 open、右侧 close、光标夹在中间」；
   *   ③ 3 秒以内。
   * 用户在已有的一对里再打一个左半边（嵌套）时，输入法会把光标往右推一格，①就对不上，
   * 于是照常再补一个右半边。
   */
  function isOwnCompletion(root, open, closer) {
    const info = lastAppendedCloser();
    if (!info || info.close !== closer || info.open !== open) return false;
    if (Date.now() - info.at > 3000) return false;
    const caret = currentCaret(root);
    if (!caret || caret.key !== info.key || caret.offset !== info.caretOffset) return false;
    if (typeof info.open !== 'string' || info.open.length === 0) return false;
    const left = caret.text.slice(caret.offset - info.open.length, caret.offset);
    const right = caret.text.slice(caret.offset, caret.offset + closer.length);
    return left === info.open && right === closer;
  }

  function attach() {
    doc.addEventListener('beforeinput', onBeforeInput, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('compositionstart', onCompositionStart, true);
    doc.addEventListener('compositionend', onCompositionEnd, true);
  }

  function detach() {
    try {
      doc.removeEventListener('beforeinput', onBeforeInput, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('compositionstart', onCompositionStart, true);
      doc.removeEventListener('compositionend', onCompositionEnd, true);
    } catch (error) {
      /* 忽略 */
    }
  }

  try {
    if (win.localStorage.getItem(STORAGE_PREFIX + ':enabled') === 'off') enabled = false;
  } catch (error) {
    /* 默认开 */
  }

  attach();
  writeReport();

  // 周期性自检报告（可以直接从磁盘上的 Local Storage 读到，不需要开 DevTools）。
  let tick = null;
  if (typeof win.setInterval === 'function') {
    tick = win.setInterval(() => {
      if (!disposed) writeReport();
    }, 3000);
  }

  return {
    version: VERSION,
    stats,
    log,
    trace,
    report,
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = !!next;
      try {
        win.localStorage.setItem(STORAGE_PREFIX + ':enabled', enabled ? 'on' : 'off');
      } catch (error) {
        /* 忽略 */
      }
      publish();
      return enabled;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (tick !== null) {
        try {
          win.clearInterval(tick);
        } catch (error) {
          /* 忽略 */
        }
      }
      detach();
    },
    _internals: { probeChar, textBeforeCaret, composerOf, isPlainTextRange },
  };
}

/** 安装（幂等：重复调用会先卸掉上一份，便于插件热重载）。 */
export function installAutoPair(win = globalThis, doc = win && win.document, options = {}) {
  if (!doc || typeof doc.addEventListener !== 'function') return null;
  const key = '__dshComposerAutoPair';
  try {
    if (win[key] && typeof win[key].dispose === 'function') win[key].dispose();
  } catch (error) {
    /* 忽略 */
  }
  const api = createAutoPair(win, doc, options);
  win[key] = api;
  return api;
}

/**
 * 客户端插件入口：DSH 客户端模块系统在插件启用时调用 `apply(ctx)`。
 * 用 `ctx.effect` 登记清理，插件停用 / 热重载时监听会被摘掉。
 * @param ctx - 客户端 cordis 上下文（可缺省，此时只装不卸）。
 * @returns 安装好的实例（便于测试断言），失败返回 null。
 */
export function apply(ctx) {
  const win = typeof window === 'undefined' ? null : window;
  if (!win || !win.document) return null;
  let api = null;
  try {
    api = installAutoPair(win, win.document);
  } catch (error) {
    // 安装失败不能影响宿主，但要把原因留在能读出来的地方
    try {
      win.localStorage.setItem(
        STORAGE_PREFIX + ':error',
        String((error && error.stack) || error).slice(0, 600) + ' @ ' + new Date().toISOString(),
      );
    } catch (inner) {
      /* 忽略 */
    }
    return null;
  }
  try {
    win.localStorage.setItem(STORAGE_PREFIX + ':probe', VERSION + ' loaded ' + new Date().toISOString());
  } catch (error) {
    /* 忽略 */
  }
  if (api !== null && ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => api.dispose());
  }
  return api;
}

