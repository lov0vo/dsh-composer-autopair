# dsh-composer-autopair

> DSH（DeepSeek Harness）聊天输入框的**括号 / 引号自动配对**插件：打左半边自动补右半边，光标停在中间。

[English](README.en.md) | **中文**

## 能做什么

| 你输入 | 结果 |
|---|---|
| `(` `（` `“` `【` `《` `「` `『` `〔` … | 自动补上对应右半边，**光标落在两个符号中间** |
| 光标在 `()` 中间再按一次 `)` | 越过右半边，不会变成 `())` |
| 光标在一对**空引号** `“”` 中间再按引号键 | **再嵌一对** → `““””`（中文输入法这时只会给右引号 `”`） |
| 引号里已经有内容，再按引号键收尾 | 越过右引号（正常收尾，不会多嵌一对） |
| 选中一段文字后按 `(` | 变成 `(选中文字)`，并把原文重新选中 |
| 在 `()` 中间按一次退格 | 两个一起删掉 |
| 中文输入法直接提交 `（` | 同样补上右半边 |
| 输入法手动提交右半边 `）`、而右边已经有 `）` | 越过它，不会变成 `（））` |

配对表（17 组，半角 + 全角）：

```
( )   [ ]   { }   " "   ' '   ` `
（ ）  ［ ］  ｛ ｝  【 】  《 》  〈 〉  「 」  『 』  〔 〕  “ ”  ‘ ’
```

**不管的事**：设置页的输入框、终端、右侧栏编辑器、文件树一律不碰；输入法正在组字（composition）时不插手。

## 安装

插件是一个标准的 DSH 客户端插件包（`dsh.client` + `dsh.bundle.patch`），仓库里已带构建产物 `lib/client.js`。

```bash
git clone https://github.com/lov0vo/dsh-composer-autopair
cd dsh-composer-autopair

node deploy.mjs            # 构建 + 安装（自动选择挂载方式）
node deploy.mjs --check    # 只看会做什么，不写盘
node deploy.mjs --remove   # 卸载（可逆）
```

`deploy.mjs` 具体做四件事：

1. 由 `src/autopair.mjs` 生成 `lib/client.js`；
2. 把包复制到 `<DSH_HOME>/plugins/dsh-composer-autopair/`（**稳定副本**）和
   `<DSH_HOME>/profiles/desktop/node_modules/dsh-composer-autopair/`；
3. 在 profile 的 `package.json` 里登记 `file:` 依赖，指向**稳定副本**而不是仓库目录 ——
   仓库换位置时旧写法会变成悬空依赖，被 `pnpm install` 顺手清掉，插件从此静默失效；
