/**
 * 把插件装进 DSH 的 desktop profile（或卸载）。
 *
 *   node deploy.mjs            # 构建 + 安装（自动选择 Loader 挂载方式）
 *   node deploy.mjs --check    # 只看会发生什么，不写盘
 *   node deploy.mjs --remove   # 卸载：摘掉 Loader 条目、依赖、bundle 登记与安装目录
 *
 * 安装做了什么：
 *   1. `build.mjs` 生成 lib/client.js；
 *   2. 把包复制到 `<DSH_HOME>/plugins/dsh-composer-autopair/`（**稳定副本**）与
 *      `<DSH_HOME>/profiles/desktop/node_modules/dsh-composer-autopair/`；
 *   3. 在 profile 的 `package.json` 里登记 `file:` 依赖，指向**稳定副本**而不是仓库：
 *      仓库换目录时旧写法会变成悬空依赖，`pnpm install` 会顺手把插件目录当垃圾清掉
 *      （插件从此静默失效）——指向稳定副本就不会；
 *   4. 挂 Loader 条目时**按 profile 现状二选一，绝不两条都插**：
 *      - profile 的 `dsh.profile.bundles` 里已经有本包 → 走 bundle 路线（包自带的
 *        `dsh.bundle.patch` 会插入条目），此时把 user-patch 里的托管块**删掉**；
 *      - 否则在 profile 的 `cordis.patch.yml` 末尾插入托管块（该 profile 声明了
 *        `patchReload: live` 时插上即生效，不用重启 DSH）。
 *
 * 为什么必须二选一：两条都插会让 `composer-autopair` 这个 id 出现 2 行，
 * dshmarket 安装/更新插件后的「组合能否启动」静态检查会判成重复条目并自动回滚。
 * （本机真实 loader 是 1.0.5，重复只是「后层覆盖前层」；但 dshmarket 是从 profile 的
 * `pnpm-lock.yaml` 读 loader 版本的，那里读不到这个包，于是保守判成致命。）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './build.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PKG = 'dsh-composer-autopair';
const ENTRY_ID = 'composer-autopair';

/** 装进 profile 的文件（README 只为人看，缺了也不影响运行）。 */
const COPIES = ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js', 'lib/client.js'];

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

export function paths(env = process.env) {
  const DSH_HOME = env.DSH_HOME || join(homedir(), '.dsh');
  const PROFILE = env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', 'desktop');
  return {
    DSH_HOME,
    PROFILE,
    STORE: join(DSH_HOME, 'plugins', PKG),
    TARGET: join(PROFILE, 'node_modules', PKG),
    PROFILE_PATCH: join(PROFILE, 'cordis.patch.yml'),
    PROFILE_PKG: join(PROFILE, 'package.json'),
  };
}

/**
 * 摘掉**全部**托管块（不只是第一个：早期版本只删第一个，重复运行会留下两行）。
 * 容错：按 ASCII 前缀定位，早先写坏编码的块也能清掉。
 */
export function stripBlocks(text) {
  let next = text;
  let removed = 0;
  for (;;) {
    const start = next.indexOf(MARK_PREFIX);
    if (start < 0) break;
    const end = next.indexOf(MARK_END, start);
    if (end < 0) throw new Error('patch 里只有起始标记、没有结束标记，请人工检查 profile patch');
    let after = end + MARK_END.length;
    while (next[after] === '\n' || next[after] === '\r') after += 1;
    next = next.slice(0, start).replace(/\s*$/, '\n') + next.slice(after);
    removed += 1;
  }
  return { text: next, removed };
}

/** 从 profile package.json 读出 `dsh.profile.bundles`（bundle 式安装的登记表）。 */
export function bundleList(json) {
  const list = json && json.dsh && json.dsh.profile && json.dsh.profile.bundles;
  return Array.isArray(list) ? list : [];
}

/**
 * 决定 Loader 条目挂在哪一层：profile 已把本包登记为 bundle 就走 bundle 路线
 * （包自带的 cordis.patch.yml 会插入条目），否则退回 user-patch 路线。
 * 两条都插 = 同一个 id 两行 = dshmarket 判重复并回滚。
 */
export function planLoaderRoute(bundles) {
  return Array.isArray(bundles) && bundles.includes(PKG) ? 'bundle' : 'patch';
}

/**
 * 只用 ASCII 标记，按字节（latin1 一一对应）改 profile patch：
 * 原文件内容原样进出，绝不重新编码（profile patch 里可能有非 ASCII 内容）。
 */
