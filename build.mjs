/**
 * 生成 lib/client.js —— DSH 客户端模块系统要的 bundle 形状：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * 源码 `src/autopair.mjs` 是唯一真源；这里只做「去掉 export 关键字 + 包壳 +
 * 挂上插件导出（name / inject / apply）」。构建产物请勿手改。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG = 'dsh-composer-autopair';
const SOURCE = join(ROOT, 'src', 'autopair.mjs');
const TARGET = join(ROOT, 'lib', 'client.js');

/** 读源码、去掉 ESM 关键字，返回可直接放进 factory 的脚本正文。 */
export function renderBody() {
  const raw = readFileSync(SOURCE, 'utf8');
  if (/^\s*import\s/m.test(raw)) {
    throw new Error('src/autopair.mjs 不能有 import（bundle 是自包含单文件）');
  }
  if (/\bexport\s+default\b/.test(raw)) {
    throw new Error('src/autopair.mjs 不能有 export default');
  }
  return raw
    .replace(/^export\s+/gm, '')
    .trimEnd()
    .split('\n')
    .map((line) => (line.length === 0 ? line : '\t\t' + line))
    .join('\n');
}

/** 生成完整 bundle 文本。 */
export function renderBundle() {
  return `/**
 * ${PKG} — 浏览器半侧 bundle。由 build.mjs 从 src/autopair.mjs 生成，请勿手改。
 * 作用：DSH 聊天输入框（Lexical，根节点 [data-composer-input]）自动配对括号/引号。
 */
window.__ModuleLoader__.load({
	id: "${PKG}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${renderBody()}
		exports.name = "${PKG}";
		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	}
});
`;
}

/** 写盘。 */
export function build() {
  const bundle = renderBundle();
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, bundle, 'utf8');
  return { target: TARGET, bytes: Buffer.byteLength(bundle, 'utf8') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = build();
  console.log(`built ${result.target} (${result.bytes} bytes)`);
}