4. 挂 Loader 条目，**按 profile 现状二选一**：

   | profile 的 `dsh.profile.bundles` | 做法 | 生效方式 |
   |---|---|---|
   | 已登记本包（dshmarket 装的，或手动加过） | 走 **bundle 路线**：包自带的 `cordis.patch.yml` 会插入条目，deploy 只把 user-patch 里的托管块**清掉** | 需要重启 DSH（bundle 列表只在宿主启动时读） |
   | 没有本包 | 走 **user-patch 路线**：在 profile 的 `cordis.patch.yml` 末尾插入托管块 | 该 profile 声明 `patchReload: live` 时插上即生效，不用重启 |

   托管块长这样：

   ```yaml
   - insert:
       - id: composer-autopair
         name: dsh-composer-autopair
   ```

   **为什么必须二选一**：两条都插会让 `composer-autopair` 这个 id 出现 **2 行**，
   dshmarket 在安装 / 更新插件后做的「组合能否启动」静态检查会判成重复条目，
   然后**自动回滚整次更新**。（本机真实 loader 是 1.0.5，重复其实只是「后层覆盖前层」；
   但 dshmarket 是从 profile 的 `pnpm-lock.yaml` 读 loader 版本的，那里读不到这个包，
   于是保守判成致命。）

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_PROFILE_DIR`（默认 `$DSH_HOME/profiles/desktop`）。

## 开关

不用卸载就能临时关掉：

```js
// DevTools 控制台
__dshComposerAutoPair.setEnabled(false);   // 关
__dshComposerAutoPair.setEnabled(true);    // 开
localStorage.setItem('dsh-composer-autopair:enabled', 'off');  // 重启后仍然关
```

## 诊断与自检

插件每 3 秒写一份自检报告到 localStorage，**不需要开 DevTools** 也能从磁盘读：

| 键 | 内容 |
|---|---|
| `dsh-composer-autopair-report` | `caps`（是否取到编辑器实例、模型层最近一次异常）、`stats`（各类计数）、`log`（最近 12 条动作）、`trace`（最近 24 条事件流水，用来还原「这一次按键到底发生了什么」） |
| `dsh-composer-autopair:probe` | 装载探针：能读到就说明插件真的跑起来了 |
| `dsh-composer-autopair:error` | 装载 / 模型层异常 |
| `dsh-composer-autopair:enabled` | `on` / `off` |

```bash
node tools/read-report.mjs                  # 默认读 DSH 桌面端的 Local Storage
node tools/read-report.mjs "<leveldb 目录>"  # 自定义路径
```

`stats` 里几个关键计数：

- `viaEditor` / `viaDom`：走「Lexical 模型层」还是走「DOM 兜底路径」。正常情况 `viaEditor` 增长、`viaDom` 为 0；
- `nested`：在空引号里再嵌一对的次数；
- `imeCommits` / `imePaired` / `imeSkippedCloser` / `imeDuplicate`：输入法路径的四个分支；
- `imeNotSettled`：输入法提交后模型迟迟没吸收、插件主动放弃的次数。正常应该是 0；
  它持续增长说明 DSH 的输入链路变了，此时报告里的 `trace` 能看出卡在哪一步。

> LevelDB 落盘有延迟：DSH 窗口不在前台时，Chromium 会把定时器压到约 60 秒一次、落盘也慢。
> 刚改完代码或刚操作完立刻读，可能读到上一版；等 1～2 分钟再看。压缩进 `.ldb` 之后读不出明文，
> 这时用 DevTools 控制台：`JSON.parse(localStorage['dsh-composer-autopair-report'])`。

## 它是怎么实现的

1. **拦 `beforeinput`（document capture），不拦 `keydown`**：中文输入法把 `(` 提交成 `（` 时，
   keydown 往往是 `Process`/keyCode 229；而不管走哪条路，最后都会有一次 `beforeinput`。
2. **动作在 Lexical 模型层完成**：从 `[data-composer-input].__lexicalEditor` 取到编辑器实例，
   在 `editor.update()` 里用 pending selection 的 `insertText()` 插入、用 `Point.set()` + `dirty` 摆光标。
   插入与光标**在同一次 update 内原子完成**，模型选区与 DOM 不会脱节 ——
   这是「光标一定在中间 / 中间的删除键能用 / 选中文字会被包起来」的前提。
3. **DOM 路径只作兜底**：拿不到编辑器实例（或选区里有 `@` 引用 chip 这类装饰节点）时，
   回退到 `document.execCommand('insertText')` + `Selection.modify()`。
4. **输入法路径单独处理**：`compositionend` 到达时 Lexical 往往还没把这次提交写进模型，
   所以这里**轮询模型**（最多 12 帧）等它落位，再做判断：刚提交的是左半边还是右半边；
   「我自己补的右半边」用一条带指纹的记录（文本节点 key + 光标位置 + 左右半边 + 时间）来识别，
   避免重复的 `compositionend` 多补一个，也不会把「删掉整对后在原地重打」误判成重复提交。
   等不到就什么都不做（记 `imeNotSettled`），绝不删输入法刚提交的字符。
5. **引号单独一条规则**：中文输入法在已开引号后只会给右引号，所以「空的一对中间」要再嵌一对，
   而「已有内容」时仍然是跳过收尾。括号不受影响。
6. **幂等 + 可卸载**：`installAutoPair` 会先 `dispose()` 上一份；插件入口用 `ctx.effect`
   登记清理，停用 / 热重载时监听会被摘掉。

## 已知边界

- 依赖 Lexical 的几个内部字段：`__lexicalEditor`、`_pendingEditorState._selection`、
  `TextNode.setTextContent()`、`Point.set()`。DSH 升级 Lexical 后可能失效 ——
  报告里的 `caps.lexicalEditor` / `caps.editorError` 能直接看出来；失效时会自动退回 DOM 兜底路径。
- 只作用于聊天输入框（`[data-composer-input]`）。
- 不含 `/` 斜杠命令与 `@` 引用（那是 DSH 自带的能力，不去抢）。
- 组字（composition）期间不干预。

## 开发

```
src/autopair.mjs        唯一真源：配对表、纯逻辑、Lexical 适配、插件入口 apply(ctx)
src/autopair.test.mjs   单测（45 个用例：纯逻辑 + 迷你 DOM 全链路 + 假 Lexical 模型层）
src/deploy.test.mjs     安装器单测（8 个用例：块摘除 / 路线选择 / 两条路线 / --check / 卸载）
build.mjs               由 src 生成 lib/client.js（DSH 客户端 bundle 形状）
deploy.mjs              安装 / 卸载（自动选择 Loader 挂载方式）
tools/read-report.mjs   从磁盘读诊断报告
lib/index.js            宿主半侧（no-op，只为让 Loader 挂载本包）
lib/client.js           构建产物，勿手改
cordis.patch.yml        bundle 式安装用的 Loader 条目声明
```

```bash
node --test src/autopair.test.mjs src/deploy.test.mjs   # 跑单测（53 个）
node build.mjs                      # 生成 lib/client.js
node deploy.mjs                     # 装进 profile
```

改配对表：编辑 `src/autopair.mjs` 的 `DEFAULT_PAIRS`，然后 `node build.mjs && node deploy.mjs`。

## 兼容性

在 DSH 桌面端（profile `desktop`，Windows）实测；凡是聊天输入框用同一套 Lexical 编辑器的
DSH 版本理论上都适用。装好后报告里的 `caps.composerReady` 为 `true` 才说明锚点对得上。

## 许可

[MIT](LICENSE)
