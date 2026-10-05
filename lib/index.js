/**
 * dsh-composer-autopair — host half (no-op).
 *
 * 插件要做的一切都在浏览器半侧（lib/client.js）：给聊天输入框加自动配对。
 * 这个模块存在的唯一理由是让 Loader 条目能挂载这个包，从而让
 * `@deepseek-ai/dsh-client-modules` 读到包里的 `dsh.client` 声明，
 * 并把 `/plugins/dsh-composer-autopair/client.js` 提供给页面。
 */

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-composer-autopair';

/** Host loader entry: nothing to mount on the server side. */
export function apply() {}
