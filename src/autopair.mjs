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

export const VERSION = 'v4';
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
    const selection = state ? state._selection : null;
    const point = selection && selection.anchor;
    if (!point || point.type !== 'text') return null;
    const node = typeof point.getNode === 'function' ? point.getNode() : null;
    const text = node && typeof node.getTextContent === 'function' ? node.getTextContent() : '';
    return { key: point.key, offset: point.offset, text };
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
    return skipCommittedCloserInEditor(editor, last) ? 'skip' : null;
  }
  return null;
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
    nested: 0, viaEditor: 0, viaDom: 0,
    imeCommits: 0, imePaired: 0, imeSkippedCloser: 0, imeDuplicate: 0,
  };
  const log = [];
  let disposed = false;
  let internal = false;
  let enabled = true;
  let publishTimer = null;

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
    };
  }

  function writeReport() {
    report.enabled = enabled;
    report.at = new Date().toISOString();
    report.log = log.slice(-12);
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
    const type = event.inputType;
    if (type !== 'insertText' && type !== 'insertReplacementText') return;
    const data = event.data;
    if (typeof data !== 'string' || charLength(data) !== 1) return;
    const isOpen = index.openToClose.has(data);
    const isClose = index.closers.has(data);
    if (!isOpen && !isClose) return; // 普通字符完全不插手
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
    if (event.key !== 'Backspace' && event.keyCode !== 8) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || event.keyCode === 229) return;
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

  function onCompositionEnd(event) {
    if (disposed || !enabled || internal) return;
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
    // 输入法提交时刻与 DOM/Lexical 落库时刻可能差一拍，等一帧再看。
    frame(() => {
      if (disposed || internal) return;
      const context = activeRange(root);
      if (!context || context.range.collapsed !== true) return;
      if (probeChar('backward') !== last) return;
      if (isClose && !isOpen && probeChar('forward') !== last) return; // 不是「跳过右半边」的场景
      const closer = isOpen ? index.openToClose.get(last) : last;
      if (isOwnCompletion(root, isOpen ? last : '', closer)) {
        // 重复的 compositionend：右边那个右半边是我们自己刚补的，不是新输入
        stats.imeDuplicate += 1;
        return;
      }
      const viaEditor = finishCompositionInEditor(root, last, index);
      if (viaEditor === 'pair') {
        stats.paired += 1;
        stats.imePaired += 1;
        stats.viaEditor += 1;
        note('pair-ime', last);
        return;
      }
      if (viaEditor === 'nest') {
        stats.paired += 1;
        stats.nested += 1;
        stats.viaEditor += 1;
        note('nest-quote-ime', last);
        return;
      }
      if (viaEditor === 'skip') {
        stats.skipped += 1;
        stats.imeSkippedCloser += 1;
        stats.viaEditor += 1;
        note('skip-ime', last);
        return;
      }
      // 模型层不可用：DOM 兜底
      stats.viaDom += 1;
      if (isOpen) doAppendClose(index.openToClose.get(last));
      else doSkipCommittedCloser();
    });
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
    doc.addEventListener('compositionend', onCompositionEnd, true);
  }

  function detach() {
    try {
      doc.removeEventListener('beforeinput', onBeforeInput, true);
      doc.removeEventListener('keydown', onKeyDown, true);
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

