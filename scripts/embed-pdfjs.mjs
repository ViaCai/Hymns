#!/usr/bin/env node
/**
 * 把 lib/pdf.min.js 与 lib/pdf.worker.min.js 内联进 main.js。
 *
 * 为什么需要：
 *   Obsidian 官方插件市场（以及“手动下载三个文件”的安装方式）只会分发
 *   main.js / styles.css / manifest.json —— 插件目录里**不会**有 lib/。
 *   若只在运行时读 lib/，新用户重建歌词索引 / 预览 PDF 会失败，报
 *   「pdf.js 未能加载（插件 lib/pdf.min.js 读取失败）」。
 *   官方规范也要求依赖必须打包进 main.js，且禁止运行时下载远程代码。
 *
 * 做法：
 *   把两份 pdf.js 源码以 JSON 字符串字面量内联进 main.js 的一个函数体内
 *   （V8 对未调用的函数做懒解析，模块加载时不会创建这两个大字符串，
 *    只有插件目录确实没有 lib/ 时才会还原，因此不影响启动速度）。
 *   运行时 ensurePdfLib() 先读 lib/，读不到才回退到这份内联副本。
 *
 * 用法：node scripts/embed-pdfjs.mjs
 * 幂等：重复执行只会替换标记之间的内容，不会重复追加。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(root, 'main.js');
const LIB_MAIN = path.join(root, 'lib', 'pdf.min.js');
const LIB_WORKER = path.join(root, 'lib', 'pdf.worker.min.js');

const START = '/* ===== HYMNS_INLINE_PDFJS_START';
const END = '/* ===== HYMNS_INLINE_PDFJS_END';
const ANCHOR = 'module.exports = HymnsPlugin;';

/** JSON 转义成可直接放进 JS 的字符串字面量（并规避 U+2028/2029 的兼容性问题） */
const esc = (s) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const mainSrc = fs.readFileSync(LIB_MAIN, 'utf8');
const workerSrc = fs.readFileSync(LIB_WORKER, 'utf8');
const libVersion = (mainSrc.match(/version\s*=\s*"([\d.]+)"/) || [])[1] || 'unknown';

if (!mainSrc.includes('pdfjsLib')) {
  console.error('[embed-pdfjs] 警告：lib/pdf.min.js 里没找到 pdfjsLib，确认文件是否正确。');
}

const block = `${START}（由 scripts/embed-pdfjs.mjs 生成，请勿手改）===== */
/* 内联 PDF.js v${libVersion}（Apache-2.0，见 https://github.com/mozilla/pdf.js）。
   内联原因：Obsidian 官方插件市场只分发 main.js / styles.css / manifest.json，
   插件目录里没有 lib/，依赖必须打包进 main.js（规范亦禁止运行时下载远程代码）。
   两份源码置于函数体内，由 V8 懒解析：模块加载时不会创建这些大字符串，
   只有插件目录确实缺 lib/ 时才还原，避免拖慢启动。 */
let __HYMNS_INLINE_PDFJS = null;
function hymnsInlinePdfjs() {
  if (!__HYMNS_INLINE_PDFJS) {
    __HYMNS_INLINE_PDFJS = {
      main: ${esc(mainSrc)},
      worker: ${esc(workerSrc)}
    };
  }
  return __HYMNS_INLINE_PDFJS;
}
${END} ===== */
`;

let content = fs.readFileSync(MAIN, 'utf8');

// 1) 移除已有的旧块（幂等：插入与移除必须严格对称，否则每次都会多一个空行）
const s = content.indexOf(START);
const e = content.indexOf(END);
if (s >= 0 && e > s) {
  const endOfLine = content.indexOf('\n', e);
  let cut = endOfLine + 1;
  // 兼容早期版本遗留的多余空行（自愈一次）
  if (content[cut] === '\n') cut += 1;
  content = content.slice(0, s) + content.slice(cut);
}

// 2) 插到 module.exports 之前（block 自带结尾换行，此处不再补换行）
const anchorIdx = content.lastIndexOf(ANCHOR);
if (anchorIdx < 0) {
  console.error('[embed-pdfjs] 找不到锚点：' + ANCHOR);
  process.exit(1);
}
content = content.slice(0, anchorIdx) + block + content.slice(anchorIdx);

fs.writeFileSync(MAIN, content, 'utf8');

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('[embed-pdfjs] 完成');
console.log('  PDF.js 版本   :', libVersion);
console.log('  pdf.min.js    :', mb(Buffer.byteLength(mainSrc)));
console.log('  pdf.worker.js :', mb(Buffer.byteLength(workerSrc)));
console.log('  main.js 现为  :', mb(Buffer.byteLength(content)));
