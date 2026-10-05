/**
 * 把插件装进 DSH 的 desktop profile（或卸载）。
 *
 *   node deploy.mjs            # 构建 + 安装 + 在 profile patch 里挂上 Loader 条目
 *   node deploy.mjs --check    # 只看会发生什么，不写盘
 *   node deploy.mjs --remove   # 卸载：摘掉条目、依赖与安装目录
 *
 * 安装做了什么：
 *   1. `build.mjs` 生成 lib/client.js；
 *   2. 把包（package.json / lib / cordis.patch.yml / README.md）复制到
 *      `<DSH_HOME>/profiles/desktop/node_modules/dsh-composer-autopair/`；
 *   3. 在 profile 的 `cordis.patch.yml` 末尾插入一段 Loader 条目（带首尾标记，幂等）。
 *      这一段是「实时生效」的关键：该 profile 声明了 `patchReload: live`，
 *      插入条目后已打开的页面会通过 HMR 拿到新的客户端插件，不需要重启 DSH；
 *   4. 在 profile 的 `package.json` 里登记 `file:` 依赖，免得以后 `pnpm install` 把它当垃圾清掉。
 *
 * 为什么不直接写进 `dsh.profile.bundles`：bundle 列表只在宿主启动时读取，写进去要重启；
 * 而 patch 层是热重载的。插件包本身仍然带着标准 `dsh.bundle.patch`（cordis.patch.yml），
 * 以后想改成 bundle 式安装（dshmarket / `dsh plugin add`），把这里插入的那段删掉即可。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './build.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG = 'dsh-composer-autopair';
const ENTRY_ID = 'composer-autopair';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', 'desktop');
const TARGET = join(PROFILE, 'node_modules', PKG);
const PROFILE_PATCH = join(PROFILE, 'cordis.patch.yml');
const PROFILE_PKG = join(PROFILE, 'package.json');

const MARK_PREFIX = '# >>> dsh-composer-autopair';
const MARK_END = '# <<< dsh-composer-autopair <<<';
const MARK_BEGIN = `${MARK_PREFIX} (managed by deploy.mjs; uninstall: node deploy.mjs --remove) >>>`;
const BLOCK = [
  MARK_BEGIN,
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  `      name: ${PKG}`,
  MARK_END,
  '',
].join('\n');

const flags = new Set(process.argv.slice(2));
const check = flags.has('--check');
const remove = flags.has('--remove');

/** 摘掉已存在的托管块（容错：按 ASCII 前缀定位，早先写坏的块也能清掉）。 */
function stripBlock(text) {
  const start = text.indexOf(MARK_PREFIX);
  if (start < 0) return { text, removed: false };
  const end = text.indexOf(MARK_END, start);
  if (end < 0) throw new Error('patch 里只有起始标记、没有结束标记，请人工检查：' + PROFILE_PATCH);
  let after = end + MARK_END.length;
  while (text[after] === '\n' || text[after] === '\r') after += 1;
  return { text: text.slice(0, start).replace(/\s*$/, '\n') + text.slice(after), removed: true };
}

/**
 * 只用 ASCII 标记，按字节（latin1 一一对应）改 profile patch：
 * 原文件内容原样进出，绝不重新编码（profile patch 里可能有非 ASCII 内容）。
 */
function patchProfilePatch(action) {
  if (!existsSync(PROFILE_PATCH)) throw new Error('找不到 profile patch：' + PROFILE_PATCH);
  const before = readFileSync(PROFILE_PATCH, 'latin1');
  const stripped = stripBlock(before);
  let next;
  if (action === 'ensure') {
    next = stripped.text.replace(/\s*$/, '\n\n') + BLOCK;
  } else {
    next = stripped.text;
  }
  const changed = next !== before;
  if (changed && !check) {
    copyFileSync(PROFILE_PATCH, PROFILE_PATCH + '.bak-' + stamp());
    writeFileSync(PROFILE_PATCH, next, 'latin1');
  }
  return { changed, path: PROFILE_PATCH, replacedExisting: stripped.removed };
}

/** profile package.json 登记/摘掉 file: 依赖（JSON 必须按 UTF-8 处理）。 */
function patchProfilePackageJson(action) {
  if (!existsSync(PROFILE_PKG)) return { changed: false, reason: 'no-profile-package-json' };
  const raw = readFileSync(PROFILE_PKG, 'utf8');
  if (raw.includes('\uFFFD')) throw new Error('profile package.json 不是合法 UTF-8，拒绝改写：' + PROFILE_PKG);
  const pkg = JSON.parse(raw);
  const spec = 'file:' + ROOT.replace(/\\/g, '/');
  pkg.dependencies = pkg.dependencies || {};
  const has = Object.prototype.hasOwnProperty.call(pkg.dependencies, PKG);
  if (action === 'ensure') {
    if (has) return { changed: false, reason: 'already-present', spec: pkg.dependencies[PKG] };
    pkg.dependencies[PKG] = spec;
  } else {
    if (!has) return { changed: false, reason: 'not-present' };
    delete pkg.dependencies[PKG];
  }
  if (!check) writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { changed: true, path: PROFILE_PKG, spec };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function install() {
  const built = build();
  const copies = ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js', 'lib/client.js'];
  if (!check) {
    mkdirSync(TARGET, { recursive: true });
    for (const rel of copies) {
      const from = join(ROOT, rel);
      if (!existsSync(from)) continue;
      const to = join(TARGET, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  const patch = patchProfilePatch('ensure');
  const dep = patchProfilePackageJson('ensure');
  console.log(JSON.stringify({
    mode: 'install',
    dryRun: check,
    profile: PROFILE,
    built,
    installedTo: TARGET,
    files: copies,
    loaderEntry: patch,
    dependency: dep,
    next: check ? '（--check 未写盘）' : '已装好；已打开的 DSH 页面会通过 HMR 自动加载（无需重启）',
  }, null, 2));
}

function uninstall() {
  const patch = patchProfilePatch('remove');
  const dep = patchProfilePackageJson('remove');
  if (!check && existsSync(TARGET)) rmSync(TARGET, { recursive: true, force: true });
  console.log(JSON.stringify({
    mode: 'remove',
    dryRun: check,
    loaderEntry: patch,
    dependency: dep,
    removedDir: TARGET,
  }, null, 2));
}

if (remove) uninstall();
else install();