function patchProfilePatch(p, mode, dryRun) {
  if (!existsSync(p.PROFILE_PATCH)) throw new Error('找不到 profile patch：' + p.PROFILE_PATCH);
  const before = readFileSync(p.PROFILE_PATCH, 'latin1');
  const stripped = stripBlocks(before);
  const next = mode === 'ensure'
    ? stripped.text.replace(/\s*$/, '\n\n') + BLOCK
    : stripped.text;
  const changed = next !== before;
  if (changed && !dryRun) {
    copyFileSync(p.PROFILE_PATCH, p.PROFILE_PATCH + '.bak-' + stamp());
    writeFileSync(p.PROFILE_PATCH, next, 'latin1');
  }
  return { changed, mode, path: p.PROFILE_PATCH, removedBlocks: stripped.removed };
}

/** profile package.json 登记/摘掉依赖与 bundle 登记（JSON 必须按 UTF-8 处理）。 */
function patchProfilePackageJson(p, mode, dryRun) {
  if (!existsSync(p.PROFILE_PKG)) return { changed: false, reason: 'no-profile-package-json' };
  const raw = readFileSync(p.PROFILE_PKG, 'utf8');
  if (raw.includes('\uFFFD')) throw new Error('profile package.json 不是合法 UTF-8，拒绝改写：' + p.PROFILE_PKG);
  const json = JSON.parse(raw);
  const spec = 'file:' + p.STORE.replace(/\\/g, '/');
  json.dependencies = json.dependencies || {};
  const profile = json.dsh && json.dsh.profile;
  const bundles = profile && Array.isArray(profile.bundles) ? profile.bundles : null;
  const bundleIndex = bundles ? bundles.indexOf(PKG) : -1;
  const has = Object.prototype.hasOwnProperty.call(json.dependencies, PKG);
  const changes = [];
  if (mode === 'ensure') {
    if (!has) {
      json.dependencies[PKG] = spec;
      changes.push('dependency-added');
    } else if (json.dependencies[PKG] !== spec) {
      json.dependencies[PKG] = spec;
      changes.push('dependency-repointed');
    }
  } else {
    if (has) {
      delete json.dependencies[PKG];
      changes.push('dependency-removed');
    }
    if (bundleIndex >= 0) {
      bundles.splice(bundleIndex, 1);
      changes.push('bundle-entry-removed');
    }
  }
  const changed = changes.length > 0;
  if (changed && !dryRun) writeFileSync(p.PROFILE_PKG, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return {
    changed,
    path: p.PROFILE_PKG,
    spec,
    changes,
    bundleEntryPresent: bundleIndex >= 0,
    bundleCount: bundles ? bundles.length : null,
  };
}

/** 把仓库里的包文件复制到目标目录，返回实际复制了哪些。 */
function copyPackage(from, to) {
  const copied = [];
  mkdirSync(to, { recursive: true });
  for (const rel of COPIES) {
    const src = join(from, rel);
    if (!existsSync(src)) continue;
    const dst = join(to, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied.push(rel);
  }
  return copied;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function install({ env = process.env, dryRun = false, skipBuild = false } = {}) {
  const p = paths(env);
  const built = skipBuild ? { skipped: true } : build();
  const raw = existsSync(p.PROFILE_PKG) ? JSON.parse(readFileSync(p.PROFILE_PKG, 'utf8')) : null;
  const bundles = bundleList(raw);
  const route = planLoaderRoute(bundles);
  let stored = null;
  let installed = null;
  if (!dryRun) {
    stored = copyPackage(ROOT, p.STORE);
    installed = copyPackage(ROOT, p.TARGET);
  }
  const loaderEntry = patchProfilePatch(p, route === 'patch' ? 'ensure' : 'strip', dryRun);
  const dependency = patchProfilePackageJson(p, 'ensure', dryRun);
  return {
    mode: 'install',
    dryRun,
    profile: p.PROFILE,
    route,
    bundlesHasPackage: bundles.includes(PKG),
    built,
    store: p.STORE,
    installedTo: p.TARGET,
    stored,
    installed,
    files: COPIES,
    loaderEntry,
    dependency,
    next: route === 'bundle'
      ? '按 bundle 路线挂载（dsh.profile.bundles 已登记本包）；user-patch 里的托管块已清掉，同一个 id 不会出现两行'
      : '按 user-patch 路线挂载；该 profile 声明 patchReload: live 时插上即生效（无需重启 DSH）',
  };
}

export function uninstall({ env = process.env, dryRun = false } = {}) {
  const p = paths(env);
  const loaderEntry = patchProfilePatch(p, 'strip', dryRun);
  const dependency = patchProfilePackageJson(p, 'remove', dryRun);
  const removedDirs = [];
  if (!dryRun) {
    for (const dir of [p.TARGET, p.STORE]) {
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      removedDirs.push(dir);
    }
  }
  return { mode: 'remove', dryRun, profile: p.PROFILE, loaderEntry, dependency, removedDirs };
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has('--check');
  const result = flags.has('--remove') ? uninstall({ dryRun }) : install({ dryRun });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
