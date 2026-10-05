# dsh-composer-autopair

> Auto-pair brackets and quotes in the DSH (DeepSeek Harness) chat composer: type the opening half,
> get the closing half, with the caret placed in between.

**English** | [中文](README.md)

## What it does

| You type | Result |
|---|---|
| `(` `[` `{` `"` `'` `` ` `` `（` `【` `《` `「` `“` … | The closing half is inserted, **caret lands in between** |
| `)` while the caret sits inside `()` | Skips over the closing half — no `())` |
| A quote key while the caret sits inside an **empty** `“”` pair | **Nests another pair** → `““””` (Chinese IMEs only give you the *closing* quote here) |
| A quote key to finish quoting (`“text”`, caret at the end) | Skips over the closing quote — normal wrapping-up |
| `(` with text selected | Wraps it → `(selected text)`, with the text re-selected |
| Backspace inside an empty `()` | Deletes both characters at once |
| A Chinese IME committing `（` | The matching `）` is appended too |
| A Chinese IME committing `）` when a `）` already follows | Skips over it — no `（））` |

Pair table (17 pairs, ASCII + full-width):

```
( )   [ ]   { }   " "   ' '   ` `
（ ）  ［ ］  ｛ ｝  【 】  《 》  〈 〉  「 」  『 』  〔 〕  “ ”  ‘ ’
```

**Deliberately out of scope**: settings inputs, the terminal, the right-sidebar editor and the file tree are
never touched, and nothing happens while an IME composition is in progress.

## Install

This is a regular DSH client plugin package (`dsh.client` + `dsh.bundle.patch`); the built bundle
`lib/client.js` is committed, so no build step is required to use it.

```bash
git clone https://github.com/xiqingyushan-ovo/dsh-composer-autopair
cd dsh-composer-autopair

node deploy.mjs            # build + install + enable (hot-applied)
node deploy.mjs --check    # dry run
node deploy.mjs --remove   # uninstall
```

`deploy.mjs` does four things:

1. builds `lib/client.js` from `src/autopair.mjs`;
2. copies the package into `<DSH_HOME>/profiles/desktop/node_modules/dsh-composer-autopair/`;
3. appends a loader entry to the profile's `cordis.patch.yml` (ASCII markers, idempotent):

   ```yaml
   - insert:
       - id: composer-autopair
         name: dsh-composer-autopair
   ```

4. registers a `file:` dependency in the profile's `package.json`, so a later `pnpm install`
   does not prune the directory.

Environment variables: `DSH_HOME` (default `~/.dsh`), `DSH_PROFILE_DIR`
(default `$DSH_HOME/profiles/desktop`).

**Activation**: profiles that declare `dsh.profile.patchReload: live` pick the entry up immediately —
no DSH restart. Other profiles apply patches only at startup and need a restart.

<details>
<summary>Alternative install (as a bundle, requires a DSH restart)</summary>

Drop the package into the profile's `node_modules` and add its name to `dsh.profile.bundles`
in `profiles/<name>/package.json` (the package ships its own `cordis.patch.yml`, which inserts the
loader entry). **Run `node deploy.mjs --remove` first**, otherwise the same `id` gets inserted twice.

</details>

## Toggling

No need to uninstall — turn it off temporarily:

```js
// DevTools console
__dshComposerAutoPair.setEnabled(false);   // off
__dshComposerAutoPair.setEnabled(true);    // on
localStorage.setItem('dsh-composer-autopair:enabled', 'off');  // stays off across restarts
```

## Diagnostics

Every 3 seconds the plugin writes a self-check report to localStorage, readable **without DevTools**:

| Key | Content |
|---|---|
| `dsh-composer-autopair-report` | `caps` (editor instance found? last model-layer error), `stats` (counters), `log` (last 12 actions) |
| `dsh-composer-autopair:probe` | Load beacon — present means the plugin really ran |
| `dsh-composer-autopair:error` | Load / model-layer errors |
| `dsh-composer-autopair:enabled` | `on` / `off` |

```bash
node tools/read-report.mjs                   # reads the DSH desktop Local Storage by default
node tools/read-report.mjs "<leveldb dir>"   # custom path
```

Counters worth watching:

- `viaEditor` / `viaDom` — handled by the "Lexical model layer" or by the "DOM fallback".
  In normal operation `viaEditor` grows and `viaDom` stays 0;
- `nested` — how many times an extra pair was nested inside an empty quote pair;
- `imeCommits` / `imePaired` / `imeSkippedCloser` / `imeDuplicate` — the four IME branches.

> LevelDB flushes lazily: when the DSH window is in the background Chromium throttles timers to
> roughly once a minute, and flushes are slow too. Read 1–2 minutes after an action, otherwise you
> may be looking at the previous revision. Once a record is compacted into `.ldb` it is no longer
> plain text — use the DevTools console then:
> `JSON.parse(localStorage['dsh-composer-autopair-report'])`.

## How it works

1. **Intercept `beforeinput` (document capture), not `keydown`.** When a Chinese IME commits `(` as
   `（`, the keydown is usually `Process`/keyCode 229; either way a `beforeinput` always arrives.
2. **Act on the Lexical model layer.** The editor instance is `[data-composer-input].__lexicalEditor`;
   inside `editor.update()` we `insertText()` on the pending selection and place the caret with
   `Point.set()` + `dirty`. Insertion and caret move happen **atomically in one update**, so the model
   selection and the DOM can never disagree — which is what makes "caret always in the middle",
   "Backspace/Delete work in the middle" and "selection gets wrapped" reliable.
3. **The DOM path is only a fallback**, used when no editor instance is available (or the selection
   contains decorator nodes such as `@` reference chips):
   `document.execCommand('insertText')` + `Selection.modify()`.
4. **The IME path is handled separately.** `compositionend` decides whether an opening or closing half
   was committed. Our own appended closing half is recognised by a fingerprint record (text node key +
   caret offset + both halves + timestamp), so a duplicate `compositionend` cannot double-insert, and
   "delete the pair, then type the same opening half in the same spot" is not misread as a duplicate.
5. **Quotes get their own rule.** After an opening quote, a Chinese IME only produces the closing
   quote, so "inside an *empty* pair" nests another pair, while "pair already has content" still skips
   over. Brackets are unaffected.
6. **Idempotent and disposable.** `installAutoPair` disposes the previous instance; the plugin entry
   registers cleanup through `ctx.effect`, so disabling or hot-reloading removes the listeners.

## Known limits

- Relies on a few Lexical internals: `__lexicalEditor`, `_pendingEditorState._selection`,
  `TextNode.setTextContent()` and `Point.set()`. A DSH/Lexical upgrade may break them —
  `caps.lexicalEditor` / `caps.editorError` in the report tell you right away, and the plugin then
  falls back to the DOM path.
- Only the chat composer (`[data-composer-input]`).
- Does not touch `/` slash commands or `@` references — those belong to DSH itself.
- Does nothing while an IME composition is active.

## Development

```
src/autopair.mjs        single source of truth: pair table, pure logic, Lexical adapter, apply(ctx)
src/autopair.test.mjs   41 tests: pure logic + full flow on a mini DOM + a fake Lexical editor
build.mjs               renders src into lib/client.js (the DSH client bundle shape)
deploy.mjs              install / uninstall
tools/read-report.mjs   read the diagnostics report from disk
lib/index.js            host half (no-op; exists so the loader mounts the package)
lib/client.js           build output — do not edit by hand
cordis.patch.yml        loader entry used by bundle-style installs
```

```bash
node --test src/autopair.test.mjs   # run tests
node build.mjs                      # rebuild lib/client.js
node deploy.mjs                     # install into the profile (hot-applied)
```

To change the pair table, edit `DEFAULT_PAIRS` in `src/autopair.mjs`, then
`node build.mjs && node deploy.mjs`.

## Compatibility

Tested on DSH desktop (profile `desktop`, Windows). Any DSH build whose chat composer uses the same
Lexical editor should work; after installing, `caps.composerReady === true` in the report means the
anchor matched.

## License

[MIT](LICENSE)
