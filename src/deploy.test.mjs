// deploy.mjs 的回归测试：重点是「同一个 loader id 绝不能挂两层」。
// 背景：deploy 早期版本只摘第一个托管块，重复运行会在 profile patch 里留下两行
// `composer-autopair`；而插件包自己又声明了 dsh.bundle.patch，于是 bundle 层 + user-patch 层
// = 2 行同 id，dshmarket 的「组合能否启动」检查判成重复条目并回滚整个更新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundleList, install, planLoaderRoute, stripBlocks, uninstall } from '../deploy.mjs';

const PKG = 'dsh-composer-autopair';
const MARK_PREFIX = '# >>> dsh-composer-autopair';
const MARK_END = '# <<< dsh-composer-autopair <<<';

function managedBlock() {
  return [
    MARK_PREFIX + ' (managed by deploy.mjs; uninstall: node deploy.mjs --remove) >>>',
    '- insert:',
    '    - id: composer-autopair',
    '      name: ' + PKG,
    MARK_END,
    '',
  ].join('\n');
}

/** 造一个临时 profile：patch 里先塞一个托管块（模拟已被 deploy 装过）。 */
function makeProfile({ bundles }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autopair-test-'));
  const home = join(root, 'home');
  const profile = join(home, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'cordis.patch.yml'),
    'patchReload: live\n' + managedBlock() + '# [2026-10-14] 别人的条目\n- id: sd-bridge\n',
  );
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {},
      dsh: { profile: { bundles, patchReload: 'live' } },
    }, null, 2) + '\n',
  );
  return { root, env: { DSH_HOME: home, DSH_PROFILE_DIR: profile }, profile };
}

function readPatch(profile) {
  return readFileSync(join(profile, 'cordis.patch.yml'), 'latin1');
}

function readPkg(profile) {
  return JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
}

test('stripBlocks 摘掉全部托管块，且幂等', () => {
  const text = 'head\n' + managedBlock() + managedBlock() + 'tail\n';
  const once = stripBlocks(text);
  assert.equal(once.removed, 2);
  assert.ok(!once.text.includes(MARK_PREFIX));
  assert.ok(once.text.includes('tail'));
  assert.equal(stripBlocks(once.text).removed, 0);
  assert.equal(stripBlocks('nothing here\n').removed, 0);
});

test('stripBlocks 只有起始标记时抛错（不静默吞掉半截块）', () => {
  assert.throws(() => stripBlocks(MARK_PREFIX + ' 半截\n'), /只有起始标记/);
});

test('planLoaderRoute：已登记为 bundle 走 bundle 路线，否则退回 user-patch', () => {
  assert.equal(planLoaderRoute([PKG]), 'bundle');
  assert.equal(planLoaderRoute(['dsh-base', PKG]), 'bundle');
  assert.equal(planLoaderRoute([]), 'patch');
  assert.equal(planLoaderRoute(undefined), 'patch');
});

test('bundleList 只认 dsh.profile.bundles 数组', () => {
  assert.deepEqual(bundleList({ dsh: { profile: { bundles: ['a'] } } }), ['a']);
  assert.deepEqual(bundleList({ dsh: { profile: {} } }), []);
  assert.deepEqual(bundleList({}), []);
  assert.deepEqual(bundleList(null), []);
});

test('bundle 路线：清掉 user-patch 托管块、不插新行、依赖指向稳定副本', () => {
  const { root, env, profile } = makeProfile({ bundles: ['dsh-base', PKG] });
  try {
    const result = install({ env, skipBuild: true });
    assert.equal(result.route, 'bundle');
    assert.equal(result.loaderEntry.removedBlocks, 1);
    const patch = readPatch(profile);
    assert.ok(!patch.includes(MARK_PREFIX), '托管块应被摘掉');
    assert.ok(patch.includes('- id: sd-bridge'), '别人的条目不能被碰');
    const pkg = readPkg(profile);
    assert.equal(pkg.dependencies[PKG], 'file:' + join(env.DSH_HOME, 'plugins', PKG).replace(/\\/g, '/'));
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-base', PKG], 'bundle 登记不能被改');
    assert.ok(existsSync(join(env.DSH_HOME, 'plugins', PKG, 'lib', 'client.js')), '稳定副本要落盘');
    assert.ok(existsSync(join(profile, 'node_modules', PKG, 'lib', 'client.js')), 'profile 里也要有');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('user-patch 路线：只插一行，重复安装也还是一行', () => {
  const { root, env, profile } = makeProfile({ bundles: ['dsh-base'] });
  try {
    assert.equal(install({ env, skipBuild: true }).route, 'patch');
    install({ env, skipBuild: true });
    install({ env, skipBuild: true });
    const patch = readPatch(profile);
    assert.equal(patch.split(MARK_PREFIX).length - 1, 1, '同一个 loader id 只能挂一层');
    assert.equal(patch.split('- id: composer-autopair').length - 1, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--check 不写盘', () => {
  const { root, env, profile } = makeProfile({ bundles: ['dsh-base'] });
  try {
    const before = readPatch(profile);
    const result = install({ env, dryRun: true, skipBuild: true });
    assert.equal(result.dryRun, true);
    assert.equal(readPatch(profile), before);
    assert.ok(!existsSync(join(env.DSH_HOME, 'plugins', PKG)));
    assert.ok(!existsSync(join(profile, 'node_modules', PKG)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall：摘条目 + 摘依赖 + 摘 bundle 登记 + 删目录', () => {
  const { root, env, profile } = makeProfile({ bundles: ['dsh-base', PKG] });
  try {
    install({ env, skipBuild: true });
    const result = uninstall({ env });
    assert.deepEqual([...result.dependency.changes].sort(), ['bundle-entry-removed', 'dependency-removed']);
    const pkg = readPkg(profile);
    assert.equal(pkg.dependencies[PKG], undefined);
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-base']);
    assert.ok(!readPatch(profile).includes(MARK_PREFIX));
    assert.ok(!existsSync(join(env.DSH_HOME, 'plugins', PKG)));
    assert.ok(!existsSync(join(profile, 'node_modules', PKG)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
