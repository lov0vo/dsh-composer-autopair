/**
 * dsh-composer-autopair 单测：纯逻辑 + 用一个迷你 DOM 模拟器跑完整交互链路 + 插件入口/bundle 形状。
 * 运行： node --test src/autopair.test.mjs      （或 npm test）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAIRS,
  createPairIndex,
  planInsert,
  planBackspace,
  planFromSelection,
  isPlainTextRange,
  installAutoPair,
  createAutoPair,
  apply,
} from './autopair.mjs';
import { renderBundle } from '../build.mjs';

const index = createPairIndex(DEFAULT_PAIRS);
const textNode = () => ({ nodeType: 3 });

// ---------------------------------------------------------------- 纯逻辑

test('planInsert: 半角与全角左半边都要配对', () => {
  assert.deepEqual(planInsert('(', { collapsed: true }, index), { kind: 'pair', open: '(', close: ')' });
  assert.deepEqual(planInsert('（', { collapsed: true }, index), { kind: 'pair', open: '（', close: '）' });
  assert.deepEqual(planInsert('“', { collapsed: true }, index), { kind: 'pair', open: '“', close: '”' });
  assert.deepEqual(planInsert('【', { collapsed: true }, index), { kind: 'pair', open: '【', close: '】' });
});

test('planInsert: 右半边后面跟着同一个右半边时跳过它', () => {
  assert.deepEqual(planInsert(')', { collapsed: true, charAfter: ')' }, index), { kind: 'skip' });
  assert.deepEqual(planInsert('）', { collapsed: true, charAfter: '）' }, index), { kind: 'skip' });
  assert.equal(planInsert(')', { collapsed: true, charAfter: 'x' }, index), null);
});

test('planInsert: 一对空引号中间按引号键 = 再嵌一对（不跳过）', () => {
  // 中文输入法在 `“` 之后按引号键给的是 `”`，此时不该跳过去
  assert.deepEqual(
    planInsert('”', { collapsed: true, charBefore: '“', charAfter: '”' }, index),
    { kind: 'nest', open: '“', close: '”' },
  );
  // 引号里有内容时，仍然是「跳过」（用来给引号收尾）
  assert.deepEqual(
    planInsert('”', { collapsed: true, charBefore: '好', charAfter: '”' }, index),
    { kind: 'skip' },
  );
  // 括号不受影响：() 中间打 ) 依然是跳过
  assert.deepEqual(
    planInsert(')', { collapsed: true, charBefore: '(', charAfter: ')' }, index),
    { kind: 'skip' },
  );
});

test('planInsert: 有选区时包裹，非纯文本选区不包裹', () => {
  assert.deepEqual(planInsert('(', { collapsed: false, textSelection: true }, index), { kind: 'wrap', open: '(', close: ')' });
  assert.equal(planInsert('(', { collapsed: false, textSelection: false }, index), null);
});

test('planInsert: 普通字符、多字符、非字符串一律不动', () => {
  assert.equal(planInsert('a', { collapsed: true }, index), null);
  assert.equal(planInsert('()', { collapsed: true }, index), null);
  assert.equal(planInsert(undefined, { collapsed: true }, index), null);
});

test('planBackspace: 只在一对空括号中间时整体删除', () => {
  assert.deepEqual(planBackspace({ collapsed: true, charBefore: '(', charAfter: ')' }, index), { kind: 'deletePair' });
  assert.equal(planBackspace({ collapsed: true, charBefore: '(', charAfter: 'x' }, index), null);
  assert.equal(planBackspace({ collapsed: true, charBefore: 'a', charAfter: ')' }, index), null);
  assert.equal(planBackspace({ collapsed: false, charBefore: '(', charAfter: ')' }, index), null);
});

test('isPlainTextRange: 文本节点 + 无 chip 才返回 true', () => {
  assert.equal(isPlainTextRange({
    startContainer: textNode(),
    endContainer: textNode(),
    toString: () => 'abc',
    cloneContents: () => ({ querySelector: () => null }),
  }), true);
  assert.equal(isPlainTextRange({
    startContainer: { nodeType: 1 },
    endContainer: textNode(),
    toString: () => 'abc',
    cloneContents: () => ({ querySelector: () => null }),
  }), false);
  assert.equal(isPlainTextRange({
    startContainer: textNode(),
    endContainer: textNode(),
    toString: () => 'abc',
    cloneContents: () => ({ querySelector: () => ({}) }),
  }), false, '选区里有 @ chip 时不能整体替换');
});

// ---------------------------------------------------------------- DOM 模拟器

function createWorld({ deferInsert = false } = {}) {
  const model = [];
  const frames = [];

  const win = {
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); },
    },
    setTimeout() { return 0; },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    Event: class Event { constructor(type) { this.type = type; } },
  };

  class FakeSelection {
    constructor() { this.anchor = 0; this.focus = 0; this.rangeCount = 1; }
    getRangeAt() {
      const sel = this;
      return {
        __anchor: sel.anchor,
        __focus: sel.focus,
        startContainer: textNode(),
        endContainer: textNode(),
        get collapsed() { return sel.anchor === sel.focus; },
        cloneRange() { return { __anchor: sel.anchor, __focus: sel.focus }; },
        toString() {
          const a = Math.min(sel.anchor, sel.focus);
          const b = Math.max(sel.anchor, sel.focus);
          return model.slice(a, b).join('');
        },
        cloneContents() { return { querySelector: () => null }; },
      };
    }
    toString() {
      const a = Math.min(this.anchor, this.focus);
      const b = Math.max(this.anchor, this.focus);
      return model.slice(a, b).join('');
    }
    modify(mode, direction) {
      const delta = direction === 'backward' ? -1 : 1;
      const clamp = (n) => Math.max(0, Math.min(model.length, n));
      if (mode === 'move') {
        this.anchor = clamp(this.focus + delta);
        this.focus = this.anchor;
      } else {
        this.focus = clamp(this.focus + delta);
      }
    }
    removeAllRanges() {}
    addRange(range) { this.anchor = range.__anchor; this.focus = range.__focus; }
  }

  const selection = new FakeSelection();

  function performInsert(value) {
    const from = Math.min(selection.anchor, selection.focus);
    const to = Math.max(selection.anchor, selection.focus);
    const chars = Array.from(value);
    model.splice(from, to - from, ...chars);
    selection.anchor = from + chars.length;
    selection.focus = selection.anchor;
  }

  const listeners = new Map();
  const doc = {
    defaultView: win,
    getSelection: () => selection,
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture });
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry.fn !== fn));
    },
    dispatchEvent() { return true; },
    execCommand(command, _ui, value) {
      if (command === 'insertText') {
        if (deferInsert) frames.push(() => performInsert(value));
        else performInsert(value);
        return true;
      }
      if (command === 'delete') {
        const from = Math.min(selection.anchor, selection.focus);
        const to = Math.max(selection.anchor, selection.focus);
        model.splice(from, to - from);
        selection.anchor = from;
        selection.focus = from;
        return true;
      }
      return false;
    },
  };
  win.document = doc;

  const root = {
    nodeType: 1,
    closest: (selector) => (selector === '[data-composer-input]' ? root : null),
    getAttribute: (name) => (name === 'contenteditable' ? 'true' : null),
    contains: () => true,
  };

  function fire(type, event) {
    const entry = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...event,
      target: event.target || root,
    };
    for (const { fn } of listeners.get(type) || []) fn(entry);
    return entry;
  }

  function flush(limit = 40) {
    let guard = 0;
    while (frames.length > 0 && guard < limit) {
      const fn = frames.shift();
      fn();
      guard += 1;
    }
  }

  return { win, doc, root, model, selection, fire, flush, listeners,
    state: () => ({ text: model.join(''), caret: selection.focus, anchor: selection.anchor }) };
}

// ---------------------------------------------------------------- 端到端

test('输入 ( 自动补 )，光标落在中间', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  assert.deepEqual(world.state(), { text: '()', caret: 1, anchor: 1 });
});

test('插入被延后提交时，settle 轮询仍能把光标挪回中间', () => {
  const world = createWorld({ deferInsert: true });
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '（' });
  assert.equal(world.state().text, '', '第一帧还没提交');
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
});

test('已有右半边时再打一次右半边 = 跳过，不会变成 ())', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  world.fire('beforeinput', { inputType: 'insertText', data: ')' });
  world.flush();
  assert.deepEqual(world.state(), { text: '()', caret: 2, anchor: 2 });
});

test('选中文字后打 ( = 包起来，并选回原文', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.model.push('a', 'b', 'c');
  world.selection.anchor = 0;
  world.selection.focus = 3;
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  assert.equal(world.state().text, '(abc)');
  assert.equal(world.state().anchor, 4, 'anchor 停在原文末尾');
  assert.equal(world.state().caret, 1, 'focus 停在原文开头 → 选中 abc');
});

test('一对空括号中间按退格 = 一次删掉两个', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  const event = world.fire('keydown', { key: 'Backspace' });
  world.flush();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(world.state(), { text: '', caret: 0, anchor: 0 });
});

test('输入法提交全角左括号时补右半边', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.model.push('（');
  world.selection.anchor = 1;
  world.selection.focus = 1;
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
});

test('输入法提交的内容不是左半边时完全不动', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.model.push('你', '好');
  world.selection.anchor = 2;
  world.selection.focus = 2;
  world.fire('compositionend', { data: '好' });
  world.flush();
  assert.deepEqual(world.state(), { text: '你好', caret: 2, anchor: 2 });
});

test('聊天框以外的输入框不受影响', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  const outside = {
    nodeType: 1,
    closest: () => null,
    getAttribute: () => null,
    contains: () => true,
  };
  const event = world.fire('beforeinput', { inputType: 'insertText', data: '(', target: outside });
  assert.equal(event.defaultPrevented, false);
  assert.equal(world.state().text, '');
});

test('非输入框的 contenteditable=false 状态（工作区选择态）不拦截', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  const inert = {
    nodeType: 1,
    closest: () => inert,
    getAttribute: () => 'false',
    contains: () => true,
  };
  const event = world.fire('beforeinput', { inputType: 'insertText', data: '(', target: inert });
  assert.equal(event.defaultPrevented, false);
});

test('重复安装会卸掉上一份监听，不会双写', () => {
  const world = createWorld();
  const first = installAutoPair(world.win, world.doc);
  const second = installAutoPair(world.win, world.doc);
  assert.notEqual(first, second);
  assert.equal(first.enabled, true);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  assert.deepEqual(world.state(), { text: '()', caret: 1, anchor: 1 }, '只有一个监听生效');
});

test('dispose 之后完全不再拦截', () => {
  const world = createWorld();
  const api = createAutoPair(world.win, world.doc);
  api.dispose();
  const event = world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(world.state().text, '');
});

test('关闭开关后不再自动补', () => {
  const world = createWorld();
  const api = createAutoPair(world.win, world.doc);
  api.setEnabled(false);
  const event = world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(world.state().text, '');
});

test('localStorage 里有 :enabled=off 时启动即关闭', () => {
  const world = createWorld();
  world.win.localStorage.setItem('dsh-composer-autopair:enabled', 'off');
  const api = createAutoPair(world.win, world.doc);
  assert.equal(api.enabled, false);
});

test('统计与诊断报告会落到 localStorage', () => {
  const world = createWorld();
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  const raw = world.win.localStorage.getItem('dsh-composer-autopair');
  assert.match(raw, /^v\d+ /);
});

// ---------------------------------------------------------------- 插件入口与 bundle 形状

test('apply(ctx)：装好监听，并挂在 ctx.effect 的清理函数上', () => {
  const world = createWorld();
  const previous = globalThis.window;
  globalThis.window = world.win;
  try {
    const disposers = [];
    const api = apply({ effect: (fn) => { disposers.push(fn()); } });
    assert.notEqual(api, null, '窗口正常时应该装好');
    assert.equal(disposers.length, 1, '应该登记一个清理函数');
    world.fire('beforeinput', { inputType: 'insertText', data: '(' });
    world.flush();
    assert.deepEqual(world.state(), { text: '()', caret: 1, anchor: 1 });

    disposers.forEach((dispose) => dispose());
    world.model.length = 0;
    world.selection.anchor = 0;
    world.selection.focus = 0;
    const event = world.fire('beforeinput', { inputType: 'insertText', data: '(' });
    assert.equal(event.defaultPrevented, false, '插件停用后不该再拦截');
    assert.equal(world.state().text, '');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('apply(ctx)：没有 window 时安静返回 null', () => {
  const previous = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(apply({}), null);
  } finally {
    if (previous !== undefined) globalThis.window = previous;
  }
});

test('bundle 形状：注册成 DSH 客户端模块，并导出 name / inject / apply', () => {
  const bundle = renderBundle();
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/);
  assert.match(bundle, /id: "dsh-composer-autopair"/);
  assert.match(bundle, /exports\.apply = apply;/);
  assert.equal(/^export\s/m.test(bundle), false, 'bundle 里不能残留 ESM 关键字');

  let registered = null;
  const fakeWindow = { __ModuleLoader__: { load: (mod) => { registered = mod; } } };
  new Function('window', bundle)(fakeWindow); // eslint-disable-line no-new-func
  assert.equal(registered.id, 'dsh-composer-autopair');
  const exported = registered.factory(() => {
    throw new Error('这个插件不该 require 任何模块');
  });
  assert.equal(exported.name, 'dsh-composer-autopair');
  assert.deepEqual(exported.inject, []);
  assert.equal(typeof exported.apply, 'function');
});

// ---------------------------------------------------------------- Lexical 模型层
// 这组用例挂一个「假 Lexical」到 [data-composer-input] 上，模拟 editor.update() 的
// pending selection：凡是模型层能处理的输入，都必须走模型层（DOM 选区与模型一起变）。

/** 给 world 的输入框挂一个假 Lexical 编辑器（pending EditorState + RangeSelection）。 */
function attachFakeEditor(world) {
  const key = 'n1';
  const node = {
    __key: key,
    getType: () => 'text',
    getTextContent: () => world.model.join(''),
    setTextContent(text) {
      world.model.length = 0;
      for (const ch of Array.from(text)) world.model.push(ch);
    },
    spliceText(start, del, text) {
      world.model.splice(start, del, ...Array.from(text));
    },
  };
  const makePoint = (offset) => ({
    type: 'text',
    key,
    offset,
    set(k, o, t) {
      this.key = k;
      this.offset = o;
      this.type = t;
    },
    getNode: () => node,
  });
  const selection = {
    anchor: makePoint(world.selection.anchor),
    focus: makePoint(world.selection.focus),
    dirty: false,
    isCollapsed() {
      return this.anchor.offset === this.focus.offset;
    },
    getNodes() {
      return [node];
    },
    getTextContent() {
      const a = Math.min(this.anchor.offset, this.focus.offset);
      const b = Math.max(this.anchor.offset, this.focus.offset);
      return world.model.slice(a, b).join('');
    },
    insertText(text) {
      const chars = Array.from(text);
      const from = Math.min(this.anchor.offset, this.focus.offset);
      const to = Math.max(this.anchor.offset, this.focus.offset);
      world.model.splice(from, to - from, ...chars);
      this.anchor.offset = from + chars.length;
      this.focus.offset = this.anchor.offset;
    },
  };
  const editor = {
    _editorState: { _selection: selection },
    _pendingEditorState: null,
    update(run) {
      editor._pendingEditorState = { _selection: selection };
      try {
        run();
      } finally {
        editor._pendingEditorState = null;
        // 模拟 Lexical 提交：dirty 的选区被写回 DOM
        if (selection.dirty) {
          world.selection.anchor = selection.anchor.offset;
          world.selection.focus = selection.focus.offset;
          selection.dirty = false;
        }
      }
    },
  };
  world.root.__lexicalEditor = editor;
  return { editor, node, selection };
}

