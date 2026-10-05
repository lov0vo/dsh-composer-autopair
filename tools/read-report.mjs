#!/usr/bin/env node
/**
 * 读取插件写在 localStorage 里的诊断报告。
 *
 * DSH 桌面端把 localStorage 存在 LevelDB 里，插件每 3 秒会写一份报告：
 *   dsh-composer-autopair-report   最近一次自检（caps / stats / log）
 *   dsh-composer-autopair:probe    装载探针（能读到就说明插件真的跑起来了）
 *   dsh-composer-autopair:error    装载或模型层异常
 *   dsh-composer-autopair:enabled  on / off
 *
 * 用法：
 *   node tools/read-report.mjs                      # 用默认路径
 *   node tools/read-report.mjs "<leveldb 目录>"      # 自定义路径
 *
 * 只扫 *.log（未压缩）。Chromium 把 .log 压缩成 .ldb 之后就再也读不出明文了 ——
 * 这时请改用 DevTools 控制台：JSON.parse(localStorage['dsh-composer-autopair-report'])。
 *
 * 注意：DSH 窗口不在前台时，Chromium 会把定时器压到约 60 秒一次、落盘也慢，
 * 写完代码或刚操作完立刻读，可能读到上一版，等 1～2 分钟再看。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPORT_KEY = 'dsh-composer-autopair-report';
const PROBE_KEY = 'dsh-composer-autopair:probe';
const ERROR_KEY = 'dsh-composer-autopair:error';

const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const leveldb = process.argv[2]
  || join(appData, '@deepseek-ai', 'dsh-desktop', 'Local Storage', 'leveldb');

/** 从 key 之后取一段配平的 JSON。 */
function readJsonAfter(text, from) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length && i < start + 20000; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (error) {
          return null;
        }
      }
    }
  }
  return null;
}

/** 收集所有 .log 里某个 key 之后出现的 JSON。 */
function collect(text, key) {
  const out = [];
  let from = 0;
  while (true) {
    const at = text.indexOf(key, from);
    if (at < 0) break;
    const value = readJsonAfter(text, at + key.length);
    if (value) out.push(value);
    from = at + key.length;
  }
  return out;
}

/** 收集短字符串值（LevelDB 里 key 后面先是长度字节，再是内容）。 */
function collectText(text, key) {
  const out = [];
  let from = 0;
  while (true) {
    const at = text.indexOf(key, from);
    if (at < 0) break;
    const raw = text.slice(at + key.length, at + key.length + 128);
    const parts = raw.replace(/[^\x20-\x7e]/g, '\u0000').split('\u0000').filter(Boolean);
    let value = '';
    // 长度前缀和内容粘在一起：首字节正好等于剩余长度时，把它剥掉
    for (const part of parts) {
      if (part.length > 4 && part.charCodeAt(0) === part.length - 1) {
        value = part.slice(1);
        break;
      }
    }
    if (!value) value = parts.find((part) => part.length > 4) || '';
    if (value) out.push(value.trim());
    from = at + key.length;
  }
  return out;
}

function main() {
  let names;
  try {
    names = readdirSync(leveldb);
  } catch (error) {
    console.error('读不到目录：' + leveldb);
    console.error('（非 Windows，或用的是自定义 DSH 数据目录时，请把 leveldb 目录作为参数传进来）');
    process.exitCode = 1;
    return;
  }

  const texts = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      texts.push(readFileSync(join(leveldb, name)).toString('latin1'));
    } catch (error) {
      /* 跳过读不了的文件 */
    }
  }

  const reports = [];
  const probes = [];
  const errors = [];
  for (const text of texts) {
    reports.push(...collect(text, REPORT_KEY));
    probes.push(...collectText(text, PROBE_KEY));
    errors.push(...collectText(text, ERROR_KEY));
  }

  if (reports.length === 0 && probes.length === 0) {
    console.log('没有找到明文报告（可能已被压缩进 .ldb）。');
    console.log('改用 DevTools 控制台：JSON.parse(localStorage["' + REPORT_KEY + '"])');
    return;
  }

  reports.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const latest = reports[reports.length - 1];
  if (latest) {
    console.log('=== 最近一次报告（共读到 ' + reports.length + ' 份）===');
    console.log(JSON.stringify(latest, null, 2));
  }
  if (probes.length > 0) {
    console.log('\n=== 装载探针（最后 ' + Math.min(3, probes.length) + ' 条）===');
    console.log(probes.slice(-3).join('\n'));
  }
  if (errors.length > 0) {
    console.log('\n=== 异常 ===');
    console.log(errors.slice(-3).join('\n'));
  }
  console.log('\n目录：' + leveldb);
}

main();