test('模型层：输入 ( 后光标落在中间，且 DOM 选区跟着模型走', () => {
  const world = createWorld();
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  assert.deepEqual(world.state(), { text: '()', caret: 1, anchor: 1 });
});

test('模型层：选中 abc 打 ( → 包成 (abc)，不再直接替换', () => {
  const world = createWorld();
  world.model.push('a', 'b', 'c');
  world.selection.anchor = 0;
  world.selection.focus = 3;
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  const after = world.state();
  assert.equal(after.text, '(abc)');
  assert.equal(Math.min(after.anchor, after.caret), 1, '选回原文起点');
  assert.equal(Math.max(after.anchor, after.caret), 4, '选回原文终点');
});

test('模型层：全角选中文字同样包裹', () => {
  const world = createWorld();
  world.model.push('你', '好');
  world.selection.anchor = 0;
  world.selection.focus = 2;
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '（' });
  world.flush();
  const after = world.state();
  assert.equal(after.text, '（你好）');
  assert.equal(Math.min(after.anchor, after.caret), 1);
  assert.equal(Math.max(after.anchor, after.caret), 3);
});

test('模型层：一对空括号中间按退格 = 一次删掉两个', () => {
  const world = createWorld();
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  const event = world.fire('keydown', { key: 'Backspace' });
  world.flush();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(world.state(), { text: '', caret: 0, anchor: 0 });
});

test('模型层：已有右半边时再打右半边 = 跳过（模型层）', () => {
  const world = createWorld();
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('beforeinput', { inputType: 'insertText', data: '(' });
  world.flush();
  world.fire('beforeinput', { inputType: 'insertText', data: ')' });
  world.flush();
  assert.deepEqual(world.state(), { text: '()', caret: 2, anchor: 2 });
});

test('模型层：输入法提交全角左括号时补右半边', () => {
  const world = createWorld();
  world.model.push('（');
  world.selection.anchor = 1;
  world.selection.focus = 1;
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
});

test('planFromSelection：选区含 chip（装饰节点）时不做包裹', () => {
  const parent = { getType: () => 'paragraph' };
  const textNode = { getType: () => 'text', getParent: () => parent };
  const chipNode = { getType: () => 'decorator', getParent: () => parent };
  const chipSelection = {
    isCollapsed: () => false,
    getNodes: () => [textNode, chipNode],
    getTextContent: () => 'abc',
    anchor: { getNode: () => textNode },
    focus: { getNode: () => chipNode },
  };
  assert.equal(planFromSelection(chipSelection, '(', index), null);
});

test('planFromSelection：跨段落的选区不做包裹，同段落可以', () => {
  const paraA = { getType: () => 'paragraph', getChildren: () => [] };
  const paraB = { getType: () => 'paragraph', getChildren: () => [] };
  const make = (parent) => ({ getType: () => 'text', getParent: () => parent });
  const first = make(paraA);
  const second = make(paraB);
  const crossParagraph = {
    isCollapsed: () => false,
    getNodes: () => [paraA, first, paraB, second],
    getTextContent: () => 'ab',
    anchor: { getNode: () => first },
    focus: { getNode: () => second },
  };
  assert.equal(planFromSelection(crossParagraph, '(', index), null);

  const last = make(paraA);
  const sameParagraph = {
    isCollapsed: () => false,
    getNodes: () => [paraA, first, last],
    getTextContent: () => 'ab',
    anchor: { getNode: () => first },
    focus: { getNode: () => last },
  };
  assert.deepEqual(planFromSelection(sameParagraph, '(', index), { kind: 'wrap', open: '(', close: ')' });
});

test('planFromSelection：普通字符不产生任何计划', () => {
  const selection = { isCollapsed: () => true, getNodes: () => [] };
  assert.equal(planFromSelection(selection, 'a', index), null);
});

// ---------------------------------------------------------------- 输入法（IME）路径

/** 模拟输入法提交一个字符：把它插到光标处（真实里由 Lexical 自己的输入路径完成）。 */
function imeType(world, fake, ch) {
  const chars = Array.from(ch);
  const at = world.selection.focus;
  world.model.splice(at, 0, ...chars);
  world.selection.anchor = at + chars.length;
  world.selection.focus = world.selection.anchor;
  fake.selection.anchor.offset = world.selection.anchor;
  fake.selection.focus.offset = world.selection.focus;
}

test('输入法：先配出一对，再在里面提交左半边 → 嵌套成（（）），而不是（（）', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
  assert.equal(api.stats.imePaired, 1);

  // 光标在中间，输入法又提交一个左半边 —— 这一对必须补全（嵌套）
  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（（））', caret: 2, anchor: 2 });
  assert.equal(api.stats.imePaired, 2, '两次都该算「补全」，不能把第二次当成已配对');
});

test('输入法：重复的 compositionend 不会多补一个右半边', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.equal(world.state().text, '（）');

  // 同一个提交再来一次（没有新字符进来）→ 不该再多一个 ）
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
  assert.equal(api.stats.imeDuplicate, 1);
});

test('输入法：手动提交右半边时跳过已有的右半边', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();

  imeType(world, fake, '）'); // 用户自己打了右半边，输入法把它插在光标处
  world.fire('compositionend', { data: '）' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 2, anchor: 2 });
  assert.equal(api.stats.imeSkippedCloser, 1);
});

test('输入法：删掉整对后在原处再打左半边，仍会补右半边', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.equal(world.state().text, '（）');

  // 退格删掉整对（同一位置、同一个文本节点）
  world.fire('keydown', { key: 'Backspace' });
  world.flush();
  assert.equal(world.state().text, '');

  // 再打一个左半边：位置和上次一样，但状态已经不同 —— 必须照常补全
  imeType(world, fake, '（');
  world.fire('compositionend', { data: '（' });
  world.flush();
  assert.deepEqual(world.state(), { text: '（）', caret: 1, anchor: 1 });
  assert.equal(api.stats.imeDuplicate, 0, '不能把新输入误判成重复提交');
  assert.equal(api.stats.imePaired, 2);
});

// ---------------------------------------------------------------- 引号

test('引号：一对空引号中间再按引号键 → 再嵌一对（模型层·直接输入）', () => {
  const world = createWorld();
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);

  world.fire('beforeinput', { inputType: 'insertText', data: '“' });
  world.flush();
  assert.deepEqual(world.state(), { text: '“”', caret: 1, anchor: 1 });

  // 中文输入法这时只会给右引号；应该再嵌一对，而不是把光标跳到最右边
  world.fire('beforeinput', { inputType: 'insertText', data: '”' });
  world.flush();
  assert.deepEqual(world.state(), { text: '““””', caret: 2, anchor: 2 });
});

test('引号：一对空引号中间输入法提交右引号 → 再嵌一对', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  imeType(world, fake, '“');
  world.fire('compositionend', { data: '“' });
  world.flush();
  assert.deepEqual(world.state(), { text: '“”', caret: 1, anchor: 1 });

  imeType(world, fake, '”'); // 输入法在已开引号后给的是右引号
  world.fire('compositionend', { data: '”' });
  world.flush();
  assert.deepEqual(world.state(), { text: '““””', caret: 2, anchor: 2 });
  assert.equal(api.stats.nested, 1);
});

test('引号：引号里已经有内容时，输入法提交右引号仍然是「跳过」（收尾）', () => {
  const world = createWorld();
  const fake = attachFakeEditor(world);
  const api = installAutoPair(world.win, world.doc);

  // 手工摆成 “你好” 且光标在最后一个 ” 之前
  world.model.push('“', '你', '好', '”');
  world.selection.anchor = 3;
  world.selection.focus = 3;
  fake.selection.anchor.offset = 3;
  fake.selection.focus.offset = 3;

  imeType(world, fake, '”'); // 输入法把收尾的右引号插在光标处
  world.fire('compositionend', { data: '”' });
  world.flush();
  assert.deepEqual(world.state(), { text: '“你好”', caret: 4, anchor: 4 });
  assert.equal(api.stats.imeSkippedCloser, 1);
  assert.equal(api.stats.nested, 0);
});

test('引号：半角双引号在一对中间再打一次 → 变成两对', () => {
  const world = createWorld();
  attachFakeEditor(world);
  installAutoPair(world.win, world.doc);

  world.fire('beforeinput', { inputType: 'insertText', data: '"' });
  world.flush();
  assert.deepEqual(world.state(), { text: '""', caret: 1, anchor: 1 });

  world.fire('beforeinput', { inputType: 'insertText', data: '"' });
  world.flush();
  assert.deepEqual(world.state(), { text: '""""', caret: 2, anchor: 2 });
});
