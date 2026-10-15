/*
 * Hymns —— Obsidian 诗歌插件（v5）
 * 跨平台（桌面 / macOS / Android / iOS）：
 *  - 歌词正文检索：索引由插件“一键重建歌词索引”生成（插件内用 pdf.js 抽取 PDF 文本，写入插件目录 lyrics.json）。
 *    读取顺序：.obsidian/plugins/hymns/lyrics.json → 仓库根 hymns-lyrics.json（均为 adapter 读取，沙箱内 require 无法解析本地文件）。
 *  - 侧边栏内查看 PDF：使用 pdf.js 将每页渲染到 canvas（最可靠的跨平台方案，不依赖原生嵌入的 iframe/CSP 限制）。
 *  - 实时搜索：编号(如 D116)、关键词(空格 AND)；关键词命中歌词正文，结果展示高亮片段。
 *  - 分类单选；大列表分页(加载更多)+滚动；附录排最后。
 *  - 单击诗歌在侧边栏内查看 PDF（◀▶ 翻页 / ✕ 关闭），双击在新标签打开 PDF。
 *  - 固定底部播放栏：播放模式(顺序/顺序循环/单曲/随机，图标按钮)，上一首/下一首，歌单管理，翻 PDF 同步切歌。
 *  - 播放列表管理含“当前播放列表”（实时显示正在播放的列表）。
 *  - 复制改用最短短链接(仅文件名)；收藏功能改为“加入播放列表”。
 */
const {
  Plugin, PluginSettingTab, Setting, ItemView, Notice,
  TFile, Modal, Menu, setIcon, FuzzySuggestModal, requestUrl
} = require('obsidian');

const VIEW_TYPE_HYMNS = 'hymns-view';
/* ===== 页码规则（按“诗歌编号”分桶，而不是按列表位置切段）=====
   页码 p 只收纳编号落在 [p*100, p*100+99] 的诗歌：0 = 编号 0-99，1 = 100-199，2 = 200-299 …
   ⇒ 即使某个编号区间的诗歌很少，编号 100 的诗歌也绝不会被塞进页码 0。
   附录诗歌（Ds1 / C附3 / Q附15 等）不参与数字分页，全部放在特殊页码 “S”（永远排在最后）。 */
const APPENDIX_PAGE = 'S';

/* ===== 侧边栏 PDF 预览的资源上限（防止 Obsidian 白屏）=====
   侧边栏是用 pdf.js 把 PDF 逐页画成 <canvas>。canvas 的内存（尤其 GPU 纹理）
   不会随 DOM 移除立刻回收，必须显式把 width/height 置 0，否则反复翻页会把显存
   越堆越高，最后整个 Obsidian 渲染进程崩掉（表现为白屏）。
   另外，全库 PDF 里有《整编本诗歌》这类上百 MB / 几百页的合集，
   一旦被点开就会一次性读进内存并画满 canvas —— 所以必须同时限制体积与页数。 */
const PDF_PREVIEW_MAX_PAGES = 10;                  // 单次最多画多少页
const PDF_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;    // 超过 20MB 不读进内存，直接交给系统阅读器
/* 某首诗歌所属的页码键：附录 → "S"；其余 → 编号除以 100 取整 */
function pageKeyOf(h) {
  if (!h) return '0';
  if (h.appendix) return APPENDIX_PAGE;
  return String(Math.floor((Number(h.num) || 0) / 100));
}
/* 页码键排序：数字页升序，附录页 "S" 永远最后 */
function pageKeyOrder(a, b) {
  if (a === APPENDIX_PAGE) return b === APPENDIX_PAGE ? 0 : 1;
  if (b === APPENDIX_PAGE) return -1;
  return Number(a) - Number(b);
}
/* 页码对应的编号范围描述：0 → “编号 0-99”，S → 附录诗歌 */
function pageRangeLabel(key) {
  if (key === APPENDIX_PAGE) return '附录诗歌（Ds / C附 / Q附 等）';
  const n = Number(key) * 100;
  return '编号 ' + n + '-' + (n + 99);
}
/* 把列表按编号区间分桶 → [{ key, items }]，桶内保持原有顺序 */
function buildPages(list) {
  const map = new Map();
  for (const h of list) {
    const k = pageKeyOf(h);
    let arr = map.get(k);
    if (!arr) { arr = []; map.set(k, arr); }
    arr.push(h);
  }
  return Array.from(map.keys()).sort(pageKeyOrder).map((k) => ({ key: k, items: map.get(k) }));
}
// 插件目录（相对仓库根）不再硬编码：manifest.id 可能与实际文件夹名不同
// （例如本仓库 id=hymns，但部署文件夹名为 hymns-plugin），故运行时用 getPluginRel() 动态解析。

const CATEGORIES = {
  D: { name: '大本诗歌',   order: 0, color: '#e53935' },
  B: { name: '补充本诗歌', order: 1, color: '#fb8c00' },
  C: { name: '唱诗人',     order: 2, color: '#8e24aa' },
  X: { name: '新歌颂咏',   order: 3, color: '#3949ab' },
  E: { name: '儿童诗歌',   order: 4, color: '#00897b' },
  Q: { name: '青年诗歌',   order: 5, color: '#039be5' },
  T: { name: '特会诗歌',   order: 6, color: '#6d4c41' },
  O: { name: '其他诗歌',   order: 7, color: '#757575' },
};
const CAT_ORDER = ['D', 'B', 'C', 'X', 'E', 'Q', 'T', 'O'];
// 已知分类字母（用于“其他诗歌”过滤：凡是不在这些字母里的都算其他）
const KNOWN_LETTERS = new Set(['D', 'B', 'C', 'X', 'E', 'Q', 'T']);
const PLAY_MODES = ['sequential', 'loop', 'one', 'shuffle'];
const PLAY_MODE_NAME = { sequential: '顺序播放', loop: '顺序循环', one: '单曲循环', shuffle: '随机播放' };
const PLAY_MODE_ICON = { sequential: 'list-ordered', loop: 'repeat', one: 'repeat-1', shuffle: 'shuffle' };
const CUR_PLAYLIST = '__current__';

/* ===== 内置默认播放列表（首次加载自动写入，标记 builtin 便于识别与去重）=====
   歌单名 / 歌曲编号均由用户提供，直接按编号（code）存储；
   code 等于该编号基础版的 uid，播放时由 resolveHymn 实时解析，
   因此即使某些 PDF 暂未收入仓库，日后补上即可自动可播。 */
const BUILTIN_PLAYLISTS = [
  { id: 'nee',     name: '倪柝声 Watchman Nee 1903-1972',         codes: ['D015','D017','D235','D273','D303','D330','D458','D465','D468','D488','D506','D758','D770','B428','Q117','Q261'] },
  { id: 'wlee',    name: '李常受 Witness Lee 19050903-19970609',   codes: ['D006','D007','D008','D009','D010','D011','D014','D016','D018','D019','D020','D021','D022','D023','D025','D030','D053','D055','D056','D057','D130','D140','D141','D154','D177','D378','D381','D382','D384','D388','D402','D546','D586','D598','D604','D606','D656','D697','D713','D759','Ds3','Ds5','B327'] },
  { id: 'yjl',     name: '余洁麟 19480210-20201220 与历年华语成全', codes: ['B338','B454','B466','B467','B468','B629','B860','B861','B874','Q162','Q170','Q189','Q213','Q255','Q256'] },
  { id: 'barber',  name: '和受恩 Margaret E.Barber 1866-1930',    codes: ['D1065','D272','D282','D469','D471','D497','D506','D648','D771'] },
  { id: 'higashi', name: '霍华德 Howard Higashi 1937-1998',       codes: ['B328','B332','B336','B339','B340','B341','B876','B884'] },
  { id: 'watts',   name: '以撒·华滋 Isaac Watts（1674-1748）',      codes: ['D033','D085','D093','D136','D146','D351','D441','D681'] },
  { id: 'newton',  name: '约翰·牛顿 John Newton 1725-1807',        codes: ['D066','D247','D396'] },
];

/* ============ 自动更新（镜像 obsidian-bible-search-reader 的成熟方案）============
   更新只下载插件本体：main.js / manifest.json / styles.css；歌词索引 lyrics.json
   与依赖库 lib/ 不在更新范围内（前者随个人 PDF 重建，后者基本不变）。 */
const UPDATE_REPO = 'ViaCai/Hymns';
const UPDATE_BRANCH = 'main';
const UPDATE_BASE = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/';

// ==================== 更新日志内容（供弹窗离线展示；缺失时回退到远端 CHANGELOG.md）====================
const CHANGELOG_CONTENT = {
  '1.0.0': `## [1.0.0] - 2026-10-16

### 新增
- **诗歌浏览 / 搜索 / 播放与收藏插件首次发布**：按编号（如 D116）或关键词（空格分隔，如 恩典 耶稣）实时搜索，侧边栏预览 PDF，播放 MP3，收藏与播放列表。桌面端与移动端通用。
- **内置默认播放列表**：自带 7 个主题歌单（倪柝声 / 李常受 / 余洁麟 / 和受恩 / 霍华德 / 以撒·华滋 / 约翰·牛顿），首次加载自动写入，不覆盖你的自定义歌单。
- **自动检测更新**：启动时（开启后 12 小时节流一次）拉取云端 manifest 比对版本；发现新版本弹出常驻通知，提供「立即更新 / 稍后」。更新成功后自动弹出更新说明，并可查看历史更新内容。
- **播放列表管理增强**：删除改为图标按钮并二次确认；支持多选 / 全选批量删除；列表可上下排序；点击列表名直接打开明细；歌曲明细同样支持多选批量删除。
`
};

/* ============ 工具函数 ============ */
function normalize(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
/* 文件是否属于该文件夹（含任意深度的子文件夹）。
   root 为空 = “不限定范围”，即扫描整个仓库（零配置也能用）。 */
function inFolder(pathLower, rootLower) {
  return !rootLower || pathLower === rootLower || pathLower.startsWith(rootLower + '/');
}
function pad(n) { return String(n).padStart(3, '0'); }
function catInfo(letter) { return CATEGORIES[letter] || { name: '其他诗歌', order: 7, color: '#757575' }; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parsePdfCode(name) {
  const m = name.match(/^([DBECXQTO])(s|附)?(\d+)/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const marker = (m[2] || '').toLowerCase();
  const appendix = marker === 's' || marker === '附';
  const num = parseInt(m[3], 10);
  const display = letter + (appendix ? (marker === 's' ? 's' : '附') : '') + (appendix ? num : pad(num));
  return { letter, appendix, num, code: display };
}
function parseMp3Code(name) {
  const m = name.match(/^([dbecxqto])(s?)-?(\d+)/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const appendix = m[2].toLowerCase() === 's';
  const num = parseInt(m[3], 10);
  return { letter, appendix, num, code: letter + (appendix ? 's' : '') + pad(num) };
}

/* ---- 版本标记（variant）与唯一标识（uid）----
   同一个编号下可能有多个 PDF，以前会被静默丢掉若干个，现在按 variant 全部收录：
     · 尾部括号标注   D125.赞美主-祂的国度（调用D032）.pdf   → note = '调用D032'
     · 紧跟编号的序号 D388-1 / D485-2                        → index = 1 / 2
     · 紧随编号的字母 Q148A / Q151B                          → index = 1 / 2，mark = 'A' / 'B'
     · 没有任何标记   C2011华语成全训练标语 / 国华标语歌…     → index = 1（靠标题区分）
   MP3 配对规则（与本项目约定的命名方式一致）：
     · 没有特别标注的 MP3 → 只配给没有特别标注的 PDF
     · PDF 带特别标注（如「调用D032」）→ 必须配名字里带同样标注的 MP3
     · 序号/字母序列再按“第几版”对齐（-1、A 视作第 1 版；-2、B 视作第 2 版） */
function parseVariant(name) {
  const base = String(name || '').replace(/\.(pdf|mp3)$/i, '').trim();
  const m = base.match(/^[DBECXQTO](?:s|附)?\d+/i);
  if (!m) return { rest: '', note: '', mark: '', index: 1 };
  const rest = base.slice(m[0].length);
  // 1) 尾部括号标注（全角/半角均可）
  const p = rest.match(/[（(]([^（）()]*)[）)]\s*$/);
  if (p) return { rest, note: p[1].trim(), mark: '', index: 0 };
  // 2) 紧跟编号的序号（-2）或字母后缀（A / B）
  const q = rest.match(/^\s*(?:-(\d+)|([A-Za-z])(?=[^A-Za-z]|$))/);
  if (q) {
    if (q[1] !== undefined) return { rest, note: '', mark: q[1], index: parseInt(q[1], 10) };
    const L = q[2].toUpperCase();
    return { rest, note: '', mark: L, index: Math.max(1, L.charCodeAt(0) - 64) }; // A→1, B→2
  }
  // 3) 基础版
  return { rest, note: '', mark: '', index: 1 };
}
/* PDF 一侧的 MP3 配对键：带标注的按标注文本，其余按“第几版” */
function mp3MatchKey(v) { return v.note ? ('N:' + v.note) : ('I:' + v.index); }
/* 组内排序：基础版 → 序号版 → 带标注版；同级按文件名，保证顺序稳定可预期 */
function variantSortKey(v) { return v.note ? 90 : v.index; }
function compareVariantFiles(a, b, na, nb) {
  const va = variantSortKey(a), vb = variantSortKey(b);
  if (va !== vb) return va - vb;
  return na < nb ? -1 : na > nb ? 1 : 0;
}
/* 给同一编号下的多个文件分配 uid 与版本标注（items 需已按 compareVariantFiles 排好序）。
   基础版的 uid 就等于编号本身，因此与旧的歌词索引、旧的播放列表数据天然兼容。 */
function assignUid(items, code) {
  const used = new Set();
  let baseSeen = 0;
  // 只有一个文件时永远视作基础版：文件名里的括号多半是标题的一部分
  // （如 Q109.如今主你就是那灵(B137)、Q198.有分终极行动(2013年冬季…)），
  // 不能当成“版本标记”，否则 uid 一变，既有的歌词索引、播放列表、MP3 配对全部会失配。
  if (items.length <= 1) {
    return [{ uid: code, variant: '', variantKind: '', key: 'I:1', v: parseVariant(items.length ? items[0].name : '') }];
  }
  return items.map((it) => {
    const v = parseVariant(it.name);
    let tag = '', kind = '';
    if (v.note) { tag = v.note; kind = 'note'; }
    else if (v.index > 1) { tag = v.mark; kind = 'index'; }
    else {
      baseSeen++;
      // 同一编号下第 2 个以上“无标记”的条目（标题各异的不同诗歌）用标题区分
      if (baseSeen > 1) { tag = extractTitle(it.name) || ('v' + baseSeen); kind = 'multi'; }
    }
    let uid = code + (tag ? '#' + tag : '');
    let n = 2;
    while (used.has(uid)) { uid = code + (tag ? '#' + tag : '') + '~' + n; n++; }
    used.add(uid);
    return {
      uid, variant: tag, variantKind: kind, v,
      // MP3 配对键：带标注的按标注文本，其余（含基础版、标题各异的同编号条目）按“第几版”
      key: kind === 'note' ? ('N:' + tag) : (v.index > 1 ? ('I:' + v.index) : 'I:1'),
    };
  });
}
function collapseCJKSpaces(t) {
  if (!t) return t;
  let s = t.replace(/[ \t]+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(/([\u3400-\u4dbf\u4e00-\u9fff])[ \t]+([\u3400-\u4dbf\u4e00-\u9fff])/g, '$1$2'); } while (s !== prev);
  return s;
}
function extractTitle(name) {
  const base = name.replace(/\.pdf$/i, '').trim();
  const m = base.match(/^[A-Za-z](s|附)?\d+\.?(.*)$/);
  return m ? collapseCJKSpaces(m[2] || '') : '';
}
function isDashMp3(p) { return /-[^/]*\.mp3$/i.test(p); }

function compareHymns(a, b) {
  const oa = catInfo(a.letter).order, ob = catInfo(b.letter).order;
  if (oa !== ob) return oa - ob;
  if (a.appendix !== b.appendix) return a.appendix ? 1 : -1; // 附录排最后
  if (a.num !== b.num) return a.num - b.num;
  // 同一编号下的多个版本：基础版在前，其次按绝对文件路径排序（保证顺序稳定、可预期）
  if (a.uid !== b.uid) {
    if (a.variant === '' && b.variant !== '') return -1;
    if (b.variant === '' && a.variant !== '') return 1;
    return String(a.pdfPath) < String(b.pdfPath) ? -1 : 1;
  }
  return 0;
}

function baseName(p) { return p.split('/').pop(); }
function linkBase(p) { return baseName(p); } // 链接保留扩展名，便于识别文件格式（如 [[D001.pdf]]）
function embedBase(p) { return baseName(p); }                            // 嵌入：保留扩展名

function escapeHtml(s) {
  return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* 多版本条目的歌名：去掉用于区分版本的前缀（-1. / A）与尾部括号标注，
   因为版本信息已经由单独的 variant 标签展示，不必在歌名里重复一遍。 */
function cleanVariantTitle(title, v, dup) {
  let s = String(title || '').trim();
  if (!s || !dup) return s;
  s = s.replace(/^\s*(?:-\s*\d+|[A-Za-z](?=[^A-Za-z]|$))\s*[.、\s]*/, '');
  if (v && v.note) s = s.replace(/[（(]\s*[^（）()]*[）)]\s*$/, '');
  return s.trim();
}
/* 列表/标题统一显示：编号 + 版本标注 + 歌名（如 D125（调用D032） 赞美主-祂的国度） */
function hymnLabel(h) {
  if (!h) return '';
  const tag = h.variant ? '（' + h.variant + '）' : '';
  return (h.code || '') + tag + (h.title ? ' ' + h.title : '');
}

/* 将歌词条目格式化为可读文本：编号+标题，然后按 第N节/副歌 排版。
   sections 优先依据 PDF 左侧页边距印刷的节号，副歌依据“（副）”竖排标记。
   每节之前插入一个空行，使各节在视觉上清晰分隔。 */
function formatLyrics(entry, h) {
  const title = (entry && entry.title) || h.title || '';
  // h.code 仍是纯编号（如 D125），版本标注单独放在 h.variant
  const header = hymnLabel(h) || (h.code || '');
  const out = [header];
  const secs = entry && entry.sections;
  if (secs && secs.length) {
    let vn = 0;
    for (const s of secs) {
      if (s.type === 'chorus') {
        out.push('', '副歌', s.text);
      } else {
        // 优先用 PDF 印刷的节号；没有节号时按出现顺序计节
        vn = (typeof s.num === 'number' && s.num > 0) ? s.num : vn + 1;
        out.push('', '第' + vn + '节', s.text);
      }
    }
  } else if (entry && entry.lyrics) {
    out.push('', entry.lyrics);
  } else {
    out.push('', '（该诗歌暂无歌词文本，或属于图片型 PDF）');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
function highlight(text, keywords) {
  const esc = escapeHtml(text);
  const kws = keywords.filter(Boolean).map(escapeRegex);
  if (!kws.length) return esc;
  const re = new RegExp('(' + kws.join('|') + ')', 'gi');
  return esc.replace(re, (m) => '<mark>' + m + '</mark>');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice('已复制：' + text);
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      new Notice('已复制：' + text);
    } catch (e2) { new Notice('复制失败：' + e2.message); }
  }
}

/* ============ PDF 文本抽取（用于歌词索引，与 build-lyrics.js 完全同逻辑） ============
 * 坐标重建：按 Y 降序分行（页面从上到下），行内按 X 升序（从左到右）拼接。
 *   解决文本流乱序/跨页错排导致的“歌词顺序错”，以及音符对齐把单行切成两截的问题。
 * 副歌识别：本诗集在左侧空白处用竖排“（副）”标注副歌块；经全量核对，该标记位于
 *   副歌第一行左侧（x 很小），且副歌为“标记所在行起、直到本页底部的所有歌词行”。
 *   标记本身与竖排括号不是歌词，需剔除，避免混入正文（如“副高声赞美…”）。
 * 标题：印刷标题是每页页眉，仅取一次存入 title；正文里不再重复出现。 */
const CHORUS_MARK_RE = /^[（(〔［\[]?\s*(副歌?|chorus)\s*[)）〕］\]]?$/i;
const BRACKET_CHARS = '（）()〔〕［］[]';
const ROW_TOL = 2.5;    // 同一视觉行的 Y 容差（点）
const MARK_UP_TOL = 6;  // 标记行上方的容差（略高一点仍算副歌）

/* 节号：印刷时在左侧页边距用数字标出每一节（如 1 2 3 …），与（副）标记同理。
   观察：歌词正文起始 x 通常 > 65；页边距节号 x 约 20~40。 */
const VERSE_MARK_RE = /^\(?\s*\d{1,2}\s*[.)）]?$/;
const MARGIN_X_MAX = 55;      // 判定为“左页边距”的 x 上限
const VERSE_ATTACH_TOL = 12;  // 节号与其所属歌词行的 y 距离容差（实测 2~9）
const HEADER_BAND = 30;       // 页眉带：此处下方的才可能是节号（排除每页重复印刷的诗歌编号）
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

/* 把一页的 TextContent 还原成有序行，并标出副歌行（chorus）与节号起始行（verse） */
function extractPageRows(content) {
  const items = [];
  for (const it of (content.items || [])) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    items.push({ s: it.str, x: it.transform[4], y: it.transform[5] });
  }
  if (!items.length) return null;
  const marks = items.filter((i) => CHORUS_MARK_RE.test(i.s.replace(/\s/g, '')));
  const markerY = marks.length ? marks[0].y : null;
  const markerX = marks.length ? marks[0].x : null;

  // 分三类剔除：副歌标记、竖排括号、左页边距节号（节号稍后归属到具体歌词行）
  const verseMarks = [];
  const kept = [];
  for (const i of items) {
    const t = i.s.replace(/\s/g, '');
    if (!t) continue;
    if (CHORUS_MARK_RE.test(t)) continue;                  // 副歌标记本身
    if (markerX !== null && t.length <= 1 && BRACKET_CHARS.includes(t) && Math.abs(i.x - markerX) <= 10) continue; // 竖排括号
    if (VERSE_MARK_RE.test(t) && i.x <= MARGIN_X_MAX) { verseMarks.push(i); continue; } // 节号
    kept.push(i);
  }
  if (!kept.length) return null;
  kept.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  for (const it of kept) {
    let row = null;
    for (const r of rows) { if (Math.abs(r.y - it.y) <= ROW_TOL) { row = r; break; } }
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y); // 上 → 下
  const out = rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x); // 左 → 右
    return {
      y: row.y,                          // 保留 y，供节号归属计算距离
      raw: row.items.map((i) => i.s).join(''),
      chorus: markerY !== null && row.y <= markerY + MARK_UP_TOL,
      verse: 0,
    };
  });

  // 节号归属到最近的“真歌词行”（中文字符 >= 2）。
  // 页眉带内的数字是每页重复印刷的诗歌编号（且离歌名行很近），必须排除。
  let topY = -Infinity;
  for (const i of items) if (i.y > topY) topY = i.y;
  for (const m of verseMarks) {
    if (topY - m.y < HEADER_BAND) continue;
    let best = null, bestD = Infinity;
    for (const r of out) {
      const cjk = (r.raw.match(CJK_RE) || []).length;
      if (cjk < 2) continue;
      const d = Math.abs(r.y - m.y);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && bestD <= VERSE_ATTACH_TOL) {
      const n = parseInt(m.s.replace(/\D/g, ''), 10);
      if (n >= 1 && n <= 40 && !best.verse) best.verse = n;
    }
  }
  return out;
}

// 清洗：只保留歌词正文（标题单独存 title），剔除简谱/五线谱/调号/页码等；
// 保留歌词标点（中文标点原样保留，半角标点统一规范为中文全角）。
const LYRICS_ALLOW = /[^\u3400-\u4dbf\u4e00-\u9fff，。！？、；：（）《》〈〉「」『』…—·“”‘’～,.!?;:()\[\]{}<>"']/g;
const PUNCT_ONLY = /^[，。！？、；：（）《》〈〉「」『』…—·“”‘’～,.!?;:()\[\]{}<>"'\s]+$/;
const HALF2FULL = { ',': '，', '.': '。', '!': '！', '?': '？', ';': '；', ':': '：', '(': '（', ')': '）', '[': '（', ']': '）', '{': '（', '}': '）', '<': '《', '>': '》', '"': '“', "'": '‘', '~': '～' };
function normalizePunct(s) { return s.replace(/[,.!?;:()\[\]{}<>"'~]/g, (c) => HALF2FULL[c] || c); }
/* 逐行清洗，保留每行的副歌（chorus）标记 */
function cleanRowList(rows) {
  const out = [];
  for (const r of rows) {
    const line = (r.raw || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const cjk = (line.match(CJK_RE) || []).length;
    if (cjk < 2) {
      // 整行只剩标点（坐标偏移把它挤成单独一行，如单独一行的“！”“，”）→ 补到上一行，避免丢标点
      // 补完后再次规整行尾连续标点，避免出现 “。、”这类多余收尾
      if (PUNCT_ONLY.test(line) && out.length) {
        out[out.length - 1].text = trimStrayPunct(out[out.length - 1].text + normalizePunct(line));
      }
      continue;                                  // 其余（纯简谱/页码/调号等非歌词行）丢弃
    }
    const nonSpace = line.replace(/\s/g, '').length;
    if (nonSpace && cjk / nonSpace < 0.34) continue; // 中文占比过低（夹杂简谱/乱符）→ 丢弃
    // 1) 仅保留中文与标点，其余（数字、拉丁字母、简谱点线括号等）转为空格
    let cleaned = line.replace(LYRICS_ALLOW, ' ');
    // 2) 半角标点规范为中文全角（“,”→“，” “.”→“。” “!”→“！” “?”→“？” …）
    cleaned = normalizePunct(cleaned);
    // 3) 去掉中文字符之间、以及标点两侧的空格（“赞 美 ，主”→“赞美，主”）
    cleaned = cleaned.replace(/\s*([，。！？、；：（）《》〈〉「」『』…—·“”‘’～])\s*/g, '$1');
    let prev;
    do { prev = cleaned; cleaned = cleaned.replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+([\u3400-\u4dbf\u4e00-\u9fff])/g, '$1$2'); } while (cleaned !== prev);
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // 去掉因坐标重建而粘到行首的调号（如“大调”“小调”“C大调”“降E大调”“1=G”）
    cleaned = cleaned.replace(/^((降|升)?[A-Ga-g]?(大调|小调)|(降|升)?[A-Ga-g]调|1=[A-Ga-g])\s*/i, '');
    if (!cleaned) continue;
    // 4) 清理后仍只剩调号/记谱词的行（如“大调”“降 大调”）丢弃
    const compact = cleaned.replace(/[\s，。！？、；：（）《》〈〉「」『』…—·～]/g, '');
    if (/^(降|升)?[\u4e00-\u9fff]{0,2}(大调|小调)$/.test(compact) || /^(降|升)?[\u4e00-\u9fff]{0,3}调$/.test(compact)) continue;
    cleaned = trimStrayPunct(cleaned);
    out.push({ text: cleaned, chorus: !!r.chorus, verse: r.verse || 0 });
  }
  return out;
}
function cleanLyrics(text) {
  return cleanRowList(text.split('\n').map((raw) => ({ raw, chorus: false, verse: 0 }))).map((l) => l.text).join('\n');
}
function normKey(s) { return (s || '').replace(/\s+/g, ' ').trim().replace(/[—–\-~·]/g, ''); }

/* 行尾连续标点（如 “。、” “。、，”）只保留一个：坐标重建会把下一项的标点粘到行尾。
   优先保留句末标点（。！？），否则保留第一个。 */
const SOFT_PUNCT = /[、，；：·…～]/g;
function trimStrayPunct(s) {
  return s.replace(/([，。！？、；：·…～])([，。！？、；：·…～]+)$/, (all, first, rest) => {
    const strong = (first + rest).replace(SOFT_PUNCT, '');
    return strong ? strong.charAt(strong.length - 1) : first;
  });
}

/* 把行序列整理成 第N节 / 副歌 …
 * 优先级：① PDF 左侧页边距印刷的节号（1 2 3 …）→ 精确分节；
 *         ② （副）竖排标记 → 副歌块；
 *         ③ 两者皆无时退回：按“副歌之前的主歌”顺序自动计节，
 *            整首无任何标记则整篇视为第 1 节。 */
function buildSections(lines) {
  if (!lines || !lines.length) return null;
  const hasChorus = lines.some((l) => l.chorus);
  const hasVerse = lines.some((l) => l.verse);
  if (!hasChorus && !hasVerse) {
    // 无任何标记：不臆造结构，整篇作为第 1 节，保证展示一致
    const text = lines.map((l) => l.text).join('\n').trim();
    return text ? [{ type: 'verse', num: 1, text }] : null;
  }
  const sections = [];
  let cur = null, vn = 0;
  for (const ln of lines) {
    if (ln.chorus) {
      // 副歌：连续的副歌行合并为一块
      if (cur && cur.type === 'chorus') cur.text += '\n' + ln.text;
      else { cur = { type: 'chorus', text: ln.text }; sections.push(cur); }
    } else if (ln.verse) {
      // 页边距节号：开启新的一节
      vn = ln.verse;
      cur = { type: 'verse', num: vn, text: ln.text };
      sections.push(cur);
    } else if (cur && cur.type === 'verse') {
      cur.text += '\n' + ln.text;                 // 续接当前节
    } else {
      vn++;                                        // 无节号但有副歌时顺序计节
      cur = { type: 'verse', num: vn, text: ln.text };
      sections.push(cur);
    }
  }
  // 同编号重复出现（跨页重复印刷）时合并，避免 1,2,1,2 这种错乱
  const merged = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && s.type === 'chorus' && last.type === 'chorus') last.text += '\n' + s.text;
    else if (last && s.type === 'verse' && last.type === 'verse' && last.num === s.num) last.text += '\n' + s.text;
    else merged.push(s);
  }
  return merged.length ? merged : null;
}

/* 汇总各页清洗后的行：去掉标题（页眉，每页重复），生成 lyrics 与 sections */
function assembleLyrics(pages, fileName) {
  let title = fileName ? extractTitle(fileName) : '';
  const firstLine = (pages.length && pages[0].length) ? pages[0][0].text : '';
  if (!title) title = firstLine;
  const tKey = title ? normKey(title) : '';
  const hKey = firstLine ? normKey(firstLine) : '';
  const lines = [];
  for (const pg of pages) {
    for (const ln of pg) {
      const k = normKey(ln.text);
      if ((tKey && k === tKey) || (hKey && k === hKey)) continue; // 标题不重复出现
      lines.push(ln);
    }
  }
  const lyrics = lines.map((l) => l.text).join('\n');
  return { title, lyrics, sections: buildSections(lines) };
}

/* ============ 设置页 ============ */
/* 目标：把“必须手填路径”变成“零配置可用 + 一键定位 + 实时看到对不对” */
class HymnsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Hymns 诗歌插件设置' });

    // 顶部扫描状态：0 首时给出明确原因与一键修复，避免“静默失败”
    this.renderScanStatus(containerEl);

    this.addFolderSetting(containerEl, {
      key: 'pdfFolder', kind: 'pdf', name: 'PDF 文件夹',
      desc: '诗歌 PDF 所在目录，留空 = 扫描整个仓库。诗歌靠“文件名编号”识别（如 D116、E836（补充版）），这里填的路径只用来缩小扫描范围。',
    });
    this.addFolderSetting(containerEl, {
      key: 'mp3Folder', kind: 'mp3', name: 'MP3 文件夹',
      desc: '诗歌音频所在目录，留空 = 扫描整个仓库。',
    });

    // 「MP3 随 PDF 切换 / PDF 随 MP3 切换」两个联动方向统一放在底部播放栏的「联动」按钮菜单里，
    // 这里只留一行说明，不再重复开关，避免同一功能出现两处入口。
    new Setting(containerEl)
      .setName('联动')
      .setDesc('在底部播放栏点「联动」，可分别勾选：MP3 随 PDF 切换（打开/翻页诗歌时自动播放音频）、PDF 随 MP3 切换（切歌时 PDF 自动跟随）。');
    new Setting(containerEl)
      .setName('重建诗歌索引')
      .setDesc('修改文件夹或增删诗歌后，重新扫描 PDF/MP3（不含歌词正文）。')
      .addButton((b) => b.setButtonText('立即重建索引').setCta().onClick(async () => {
        b.setButtonText('重建中…'); b.setDisabled(true);
        await this.plugin.buildIndex();
        b.setButtonText('立即重建索引'); b.setDisabled(false);
        new Notice('诗歌索引已重建，共 ' + this.plugin.hymns.length + ' 首');
        if (this.plugin.view) this.plugin.view.renderListMode();
      }));
    const lyricsAll = this.plugin.lyrics || {};
    const lyricsCount = Object.keys(lyricsAll).length;
    const withLyrics = Object.values(lyricsAll).filter((e) => e && (e.lyrics || '').length).length;
    const idxSetting = new Setting(containerEl)
      .setName('歌词索引（一键重建）')
      .setDesc('平时无需重建：歌词索引已随插件附带，直接搜索即可。仅当新增/修改了诗歌 PDF 时，才点“重建歌词索引”补抽。')
    idxSetting.addButton((b) => b.setButtonText('重建歌词索引').setCta().onClick(async () => {
      await this.plugin.rebuildLyrics(false);
      this.display();
    }));
    idxSetting.addButton((b) => b.setButtonText('完整重建（较慢）').onClick(async () => {
      new ConfirmModal(this.app, '完整重建歌词索引',
        '将重新解析全部约 ' + (this.plugin.hymns.length || 2300) + ' 首 PDF，桌面端也需数十分钟（移动端不建议）。确定继续？',
        async () => { await this.plugin.rebuildLyrics(true); this.display(); }).open();
    }));
    idxSetting.descEl.createDiv({ cls: 'hymns-note', text: '当前已加载：歌词索引 ' + lyricsCount + ' 首（含歌词正文 ' + withLyrics + ' 首）。' });
    if (!lyricsCount) {
      idxSetting.descEl.createDiv({ cls: 'hymns-note', text: '未加载到歌词索引：请点“重建歌词索引”，或确认插件目录 lyrics.json / 仓库根 hymns-lyrics.json 存在。' });
    }

    // ============ 更新 ============
    const currentVer = this.plugin.manifest.version;
    containerEl.createEl('h2', { text: '更新' });
    new Setting(containerEl)
      .setName('自动检查更新')
      .setDesc('启动时（每 12 小时至多一次）拉取云端版本信息，发现新版本弹出通知。关闭后仍可在下方手动检查。')
      .addToggle((t) => t.setValue(this.plugin.settings.autoCheckUpdate)
        .onChange(async (v) => { this.plugin.settings.autoCheckUpdate = v; await this.plugin.saveAll(); }));
    new Setting(containerEl)
      .setName('检查更新')
      .setDesc('当前已安装版本：v' + currentVer + '。点击立即拉取云端最新版本。')
      .addButton((b) => b.setButtonText('立即检查更新').setCta().onClick(async () => {
        b.setDisabled(true); b.setButtonText('检查中…');
        await this.plugin.checkForUpdate(true);
        b.setDisabled(false); b.setButtonText('立即检查更新');
      }));
    new Setting(containerEl)
      .setName('当前版本更新说明')
      .setDesc('查看 v' + currentVer + ' 的更新内容。')
      .addButton((b) => b.setButtonText('查看').onClick(() => this.plugin.showCurrentChangelog()));
    new Setting(containerEl)
      .setName('历史更新')
      .setDesc('查看所有历史版本的更新内容。')
      .addButton((b) => b.setButtonText('查看历史更新').onClick(() => this.plugin.showUpdateHistory()));
  }

  /* ---- 顶部扫描状态 ---- */
  renderScanStatus(containerEl) {
    const plugin = this.plugin;
    const n = plugin.hymns.length;
    const box = containerEl.createDiv({ cls: 'hymns-scan-status' + (n ? '' : ' is-error') });
    if (!n && !plugin._indexBuilt) {
      // 索引还没建好（刚启动就打开设置）时不要误报“0 首”
      box.removeClass('is-error');
      box.createDiv({ cls: 'hymns-scan-line', text: '正在准备索引，请稍候…' });
      return;
    }
    if (n) {
      const withMp3 = plugin.hymns.filter((h) => h.mp3Path).length;
      const withLy = Object.keys(plugin.lyrics || {}).length;
      box.createDiv({ cls: 'hymns-scan-line', text: '✓ 当前已索引 ' + n + ' 首（有音频 ' + withMp3 + ' 首，歌词索引 ' + withLy + ' 首）' });
      box.createDiv({ cls: 'hymns-scan-note', text: '改动文件夹后会自动重建；也可以随时点下方“立即重建索引”。' });
      return;
    }
    box.createDiv({ cls: 'hymns-scan-line', text: '✗ 当前索引为 0 首：没有扫描到任何诗歌 PDF。' });
    box.createDiv({ cls: 'hymns-scan-note', text: '常见原因：① 文件夹路径填错，或填到了中间层（如只填了“大本诗歌”，其余分类会被漏掉）；② 文件名不是“字母+编号”开头。把两个文件夹都留空即可扫描整个仓库。' });
    const row = box.createDiv({ cls: 'hymns-scan-actions' });
    const auto = row.createEl('button', { cls: 'mod-cta', text: '自动检测 PDF 文件夹' });
    auto.addEventListener('click', () => this.pickFolder('pdf', (p) => this.applyFolder('pdfFolder', p)));
    const clr = row.createEl('button', { text: '两个文件夹都留空（扫描整个仓库）' });
    clr.addEventListener('click', async () => {
      this.plugin.settings.pdfFolder = ''; this.plugin.settings.mp3Folder = '';
      await this.plugin.saveAll();
      await this.plugin.buildIndex();
      this.display();
      new Notice('已改为扫描整个仓库，共索引 ' + this.plugin.hymns.length + ' 首');
    });
  }

  /* ---- 文件夹设置行：手填 + 浏览 + 自动检测 + 清空，外加实时命中提示 ---- */
  addFolderSetting(containerEl, opt) {
    const plugin = this.plugin;
    const label = opt.kind === 'mp3' ? 'MP3' : 'PDF';
    const s = new Setting(containerEl)
      .setName(opt.name)
      .setDesc(opt.desc)
      .addText((t) => t.setPlaceholder('留空 = 扫描整个仓库')
        .setValue(plugin.settings[opt.key])
        .onChange(async (v) => {
          plugin.settings[opt.key] = normalize(v || '');
          await plugin.saveAll();
          if (hint) hint.update();
        }))
      .addButton((b) => b.setButtonText('浏览…').setTooltip('从仓库里的文件夹列表中点选，不用手打路径')
        .onClick(() => this.browseFolder((p) => this.applyFolder(opt.key, p))))
      .addButton((b) => b.setButtonText('自动检测').setTooltip('扫描整个仓库，列出诗歌 ' + label + ' 最多的文件夹')
        .onClick(() => this.pickFolder(opt.kind, (p) => this.applyFolder(opt.key, p))))
      .addButton((b) => b.setButtonText('清空').setTooltip('清空 = 不限定范围，扫描整个仓库')
        .onClick(() => this.applyFolder(opt.key, '')));
    const hint = this.makeHint(containerEl, opt.kind, opt.key);
    return s;
  }

  /* 路径下方的实时提示：✓ 找到多少个（分组明细）/ ✗ 一个都没找到 */
  makeHint(containerEl, kind, key) {
    const el = containerEl.createDiv({ cls: 'hymns-folder-hint' });
    const label = kind === 'mp3' ? '诗歌 MP3' : '诗歌 PDF';
    const update = () => {
      const root = this.plugin.settings[key] || '';
      const st = this.plugin.scanFolderHits(root, kind);
      el.empty();
      el.removeClass('is-error');
      if (!st.files) {
        el.addClass('is-error');
        el.setText('✗ ' + (root ? ('「' + root + '」及其子文件夹里') : '整个仓库里') + '没有找到任何' + label + '（文件名需以 D/B/C/X/E/Q/T + 编号开头，如 D116、e836.mp3）');
        return;
      }
      let txt = '✓ ' + (root ? ('「' + root + '」及子文件夹') : '整个仓库') + '共 ' + st.files + ' 个' + label + '（' + st.codes + ' 个编号）';
      const det = Array.from(st.byLetter.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 7)
        .map(([l, n]) => catInfo(l).name + ' ' + n).join(' / ');
      if (det) txt += '：' + det;
      el.setText(txt);
      if (root && st.files < this.plugin.scanFolderHits('', kind).files) {
        el.createDiv({ cls: 'hymns-scan-note', text: '提示：全库其实有更多，当前路径可能只覆盖了一部分（比如填到了某个子分类里）。' });
      }
    };
    update();
    return { el, update };
  }

  /* 浏览：列出仓库里所有文件夹（由文件路径反推，含所有含文件的目录） */
  browseFolder(onPick) {
    const items = this.plugin.allFolders();
    if (!items.length) { new Notice('仓库里还没有任何文件夹'); return; }
    new FolderSuggestModal(this.app, items, '输入关键词过滤文件夹…', onPick).open();
  }

  /* 自动检测：按“含所有后代”聚合，列出命中最多的若干目录并给出推荐 */
  pickFolder(kind, onPick) {
    const label = kind === 'mp3' ? 'MP3' : 'PDF';
    const d = this.plugin.detectFolder(kind);
    if (!d.total) {
      new Notice('整个仓库都没有找到可识别的诗歌 ' + label + '（文件名需以 D/B/C/X/E/Q/T + 编号开头）');
      return;
    }
    const map = new Map();
    const texts = d.counts.slice(0, 12).map((c) => {
      const t = c.path + '（' + c.total + ' 个）';
      map.set(t, c.path);
      return t;
    });
    const rec = d.best ? ('推荐：' + d.best.path + '（' + d.best.total + ' 个）') : '选择文件夹（按命中数排序）';
    new FolderSuggestModal(this.app, texts, rec, (t) => onPick(map.get(t) || t)).open();
  }

  /* 应用文件夹改动：保存 → 立即重建索引 → 刷新设置页 → 告知结果 */
  async applyFolder(key, value) {
    this.plugin.settings[key] = normalize(value || '');
    await this.plugin.saveAll();
    await this.plugin.buildIndex();
    this.display();
    const v = this.plugin.settings[key];
    new Notice((key === 'mp3Folder' ? 'MP3' : 'PDF') + ' 文件夹：' + (v || '整个仓库') + '，共索引 ' + this.plugin.hymns.length + ' 首');
    if (this.plugin.view) this.plugin.view.renderListMode();
  }
}

/* 文件夹模糊选择弹窗（点选，不用手打路径） */
class FolderSuggestModal extends FuzzySuggestModal {
  constructor(app, items, placeholder, onChoose) {
    super(app);
    this._items = items || [];
    this._onChoose = onChoose;
    this.setPlaceholder(placeholder || '选择文件夹');
  }
  getItems() { return this._items; }
  getItemText(item) { return String(item); }
  onChooseItem(item) { if (this._onChoose) this._onChoose(String(item)); }
}

/* ============ 通用确认弹窗 ============ */
class ConfirmModal extends Modal {
  constructor(app, title, message, onConfirm) {
    super(app);
    this.title = title; this.message = message; this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });
    const row = contentEl.createDiv({ cls: 'hymns-home-actions' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: '确定' });
    ok.addEventListener('click', async () => { this.close(); if (this.onConfirm) await this.onConfirm(); });
    const cancel = row.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 加入播放列表弹窗 ============ */
class AddToPlaylistModal extends Modal {
  constructor(app, plugin, hymn) { super(app); this.plugin = plugin; this.hymn = hymn; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h3', { text: '加入播放列表' });
    // 新建行：输入框 + 「确定」按钮（触屏无键盘，不能只靠回车）
    const newRow = contentEl.createDiv({ cls: 'hymns-pl-new' });
    const input = newRow.createEl('input', { cls: 'hymns-pl-input', attr: { placeholder: '输入新播放列表名称，或点选已有列表' } });
    const okBtn = newRow.createEl('button', { cls: 'hymns-btn', text: '确定' });
    const create = () => {
      const name = (input.value || '').trim(); if (!name) return;
      this.plugin.addToPlaylist(name, this.hymn.uid);
      new Notice('已加入「' + name + '」'); this.close();
    };
    okBtn.addEventListener('click', create);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    const list = contentEl.createDiv();
    const refresh = () => {
      list.empty();
      if (!this.plugin.playlists.length) list.createEl('div', { cls: 'hymns-note', text: '暂无播放列表，请输入名称创建。' });
      this.plugin.playlists.forEach((pl) => {
        const row = list.createDiv({ cls: 'hymns-pl-item' });
        row.createSpan({ cls: 'hymns-pl-name', text: pl.name });
        row.createSpan({ cls: 'hymns-pl-count', text: pl.codes.length + ' 首' });
        const btn = row.createEl('button', { cls: 'hymns-btn', text: '加入' });
        btn.addEventListener('click', () => {
          this.plugin.addToPlaylist(pl.name, this.hymn.uid);
          new Notice('已加入「' + pl.name + '」'); this.close();
        });
      });
    };
    refresh();
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 播放列表管理弹窗（含“当前播放列表”置顶） ============ */
class ManagePlaylistsModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this._selected = new Set(); }
  openDetail(name) { this.close(); new PlaylistDetailModal(this.app, this.plugin, name).open(); }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h3', { text: '播放列表管理' });
    // 新建行：输入框 + 「确定」按钮（触屏无键盘，不能只靠回车）
    const newRow = contentEl.createDiv({ cls: 'hymns-pl-new' });
    const input = newRow.createEl('input', { cls: 'hymns-pl-input', attr: { placeholder: '新建播放列表名称' } });
    const okBtn = newRow.createEl('button', { cls: 'hymns-btn', text: '确定' });
    const create = () => {
      const name = (input.value || '').trim(); if (!name) return;
      this.plugin.createPlaylist(name); new Notice('已创建「' + name + '」');
      input.value = ''; refresh();
    };
    okBtn.addEventListener('click', create);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

    // —— 批量操作栏：全选 / 已选计数 / 删除所选 ——
    const bar = contentEl.createDiv({ cls: 'hymns-pl-bar' });
    const selAllLab = bar.createEl('label', { cls: 'hymns-pl-selall' });
    const selAllCb = selAllLab.createEl('input', { attr: { type: 'checkbox' } });
    selAllLab.createSpan({ text: '全选' });
    const selInfo = bar.createSpan({ cls: 'hymns-pl-selinfo' });
    const batchDel = bar.createEl('button', { cls: 'hymns-icon-btn hymns-pl-batchdel', attr: { 'aria-label': '删除所选' } });
    setIcon(batchDel, 'trash');

    const updateBar = () => {
      const total = this.plugin.playlists.length;
      const n = this._selected.size;
      selInfo.setText(n ? ('已选 ' + n + ' 项') : '');
      batchDel.disabled = n === 0;
      bar.toggleClass('is-empty', total === 0);
      selAllCb.checked = total > 0 && n === total;
      selAllCb.indeterminate = n > 0 && n < total;
    };
    selAllCb.addEventListener('change', () => {
      if (selAllCb.checked) this.plugin.playlists.forEach((p) => this._selected.add(p.name));
      else this._selected.clear();
      refresh();
    });
    batchDel.addEventListener('click', () => {
      const names = this.plugin.playlists.filter((p) => this._selected.has(p.name)).map((p) => p.name);
      if (!names.length) return;
      const msg = names.length === 1
        ? ('确定删除播放列表「' + names[0] + '」吗？')
        : ('确定删除所选 ' + names.length + ' 个播放列表吗？');
      new ConfirmModal(this.app, '删除播放列表', msg, () => {
        names.forEach((nm) => this.plugin.deletePlaylist(nm));
        this._selected.clear();
        new Notice('已删除 ' + names.length + ' 个播放列表');
        refresh();
      }).open();
    });

    const list = contentEl.createDiv();
    const refresh = () => {
      list.empty();
      // —— 当前播放列表（置顶，实时；不可选、不可删） ——
      const curCodes = this.plugin.currentSequence || [];
      const curRow = list.createDiv({ cls: 'hymns-pl-item hymns-current-pl' });
      curRow.createSpan({ cls: 'hymns-pl-check' });
      const curName = curRow.createSpan({ cls: 'hymns-pl-name hymns-pl-name-link', text: '当前播放列表（实时）' });
      curName.addEventListener('click', () => this.openDetail(CUR_PLAYLIST));
      curRow.createSpan({ cls: 'hymns-pl-count', text: curCodes.length + ' 首' });
      const curPlay = curRow.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放此列表' } });
      setIcon(curPlay, 'play');
      curPlay.addEventListener('click', () => { this.plugin.playCurrentSequence(); this.close(); });

      if (!this.plugin.playlists.length) list.createEl('div', { cls: 'hymns-note', text: '暂无自建播放列表，请在上方输入名称创建。' });
      this.plugin.playlists.forEach((pl, idx) => {
        const row = list.createDiv({ cls: 'hymns-pl-item' });
        const cbWrap = row.createSpan({ cls: 'hymns-pl-check' });
        const cb = cbWrap.createEl('input', { attr: { type: 'checkbox' } });
        cb.checked = this._selected.has(pl.name);
        cb.addEventListener('change', () => {
          if (cb.checked) this._selected.add(pl.name); else this._selected.delete(pl.name);
          updateBar();
        });
        // 点击列表名 → 打开明细（查看/编辑歌曲）
        const nameEl = row.createSpan({ cls: 'hymns-pl-name hymns-pl-name-link', text: pl.name });
        nameEl.addEventListener('click', () => this.openDetail(pl.name));
        if (pl.builtin) row.createSpan({ cls: 'hymns-pl-badge', text: '默认' });
        row.createSpan({ cls: 'hymns-pl-count', text: pl.codes.length + ' 首' });
        const acts = row.createDiv({ cls: 'hymns-pl-actions' });
        const play = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放此列表' } });
        setIcon(play, 'play');
        play.addEventListener('click', () => { this.plugin.playPlaylist(pl.name); this.close(); });
        const up = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '上移' } });
        setIcon(up, 'arrow-up');
        up.disabled = idx === 0;
        up.addEventListener('click', () => { this.plugin.movePlaylist(pl.name, -1); refresh(); });
        const down = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '下移' } });
        setIcon(down, 'arrow-down');
        down.disabled = idx === this.plugin.playlists.length - 1;
        down.addEventListener('click', () => { this.plugin.movePlaylist(pl.name, 1); refresh(); });
        const del = acts.createEl('button', { cls: 'hymns-icon-btn hymns-pl-del', attr: { 'aria-label': '删除此列表' } });
        setIcon(del, 'trash');
        del.addEventListener('click', () => {
          new ConfirmModal(this.app, '删除播放列表', '确定删除播放列表「' + pl.name + '」吗？', () => {
            this.plugin.deletePlaylist(pl.name); this._selected.delete(pl.name);
            new Notice('已删除「' + pl.name + '」'); refresh();
          }).open();
        });
      });
      updateBar();
    };
    refresh();
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 播放列表明细（查看/删除/排序歌曲，支持“当前播放列表”） ============ */
class PlaylistDetailModal extends Modal {
  constructor(app, plugin, name) { super(app); this.plugin = plugin; this.name = name; this._selected = new Set(); }
  onOpen() { this.render(); }
  isCurrent() { return this.name === CUR_PLAYLIST; }
  getCodes() {
    if (this.isCurrent()) return (this.plugin.currentSequence || []).slice();
    const pl = this.plugin.playlists.find((p) => p.name === this.name);
    return pl ? pl.codes.slice() : [];
  }
  /* 明细里每首诗歌对应的 hymn 列表（过滤掉找不到的） */
  listHymns() {
    return this.getCodes().map((c) => this.plugin.resolveHymn(c)).filter(Boolean);
  }
  /* 返回上一页：关闭本页并回到“播放列表管理” */
  goBack() {
    this.close();
    new ManagePlaylistsModal(this.app, this.plugin).open();
  }
  /* 播放列表里的某一首：明确播放动作 → 把该列表设为当前播放列表并从此首开始 */
  playAt(idx) {
    const codes = this.getCodes();
    const h = this.plugin.resolveHymn(codes[idx]);
    if (!h) return;
    const view = this.plugin.view;
    if (!view) { new Notice('请先打开诗歌侧边栏'); return; }
    view.setBrowseList(this.listHymns());  // 先让该列表成为浏览列表
    view.playFromList(h);                  // 主动播放 → playFromList 会把当前播放列表设为该列表
    this.close();
  }
  /* 打开该首诗歌的 PDF（仅查阅，不改变当前播放列表） */
  openPdfAt(idx) {
    const codes = this.getCodes();
    const h = this.plugin.resolveHymn(codes[idx]);
    if (!h) return;
    const view = this.plugin.view;
    if (!view) { new Notice('请先打开诗歌侧边栏'); return; }
    view.setBrowseList(this.listHymns());   // 只切换“正在浏览的列表”
    view.openInViewer(h);
    this.close();
  }
  render() {
    const { contentEl } = this; contentEl.empty();
    const isCur = this.isCurrent();
    const codes = this.getCodes();
    // 顶部：返回上一页 + 标题
    const head = contentEl.createDiv({ cls: 'hymns-pl-head' });
    const back = head.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '返回上一页' } });
    setIcon(back, 'arrow-left');
    back.addEventListener('click', () => this.goBack());
    const plBuiltin = !isCur && this.plugin.playlists.find((p) => p.name === this.name && p.builtin);
    head.createEl('h3', { cls: 'hymns-pl-title', text: (isCur ? '当前播放列表（实时）' : this.name) + (plBuiltin ? '（默认）' : '') + '（' + codes.length + ' 首）' });

    // —— 批量操作栏：全选 / 已选计数 / 删除所选 ——
    const bar = contentEl.createDiv({ cls: 'hymns-pl-bar' });
    const selAllLab = bar.createEl('label', { cls: 'hymns-pl-selall' });
    const selAllCb = selAllLab.createEl('input', { attr: { type: 'checkbox' } });
    selAllLab.createSpan({ text: '全选' });
    const selInfo = bar.createSpan({ cls: 'hymns-pl-selinfo' });
    const batchDel = bar.createEl('button', { cls: 'hymns-icon-btn hymns-pl-batchdel', attr: { 'aria-label': '删除所选' } });
    setIcon(batchDel, 'trash');
    const updateBar = () => {
      const total = codes.length;
      const n = this._selected.size;
      selInfo.setText(n ? ('已选 ' + n + ' 项') : '');
      batchDel.disabled = n === 0;
      bar.toggleClass('is-empty', total === 0);
      selAllCb.checked = total > 0 && n === total;
      selAllCb.indeterminate = n > 0 && n < total;
    };
    selAllCb.addEventListener('change', () => {
      if (selAllCb.checked) codes.forEach((_, i) => this._selected.add(i));
      else this._selected.clear();
      this.render();
    });
    batchDel.addEventListener('click', () => {
      const idxs = Array.from(this._selected);
      if (!idxs.length) return;
      new ConfirmModal(this.app, '移除歌曲', '确定从列表移除选中的 ' + idxs.length + ' 首歌曲吗？', () => {
        this.removeMany(idxs); this._selected.clear(); this.render();
      }).open();
    });

    const list = contentEl.createDiv({ cls: 'hymns-pl-detail' });
    codes.forEach((code, idx) => {
      const h = this.plugin.resolveHymn(code);
      const label = h ? hymnLabel(h) : code;
      const row = list.createDiv({ cls: 'hymns-pl-item' });
      const cbWrap = row.createSpan({ cls: 'hymns-pl-check' });
      const cb = cbWrap.createEl('input', { attr: { type: 'checkbox' } });
      cb.checked = this._selected.has(idx);
      cb.addEventListener('change', () => {
        if (cb.checked) this._selected.add(idx); else this._selected.delete(idx);
        updateBar();
      });
      row.createSpan({ cls: 'hymns-pl-name', text: (idx + 1) + '. ' + label });
      // 操作按钮（与其它页面统一）：播放 / 打开PDF / 更多
      if (h) {
        const acts = row.createDiv({ cls: 'hymns-pl-actions' });
        const play = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放' } });
        setIcon(play, 'play');
        play.addEventListener('click', () => this.playAt(idx));
        const pdf = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '打开 PDF' } });
        setIcon(pdf, 'file-text');
        pdf.addEventListener('click', () => this.openPdfAt(idx));
        const more = acts.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '更多' } });
        setIcon(more, 'more-vertical');
        more.addEventListener('click', (e) => { e.stopPropagation(); const view = this.plugin.view; if (view) view.showCopyMenu(h, e); });
      }
      // 排序 / 移除
      const up = row.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '上移' } });
      setIcon(up, 'arrow-up');
      up.disabled = idx === 0;
      up.addEventListener('click', () => { this.move(idx, -1); this.render(); });
      const down = row.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '下移' } });
      setIcon(down, 'arrow-down');
      down.disabled = idx === codes.length - 1;
      down.addEventListener('click', () => { this.move(idx, 1); this.render(); });
      const rm = row.createEl('button', { cls: 'hymns-icon-btn hymns-pl-del', attr: { 'aria-label': '移除' } });
      setIcon(rm, 'x');
      rm.addEventListener('click', () => {
        new ConfirmModal(this.app, '移除歌曲', '确定从列表移除「' + label + '」吗？', () => {
          this.remove(idx); this._selected.clear(); this.render();
        }).open();
      });
    });
    if (!codes.length) contentEl.createEl('div', { cls: 'hymns-note', text: '列表为空。' });
    updateBar();
  }
  move(idx, dir) {
    const j = idx + dir; if (j < 0 || j >= this.getCodes().length) return;
    if (this.isCurrent()) {
      const arr = this.plugin.currentSequence;
      const t = arr[idx]; arr[idx] = arr[j]; arr[j] = t;
      if (this.plugin.view) this.plugin.view.setCurrentList(arr.map((c) => this.plugin.resolveHymn(c)).filter(Boolean));
    } else {
      this.plugin.moveInPlaylist(this.name, idx, dir);
    }
  }
  remove(idx) {
    if (this.isCurrent()) {
      const arr = this.plugin.currentSequence;
      arr.splice(idx, 1);
      if (this.plugin.view) this.plugin.view.setCurrentList(arr.map((c) => this.plugin.resolveHymn(c)).filter(Boolean));
    } else {
      this.plugin.removeFromPlaylist(this.name, idx);
    }
  }
  /* 一次性移除多首（indices 为渲染时的原始下标） */
  removeMany(indices) {
    const idxs = indices.slice().sort((a, b) => b - a);
    if (this.isCurrent()) {
      const arr = this.plugin.currentSequence;
      idxs.forEach((i) => { if (i >= 0 && i < arr.length) arr.splice(i, 1); });
      if (this.plugin.view) this.plugin.view.setCurrentList(arr.map((c) => this.plugin.resolveHymn(c)).filter(Boolean));
    } else {
      this.plugin.removeManyFromPlaylist(this.name, idxs);
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 更新说明 / 历史更新弹窗 ============
   由 checkAndShowChangelog / showCurrentChangelog / checkForUpdate / performUpdate 弹出：
   · 普通模式：渲染某个版本的更新说明（CHANGELOG_CONTENT 或远端 CHANGELOG.md 解析）；
     底部提供「查看历史更新」与「知道了」。
   · historyOnly 模式：拉取全部历史版本，可逐项展开查看。 */
class HymnsUpdateModal extends Modal {
  constructor(app, plugin, version, content, opts = {}) {
    super(app);
    this.plugin = plugin;
    this.version = version || '';
    this.content = content || '';
    this.title = opts.title || '';
    this.historyOnly = !!opts.historyOnly;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.classList.add('hymns-update-modal');
    contentEl.style.padding = '24px';
    contentEl.style.maxWidth = '600px';

    if (this.historyOnly) {
      contentEl.createEl('h2', { text: this.title || '📜 Hymns 历史更新' });
      this.renderHistory(contentEl);
      return;
    }

    contentEl.createEl('h2', { text: this.title || ('🎉 Hymns 已更新至 v' + this.version) });
    const body = contentEl.createDiv();
    body.style.marginTop = '16px';
    body.style.lineHeight = '1.8';
    body.style.fontSize = '14px';

    const lines = (this.content || '').trim().split('\n');
    if (!this.content || !this.content.trim()) {
      const emptyEl = body.createEl('div', { cls: 'setting-item-description', text: '暂无该版本的更新说明，可查看插件目录下的 CHANGELOG.md。' });
      emptyEl.style.color = 'var(--text-muted)';
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '---') continue;
      if (trimmed.startsWith('## ')) {
        body.createEl('h3', { text: trimmed.replace('## ', '') });
      } else if (trimmed.startsWith('### ')) {
        const h4 = body.createEl('h4', { text: trimmed.replace('### ', '') });
        h4.style.color = 'var(--text-accent)';
        h4.style.marginTop = '12px';
      } else if (trimmed.startsWith('- ')) {
        const div = body.createDiv({ attr: { style: 'margin-left:12px;margin-bottom:4px;' } });
        div.createEl('span', { text: '• ', attr: { style: 'margin-right:4px;' } });
        this.renderInlineMarkdown(div, trimmed.slice(2));
      } else if (trimmed) {
        const div = body.createDiv();
        this.renderInlineMarkdown(div, trimmed);
      }
    }

    // 按钮区：查看历史更新 + 知道了
    const btnWrap = contentEl.createDiv();
    btnWrap.style.display = 'flex';
    btnWrap.style.justifyContent = 'space-between';
    btnWrap.style.alignItems = 'center';
    btnWrap.style.gap = '8px';
    btnWrap.style.marginTop = '20px';
    const historyBtn = btnWrap.createEl('button', { text: '查看历史更新' });
    historyBtn.addEventListener('click', () => { this.close(); this.plugin.showUpdateHistory(); });
    const okBtn = btnWrap.createEl('button', { cls: 'mod-cta', text: '知道了' });
    okBtn.addEventListener('click', () => this.close());
  }

  /* 历史更新：拉取全部版本，可逐项展开 */
  async renderHistory(container) {
    const loading = container.createDiv({ text: '正在加载历史更新...' });
    loading.style.color = 'var(--text-muted)';
    try {
      const sections = await this.plugin.fetchRemoteChangelogAll();
      loading.remove();
      if (!sections.length) {
        container.createDiv({ cls: 'setting-item-description', text: '暂无历史更新记录。' }).style.color = 'var(--text-muted)';
        return;
      }
      for (const sec of sections) {
        const item = container.createDiv();
        item.style.borderBottom = '1px solid var(--background-modifier-border)';
        item.style.padding = '12px 0';
        const head = item.createDiv();
        head.style.display = 'flex';
        head.style.alignItems = 'center';
        head.style.gap = '8px';
        head.style.cursor = 'pointer';
        head.style.userSelect = 'none';
        head.createEl('strong', { text: 'v' + sec.version });
        const date = head.createEl('span', { text: sec.date || '' });
        date.style.color = 'var(--text-muted)';
        date.style.fontSize = '12px';
        const toggle = head.createEl('span', { text: '▸' });
        toggle.style.marginLeft = 'auto';
        toggle.style.color = 'var(--text-muted)';
        const detail = item.createDiv();
        detail.style.display = 'none';
        detail.style.marginTop = '8px';
        detail.style.lineHeight = '1.8';
        detail.style.fontSize = '13px';

        let expanded = false;
        let built = false;
        head.addEventListener('click', () => {
          expanded = !expanded;
          if (expanded) {
            if (!built) {
              for (const line of sec.body) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === '---') continue;
                if (trimmed.startsWith('- ')) {
                  const div = detail.createDiv({ attr: { style: 'margin-left:12px;margin-bottom:4px;' } });
                  div.createEl('span', { text: '• ', attr: { style: 'margin-right:4px;' } });
                  this.renderInlineMarkdown(div, trimmed.slice(2));
                } else if (trimmed) {
                  this.renderInlineMarkdown(detail.createDiv(), trimmed);
                }
              }
              built = true;
            }
            detail.style.display = 'block';
            toggle.textContent = '▾';
          } else {
            detail.style.display = 'none';
            toggle.textContent = '▸';
          }
        });
      }
      const btnWrap = container.createDiv();
      btnWrap.style.textAlign = 'center';
      btnWrap.style.marginTop = '20px';
      const okBtn = btnWrap.createEl('button', { cls: 'mod-cta', text: '关闭' });
      okBtn.addEventListener('click', () => this.close());
    } catch (e) {
      loading.remove();
      container.createDiv({ cls: 'setting-item-description', text: '加载历史更新失败：' + e.message }).style.color = 'var(--text-muted)';
    }
  }

  /* 行内 **加粗** 渲染 */
  renderInlineMarkdown(container, text) {
    const regex = /\*\*(.*?)\*\*/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const strong = container.createEl('strong', { text: match[1] });
      strong.style.fontWeight = '600';
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 复制歌词弹窗（列表与查看器“更多”共用） ============ */
class LyricsModal extends Modal {
  constructor(app, plugin, hymn) { super(app); this.plugin = plugin; this.hymn = hymn; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('hymns-lyrics-modal');
    const h = this.hymn;
    const entry = (this.plugin.lyrics && this.plugin.lyrics[h.uid]) || null;
    const title = (entry && entry.title) || h.title || '';
    contentEl.createDiv({ cls: 'hymns-lyrics-head', text: hymnLabel(h) });
    const bodyEl = contentEl.createDiv({ cls: 'hymns-lyrics-body' });
    bodyEl.setText(formatLyrics(entry, h));
    const bar = contentEl.createDiv({ cls: 'hymns-lyrics-bar' });
    const copyAll = bar.createEl('button', { cls: 'mod-cta', text: '复制全部' });
    copyAll.addEventListener('click', () => copyText(bodyEl.getText()));
    bar.createSpan({ cls: 'hymns-note', text: '可直接用鼠标选取任意文字复制' });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 主视图（侧边栏） ============ */
class HymnsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; plugin.view = this; }

  getViewType() { return VIEW_TYPE_HYMNS; }
  getDisplayText() { return '诗歌 Hymns'; }
  getIcon() { return 'music'; }

  async onOpen() {
    this.query = '';
    this.catFilter = null;
    this.currentList = [];
    this.page = 0;
    this.pageKeys = [];      // 当前列表可用的页码键（0/1/2… 与附录页 S）
    this.selectedIndex = -1;
    this.visibleItems = [];
    this.activeHymn = null;
    this.activeIndex = -1;
    this.viewHymn = null;
    this.viewIndex = -1;
    this.mode = 'list';
    this._audioUrl = null;
    this._audioToken = 0;    // 音频读取令牌（切歌并发保护）
    this._pdfDoc = null;
    this._pdfToken = 0;      // PDF 渲染令牌（翻页并发保护）
    this.isPlaying = false;

    const root = this.contentEl;
    root.empty();
    root.addClass('hymns-view');

    // 列表容器
    this.listWrap = root.createDiv({ cls: 'hymns-listwrap' });
    const header = this.listWrap.createDiv({ cls: 'hymns-header' });
    const titleRow = header.createDiv({ cls: 'hymns-title' });
    titleRow.createSpan({ text: '诗歌 Hymns' });
    this.countEl = titleRow.createSpan({ cls: 'hymns-count' });

    this.resultsEl = this.listWrap.createDiv({ cls: 'hymns-results' });

    /* ---- 底部工具条：搜索框在下、分类与翻页再下一行（分类右侧为 上一页|页码|下一页） ---- */
    const foot = this.listWrap.createDiv({ cls: 'hymns-footbar' });

    const footSearch = foot.createDiv({ cls: 'hymns-foot-search' });
    // 随机一首：只显示符号，位置在搜索框前面
    this.randomBtn = footSearch.createEl('button', { cls: 'hymns-icon-btn hymns-random-btn', attr: { 'aria-label': '随机一首' } });
    setIcon(this.randomBtn, 'dices');
    if (!this.randomBtn.querySelector('svg')) setIcon(this.randomBtn, 'shuffle'); // 图标兜底
    this.randomBtn.addEventListener('click', () => this.playRandom());

    this.searchEl = footSearch.createEl('input', {
      cls: 'hymns-search',
      attr: { type: 'text', placeholder: '编号(如 D116)或关键词(空格分隔)…' }
    });
    this.searchEl.addEventListener('input', () => this.onQueryChanged());
    this.searchEl.addEventListener('keydown', (e) => this.onKey(e));

    const footNav = foot.createDiv({ cls: 'hymns-foot-nav' });
    // 分类：单个按钮，显示当前分类名；默认“全部诗歌”，点击弹出分类菜单
    this.catBtn = footNav.createEl('button', { cls: 'hymns-cat-btn', attr: { 'aria-label': '选择分类' } });
    this.catBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showCatMenu(e); });
    this.updateCatBtn();

    // 翻页：上一页 | 页码 | 下一页（点击页码弹出全部页码，快速跳转）
    this.pagerEl = footNav.createDiv({ cls: 'hymns-pager' });
    this.prevPageBtn = this.pagerEl.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '上一页' } });
    setIcon(this.prevPageBtn, 'chevron-left');
    this.prevPageBtn.addEventListener('click', () => { if (this.page > 0) { this.page--; this.renderList(); } });
    this.pageNumBtn = this.pagerEl.createEl('button', { cls: 'hymns-page-btn hymns-page-num', attr: { 'aria-label': '选择页码' } });
    this.pageNumBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showPageMenu(e); });
    this.nextPageBtn = this.pagerEl.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '下一页' } });
    setIcon(this.nextPageBtn, 'chevron-right');
    this.nextPageBtn.addEventListener('click', () => { if (this.page < (this.pageCount || 1) - 1) { this.page++; this.renderList(); } });
    this.pagerEl.style.display = 'none';

    // 查看容器（侧边栏内显示 PDF）
    this.viewerWrap = root.createDiv({ cls: 'hymns-viewerwrap' });
    this.viewerWrap.style.display = 'none';
    this.viewerToolbar = this.viewerWrap.createDiv({ cls: 'hymns-viewer-toolbar' });
    this.viewerBody = this.viewerWrap.createDiv({ cls: 'hymns-viewer-body' });
    this.viewerActions = this.viewerWrap.createDiv({ cls: 'hymns-viewer-actions' });

    // 播放栏（固定）
    this.buildPlayer(root);

    this.renderListMode();
  }

  /* 随机查阅一首（底部工具条按钮：仅符号）。属于“查阅”行为，
     只切换正在浏览的列表，不改变当前播放列表。 */
  playRandom() {
    const all = this.hymns;
    if (!all.length) return;
    this.setBrowseList(all);
    this.openInViewer(all[Math.floor(Math.random() * all.length)]);
  }

  /* 「查看当前歌曲的 pdf」按钮：在侧边栏打开“当前播放歌曲”所对应的 PDF。
     属于“查阅”行为——不改动当前播放列表，也不改动播放状态。 */
  openCurrentPdf() {
    const h = this.activeHymn;
    if (!h) { new Notice('尚未播放任何诗歌，无法查看其 pdf'); return; }
    if (!h.pdfPath) { new Notice('该诗歌暂无 PDF'); return; }
    this.openInViewer(h);
  }

  async onClose() {
    this.closeDropdown();
    this._audioToken = (this._audioToken || 0) + 1;        // 作废在途的音频读取
    if (this._audioUrl) { URL.revokeObjectURL(this._audioUrl); this._audioUrl = null; }
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.removeAttribute('src'); }
    // 关闭视图前必须释放 PDF 资源（画布 + 文档），否则显存/内存会残留
    this.disposePdfDoc();
    this.disposePdfCanvases();
    this.contentEl.empty();
  }

  /* ---- 播放栏 ---- */
  buildPlayer(root) {
    const player = root.createDiv({ cls: 'hymns-player' });

    // 第一行：当前播放的歌曲名
    this.nowEl = player.createDiv({ cls: 'hymns-now', text: '尚未播放' });

    // 第二行：控制按钮
    const prow = player.createDiv({ cls: 'hymns-player-row' });
    const prevBtn = prow.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '上一首' } });
    setIcon(prevBtn, 'skip-back');
    const nextBtn = prow.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '下一首' } });
    setIcon(nextBtn, 'skip-forward');
    // 播放模式：图标按钮（无中文）
    this.modeBtn = prow.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放模式：' + PLAY_MODE_NAME[this.plugin.settings.playMode] } });
    setIcon(this.modeBtn, PLAY_MODE_ICON[this.plugin.settings.playMode]);
    this.modeBtn.addEventListener('click', () => this.cycleMode());
    const plBtn = prow.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放列表管理' } });
    setIcon(plBtn, 'list-music');
    plBtn.addEventListener('click', () => new ManagePlaylistsModal(this.app, this.plugin).open());

    // 「查看当前歌曲的 pdf」按钮：紧跟在播放列表管理按钮之后（仅查阅，不改动播放列表/播放状态）
    this.linkBtn = prow.createEl('button', {
      cls: 'hymns-icon-btn hymns-pdf-btn',
      attr: { 'aria-label': '查看当前歌曲的pdf', title: '查看当前歌曲的pdf' },
    });
    setIcon(this.linkBtn, 'indent-increase');
    // 图标兜底：个别旧版本内置图标集中若无 indent-increase，则退回文件图标
    if (!this.linkBtn.querySelector('svg')) setIcon(this.linkBtn, 'file-text');
    this.linkBtn.addEventListener('click', () => this.openCurrentPdf());

    // 「联动」按钮：图标按钮（Lucide file-audio），点开可分别勾选两个方向
    // —— MP3 随 PDF 切换 / PDF 随 MP3 切换；与「查看当前歌曲的pdf」一起靠右排列
    this.linkToggleBtn = prow.createEl('button', {
      cls: 'hymns-icon-btn hymns-link-btn',
      attr: { 'aria-label': '联动模式', title: '联动模式' },
    });
    setIcon(this.linkToggleBtn, 'file-audio');
    // 图标兜底：个别旧版本图标集中若无 file-audio，则退回音频相关图标
    if (!this.linkToggleBtn.querySelector('svg')) setIcon(this.linkToggleBtn, 'file-music');
    this.linkToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showLinkMenu(); });
    this.updateLinkBtn();

    prevBtn.addEventListener('click', () => this.navPrev());
    nextBtn.addEventListener('click', () => this.navNext());

    this.audioEl = player.createEl('audio', { attr: { controls: 'true', preload: 'none' } });
    this.audioEl.addEventListener('play', () => { this.isPlaying = true; });
    this.audioEl.addEventListener('pause', () => { this.isPlaying = false; });
    this.audioEl.addEventListener('ended', () => this.onEnded());
  }

  /* 「联动」菜单：两个方向各自独立开关
     · MP3 随 PDF 切换（autoPlayMP3）：在侧边栏打开/翻页诗歌时自动播放它的音频
     · PDF 随 MP3 切换（pdfFollow）　：播放切歌时侧边栏 PDF 自动跟到当前歌曲 */
  showLinkMenu() {
    if (!this.linkToggleBtn) return;
    const s = this.plugin.settings;
    const open = () => this.openDropdown(this.linkToggleBtn, [
      {
        text: 'MP3 随 PDF 切换',
        title: '在侧边栏打开或翻页诗歌时，自动播放该首的音频',
        checkbox: true,             // 前面画方框，选中只在方框里打勾（不改文字颜色）
        checked: !!s.autoPlayMP3,
        onClick: async () => {
          s.autoPlayMP3 = !s.autoPlayMP3;
          await this.plugin.saveAll();
          this.updateLinkBtn();
          open();   // 菜单保持打开，方便继续勾选另一项
        },
      },
      {
        text: 'PDF 随 MP3 切换',
        title: '在查看侧边栏PDF时，自动跟随音频切换PDF',
        checkbox: true,
        checked: !!s.pdfFollow,
        onClick: async () => {
          s.pdfFollow = !s.pdfFollow;
          await this.plugin.saveAll();
          this.updateLinkBtn();
          // 刚打开时立即把侧边栏对齐到当前播放的诗歌
          if (s.pdfFollow && this.activeHymn) {
            this.viewHymn = this.activeHymn;
            if (this.mode === 'viewer') this.renderViewer();
          }
          open();
        },
      },
    ], { keepOpen: true });
    open();
  }

  /* 「联动」按钮外观：图标按钮（file-audio），提示固定为“联动模式”；
     任一项开启时图标用强调色，便于一眼看出联动处于开启状态 */
  updateLinkBtn() {
    if (!this.linkToggleBtn) return;
    const s = this.plugin.settings;
    const on = [];
    if (s.autoPlayMP3) on.push('MP3 随 PDF 切换');
    if (s.pdfFollow) on.push('PDF 随 MP3 切换');
    this.linkToggleBtn.classList.toggle('is-on', on.length > 0);
    this.linkToggleBtn.setAttribute('title', '联动模式');
    this.linkToggleBtn.setAttribute('aria-label', '联动模式');
  }

  cycleMode() {
    const i = PLAY_MODES.indexOf(this.plugin.settings.playMode);
    this.plugin.settings.playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length];
    this.plugin.saveAll();
    this.renderPlayerMode();
    new Notice('播放模式：' + PLAY_MODE_NAME[this.plugin.settings.playMode]);
  }
  renderPlayerMode() {
    if (this.modeBtn) {
      setIcon(this.modeBtn, PLAY_MODE_ICON[this.plugin.settings.playMode]);
      this.modeBtn.setAttribute('aria-label', '播放模式：' + PLAY_MODE_NAME[this.plugin.settings.playMode]);
    }
  }

  get hymns() { return this.plugin.hymns; }

  /* 设置“正在浏览的列表”：只影响查看/翻页（如查看 PDF 的上一首/下一首），
     **不会**改变“当前播放列表”。切换分类、搜索、翻页、随机查阅都走这里。 */
  setBrowseList(list) {
    this.currentList = list;
  }
  /* 设置当前播放列表（仅当用户主动“播放”时才调用）：同步到插件级 currentSequence */
  setCurrentList(list) {
    this.currentList = list;
    this.plugin.currentSequence = list.map((h) => h.uid);
  }

  /* ---- 列表模式 ---- */
  renderListMode(keepScroll) {
    this.mode = 'list';
    this.listWrap.style.display = '';
    this.viewerWrap.style.display = 'none';
    // 离开查看模式：同时释放 pdf.js 文档与画布（显式释放显存），并作废在途渲染
    this.disposePdfDoc();
    this.disposePdfCanvases();
    // keepScroll=true（从 PDF 返回列表）时保留列表滚动位置，不跳回顶部
    this.renderList(keepScroll);
  }

  onQueryChanged() {
    this.query = this.searchEl.value || '';
    this.page = 0;
    this.selectedIndex = -1;
    this.renderList();
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSelection(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.visibleItems[this.selectedIndex];
      if (it) this.openInViewer(it.hymn);
    }
  }

  moveSelection(dir) {
    if (!this.visibleItems.length) return;
    let i = this.selectedIndex + dir;
    if (i < 0) i = 0; if (i >= this.visibleItems.length) i = this.visibleItems.length - 1;
    this.selectedIndex = i;
    this.visibleItems.forEach((it, idx) => it.el.classList.toggle('is-selected', idx === i));
    const sel = this.visibleItems[i];
    if (sel && sel.el.scrollIntoView) sel.el.scrollIntoView({ block: 'nearest' });
  }

  setCat(cat) {
    this.catFilter = cat;
    this.updateCatBtn();
    this.page = 0;
    this.selectedIndex = -1;
    this.renderList();
  }
  showCatMenu() {
    if (!this.catBtn) return;
    // 注意：CAT_ORDER 已含 “O（其他诗歌）”，无需再追加，避免重复项
    const opts = [{ v: null, name: '全部诗歌', color: '' }]
      .concat(CAT_ORDER.map((l) => ({ v: l, name: CATEGORIES[l].name, color: CATEGORIES[l].color })));
    this.openDropdown(this.catBtn, opts.map((o) => ({
      text: o.name,
      color: o.color,
      active: (this.catFilter || null) === o.v,
      onClick: () => this.setCat(o.v),
    })));
  }

  /* 通用下拉弹层：锚定到按钮。默认向上展开（按钮在底部工具条），上方空间不足才向下。 */
  openDropdown(anchorEl, cells, opts) {
    this.closeDropdown();
    const grid = !!(opts && opts.grid);
    const wrap = document.body.createDiv({ cls: 'hymns-dropdown' + (grid ? ' hymns-dropdown-grid' : '') });
    for (const c of cells) {
      // checkbox 型选项（如「联动」菜单）：选中只在方框里打勾，不做颜色/加粗变化
      const activeCls = (c.active && !c.checkbox) ? ' is-active' : '';
      const item = wrap.createDiv({ cls: (grid ? 'hymns-dd-cell' : 'hymns-dropdown-item') + activeCls });
      if (c.title) item.setAttribute('title', c.title);
      if (grid) {
        item.setText(String(c.text));              // 页码：只显示数字
      } else {
        if (c.checkbox) {
          item.createSpan({ cls: 'hymns-dd-box' + (c.checked ? ' is-checked' : ''), text: c.checked ? '✓' : '' });
        }
        if (c.color) { const dot = item.createSpan({ cls: 'hymns-dropdown-dot' }); dot.style.background = c.color; }
        item.createSpan({ cls: 'hymns-dropdown-label', text: String(c.text) });
        if (c.active && !c.checkbox) item.createSpan({ cls: 'hymns-dd-check', text: '✓' });
      }
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        // keepOpen：用于「联动」这类多选菜单，点一项不关闭，方便继续勾选
        if (!(opts && opts.keepOpen)) this.closeDropdown();
        if (c.onClick) c.onClick();
      });
    }
    // 定位：优先按钮上方，其次按钮下方；水平与按钮左对齐并限制在视口内
    const r = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = wrap.offsetWidth, h = wrap.offsetHeight;
    let left = Math.min(Math.max(4, r.left), Math.max(4, vw - w - 4));
    let top = r.top - h - 4;
    if (top < 4) top = Math.min(r.bottom + 4, Math.max(4, vh - h - 4));
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    this._dropdown = wrap;
    this._ddOutside = (e) => { if (this._dropdown && !this._dropdown.contains(e.target)) this.closeDropdown(); };
    document.addEventListener('mousedown', this._ddOutside, true);
  }
  closeDropdown() {
    if (this._dropdown) { this._dropdown.remove(); this._dropdown = null; }
    if (this._ddOutside) { document.removeEventListener('mousedown', this._ddOutside, true); this._ddOutside = null; }
  }
  updateCatBtn() {
    if (!this.catBtn) return;
    let name = '全部诗歌', color = '';
    if (this.catFilter === 'O') { name = '其他诗歌'; color = CATEGORIES.O.color; }
    else if (this.catFilter && CATEGORIES[this.catFilter]) { name = CATEGORIES[this.catFilter].name; color = CATEGORIES[this.catFilter].color; }
    this.catBtn.empty();
    if (color) { const dot = this.catBtn.createSpan({ cls: 'hymns-cat-dot' }); dot.style.background = color; }
    this.catBtn.append(name);
    this.catBtn.setAttribute('aria-label', '当前分类：' + name + '（点击切换）');
  }

  computeList() {
    const q = this.query.trim();
    let list = this.hymns;
    if (this.catFilter === 'O') list = list.filter((h) => !KNOWN_LETTERS.has(h.letter));
    else if (this.catFilter) list = list.filter((h) => h.letter === this.catFilter);
    if (!q) return this.catFilter ? list.slice() : null;
    const keywords = q.split(/\s+/).filter(Boolean);
    return list.filter((h) => this.matchAllKeywords(h, keywords)).slice();
  }

  matchAllKeywords(h, keywords) {
    const meta = (h.code + ' ' + (h.variant || '') + ' ' + (h.title || '') + ' ' + catInfo(h.letter).name).toLowerCase();
    const lyrics = (this.plugin.getLyrics(h.uid) || '').toLowerCase();
    return keywords.every((kw) => {
      const k = kw.toLowerCase();
      return meta.includes(k) || lyrics.includes(k);
    });
  }

  /* keepScroll=true 时保留列表当前滚动位置（退出 PDF 返回列表用）；否则回到顶部 */
  renderList(keepScroll) {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    this.visibleItems = [];
    if (this.countEl) {
      const nLy = Object.keys(this.plugin.lyrics || {}).length;
      this.countEl.setText('· 共 ' + this.hymns.length + ' 首' + (nLy ? ('（歌词 ' + nLy + '）') : '（无歌词索引）'));
    }

    const list = this.computeList();
    if (list === null) { this.renderHome(); return; }
    // 切换分类/搜索/翻页都只是“浏览”，不改动当前播放列表
    this.setBrowseList(list);

    if (list.length === 0) {
      this.resultsEl.createDiv({ cls: 'hymns-empty', text: '未找到匹配的诗歌' });
      return;
    }
    // 按“编号区间”分页：页码 0 = 编号 0-99，1 = 100-199 …，附录统一进页码 S。
    // 每个页码显示哪些诗歌只取决于编号，与列表长短无关。
    const pages = buildPages(list);
    this.pageKeys = pages.map((pg) => pg.key);
    if (this.page < 0) this.page = 0;
    if (this.page > pages.length - 1) this.page = pages.length - 1;
    this.selectedIndex = -1;
    const slice = pages[this.page] ? pages[this.page].items : [];
    this.visibleItems = slice.map((h) => {
      const el = this.renderItem(h);
      this.resultsEl.appendChild(el);
      return { el, hymn: h };
    });
    this.renderPager(pages.length, list.length);
    // 切换页码/分类/搜索后列表回到顶部；从 PDF 返回列表时（keepScroll）保留当前位置
    if (!keepScroll) this.resultsEl.scrollTop = 0;
  }

  /* 分页栏：驱动底部工具条中的 pagerEl（上一页 | 页码 | 下一页）
     页码显示的是“编号区间”，如 0 = 编号 0-99，1 = 100-199，S = 附录。 */
  renderPager(totalPages, total) {
    this.pageCount = totalPages;
    if (!this.pagerEl) return;
    if (totalPages <= 1) { this.pageCount = 1; this.pagerEl.style.display = 'none'; return; }
    this.pagerEl.style.display = '';
    if (this.pageNumBtn) {
      const keys = this.pageKeys || [];
      const cur = (keys[this.page] != null) ? keys[this.page] : String(this.page);
      // 只显示当前页码（0 / 1 / 2 … 或 S），不显示总页数与“页”字；
      // 总页数仍可从点开的页码网格里看到，悬停提示保留编号区间
      this.pageNumBtn.empty();
      this.pageNumBtn.createSpan({ cls: 'hymns-page-cur', text: cur });
      this.pageNumBtn.setAttribute('aria-label', pageRangeLabel(cur) + '（点击选择页码）');
    }
    if (this.prevPageBtn) this.prevPageBtn.disabled = this.page <= 0;
    if (this.nextPageBtn) this.nextPageBtn.disabled = this.page >= totalPages - 1;
  }

  /* 页码弹出：数字网格（0 / 1 / 2 …）+ 末尾的 “S”（附录），当前页红色高亮，锚定到页码按钮展开 */
  showPageMenu() {
    const keys = this.pageKeys || [];
    if (!this.pageNumBtn || keys.length <= 1) return;
    const cells = keys.map((k, idx) => ({
      text: k,
      title: pageRangeLabel(k),   // 悬停提示：该页对应的编号范围
      active: idx === this.page,
      onClick: () => { this.page = idx; this.renderList(); },
    }));
    this.openDropdown(this.pageNumBtn, cells, { grid: true });
  }

  renderHome() {
    // 首页（全部诗歌）：底部页码栏在此视图无意义，隐藏
    if (this.pagerEl) this.pagerEl.style.display = 'none';
    this.pageKeys = [];
    this.pageCount = 1;

    // 一首都没扫到时：直接给出原因与“打开设置”入口，而不是只显示一片空白
    if (!this.hymns.length) {
      const box = this.resultsEl.createDiv({ cls: 'hymns-empty-guide' });
      box.createDiv({ cls: 'hymns-empty-guide-title', text: '还没有扫描到任何诗歌 PDF' });
      box.createDiv({ text: '诗歌靠“文件名编号”识别（如 D116、E836（补充版））。请到设置里把「PDF 文件夹」留空（即扫描整个仓库），或用「自动检测」一键定位。' });
      const b = box.createEl('button', { cls: 'mod-cta', text: '打开插件设置' });
      b.addEventListener('click', () => this.plugin.openPluginSettings());
      return;
    }

    const recents = this.plugin.recent.map((c) => this.plugin.resolveHymn(c)).filter(Boolean);
    const playlists = this.plugin.playlists;

    // 分类卡片：点击跳转到相应诗歌列表
    const cardWrap = this.resultsEl.createDiv({ cls: 'hymns-cat-cards' });
    CAT_ORDER.forEach((letter) => {
      const cat = CATEGORIES[letter];
      const count = (letter === 'O')
        ? this.hymns.filter((h) => !KNOWN_LETTERS.has(h.letter)).length
        : this.hymns.filter((h) => h.letter === letter).length;
      if (!count) return; // 跳过空分类
      const card = cardWrap.createDiv({ cls: 'hymns-cat-card', attr: { 'aria-label': cat.name + '：' + count + ' 首' } });
      const dot = card.createSpan({ cls: 'hymns-cat-card-dot' });
      dot.style.background = cat.color;
      card.createDiv({ cls: 'hymns-cat-card-name', text: cat.name });
      card.createDiv({ cls: 'hymns-cat-card-count', text: count + ' 首' });
      card.addEventListener('click', () => this.setCat(letter));
    });

    // 最近打开（默认折叠）
    if (recents.length) {
      this.renderCollapsible('🕘 最近打开', true, (body) => {
        recents.forEach((h) => body.appendChild(this.renderItem(h)));
      });
    }
    // 播放列表（默认折叠）
    if (playlists.length) {
      this.renderCollapsible('🎵 播放列表（点击即播放）', true, (body) => {
        playlists.forEach((pl) => {
          const row = body.createDiv({ cls: 'hymns-item hymns-playlist-row' });
          const info = row.createDiv({ cls: 'hymns-info' });
          info.createDiv({ cls: 'hymns-code', text: '🎵 ' + pl.name });
          info.createDiv({ cls: 'hymns-title-text', text: pl.codes.length + ' 首' });
          row.addEventListener('click', (e) => { e.stopPropagation(); this.plugin.playPlaylist(pl.name); });
        });
      });
    }

    if (!recents.length && !playlists.length && !cardWrap.childElementCount) {
      this.resultsEl.createDiv({ cls: 'hymns-empty', text: '点击上方分类卡片浏览诗歌；\n或在搜索框输入编号(如 D116)或关键词(如 恩典 耶稣)开始搜索。' });
    }
    this.resultsEl.scrollTop = 0;
  }

  /* 可折叠区块：标题栏可点击展开/收起；startCollapsed=true 时默认折叠 */
  renderCollapsible(title, startCollapsed, fillBody) {
    const section = this.resultsEl.createDiv({ cls: 'hymns-collapsible' });
    const head = section.createDiv({ cls: 'hymns-collapsible-head' });
    head.createSpan({ cls: 'hymns-collapsible-title', text: title });
    const caret = head.createSpan({ cls: 'hymns-collapsible-caret' });
    setIcon(caret, 'chevron-right');
    const body = section.createDiv({ cls: 'hymns-collapsible-body' });
    let open = !startCollapsed;
    const apply = () => {
      body.style.display = open ? '' : 'none';
      caret.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
      head.classList.toggle('is-open', open);
    };
    apply();
    head.addEventListener('click', () => { open = !open; apply(); });
    fillBody(body);
    return section;
  }

  renderItem(h) {
    const el = document.createElement('div');
    el.classList.add('hymns-item');
    el.dataset.uid = h.uid;

    const badge = el.createSpan({ cls: 'hymns-badge', text: h.letter });
    badge.style.background = catInfo(h.letter).color;

    const info = el.createDiv({ cls: 'hymns-info' });
    // 一行显示：编号 + 诗歌名字（名字写在编号后面）
    const head = info.createDiv({ cls: 'hymns-head' });
    const keywords = this.query.trim().split(/\s+/).filter(Boolean);
    // 编号与标题同样参与高亮：有些搜索是命中标题（歌词里没有该词），
    // 此时只有把标题中的命中位置标出来，用户才知道为什么这首会被搜出来。
    const hit = (s) => keywords.length > 0 && keywords.some((k) => s.toLowerCase().includes(k.toLowerCase()));
    const codeSpan = head.createSpan({ cls: 'hymns-code' });
    if (hit(h.code)) codeSpan.innerHTML = highlight(h.code, keywords); else codeSpan.setText(h.code);
    // 同一编号存在多个版本时，在编号右侧标注版本，便于一眼分辨
    if (h.variant) head.createSpan({ cls: 'hymns-variant-tag', text: h.variant });
    const titleText = h.title || catInfo(h.letter).name;
    const titleSpan = head.createSpan({ cls: 'hymns-title-inline' });
    if (hit(titleText)) titleSpan.innerHTML = highlight(titleText, keywords); else titleSpan.setText(titleText);
    const lyrics = this.plugin.getLyrics(h.uid) || '';
    if (keywords.length && lyrics) {
      const snippet = this.buildSnippet(lyrics, keywords);
      if (snippet) {
        const sub = info.createDiv({ cls: 'hymns-title-text' });
        sub.innerHTML = highlight(snippet, keywords);
        info.classList.add('has-snippet');
      }
    }

    const actions = el.createDiv({ cls: 'hymns-actions' });
    if (h.mp3Path) {
      const playBtn = actions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放' } });
      setIcon(playBtn, 'play');
      playBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playFromList(h); });
    }
    const add = actions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '加入播放列表' } });
    setIcon(add, 'list-plus');
    add.addEventListener('click', (e) => { e.stopPropagation(); new AddToPlaylistModal(this.app, this.plugin, h).open(); });

    const more = actions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '更多' } });
    setIcon(more, 'more-vertical');
    more.addEventListener('click', (e) => { e.stopPropagation(); this.showCopyMenu(h, e); });

    let timer = null;
    el.addEventListener('click', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.openInViewer(h), 220);
    });
    el.addEventListener('dblclick', () => {
      if (timer) clearTimeout(timer);
      this.openInNewTab(h);
    });
    return el;
  }

  /* 命中片段。
     关键：片段截取后会被列表的 3 行省略号（-webkit-line-clamp: 3）截断，
     所以命中词必须落在片段最前面——这里保证关键词距片段开头不超过 12 字，
     否则预览里根本看不到高亮（曾经 pos-40 起截，命中词被挤到第 4 行之后而不可见）。
     多关键词时最多展示两处命中位置，用 … 连接。 */
  buildSnippet(lyrics, keywords) {
    if (!lyrics) return '';
    const low = lyrics.toLowerCase();
    const kws = [];
    keywords.filter(Boolean).forEach((k) => { const s = k.toLowerCase(); if (!kws.includes(s)) kws.push(s); });
    const win = [];
    for (const k of kws) {
      const pos = low.indexOf(k);
      if (pos < 0) continue;                                            // 该关键词不在歌词里（可能命中标题）
      if (win.some((w) => pos >= w.start && pos <= w.end)) continue;    // 已被已有窗口覆盖
      const lineStart = lyrics.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
      // 尽量保留整行；命中词在本行太靠后（>20 字）时再往前收，保证它落在前 20 字内
      const start = Math.max(0, Math.max(lineStart, pos - 20));
      const end = Math.min(lyrics.length, Math.max(pos + 46, start + 46));
      win.push({ start, end });
      if (win.length >= 2) break;
    }
    if (!win.length) return lyrics.slice(0, 80) + (lyrics.length > 80 ? '…' : ''); // 歌词里没有关键词 → 预览开头
    win.sort((a, b) => a.start - b.start);
    return win
      .map((w) => (w.start > 0 ? '…' : '') + lyrics.slice(w.start, w.end) + (w.end < lyrics.length ? '…' : ''))
      .join(' … ');
  }

  /* 复制菜单（列表与查看器的“更多”按钮共用）：仅保留 4 个复制项 */
  showCopyMenu(h, evt) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('复制 PDF 链接').onClick(() => copyText('[[' + linkBase(h.pdfPath) + ']]')));
    menu.addItem((i) => i.setTitle('复制 PDF 嵌入').onClick(() => copyText('![[' + embedBase(h.pdfPath) + ']]')));
    if (h.mp3Path) {
      menu.addItem((i) => i.setTitle('复制 MP3 链接').onClick(() => copyText('[[' + linkBase(h.mp3Path) + ']]')));
      menu.addItem((i) => i.setTitle('复制 MP3 嵌入').onClick(() => copyText('![[' + embedBase(h.mp3Path) + ']]')));
    }
    menu.addItem((i) => i.setTitle('复制歌词').onClick(() => new LyricsModal(this.app, this.plugin, h).open()));
    menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }

  /* ---- 查看模式（侧边栏内显示 PDF） ---- */
  openInViewer(h) {
    // 查看 PDF 仅用于“查阅”：只切换正在浏览的列表与当前查看的诗歌，
    // 绝不改动当前播放列表（currentSequence），也不改动播放指针（activeHymn/activeIndex）。
    if (!this.currentList.length) this.setBrowseList(this.hymns.slice());
    this.viewHymn = h;
    this.viewIndex = Math.max(0, this.currentList.findIndex((x) => x.uid === h.uid));
    this.mode = 'viewer';
    this.listWrap.style.display = 'none';
    this.viewerWrap.style.display = '';
    this.renderViewer();
    this.autoPlayIfEnabled(h);          // 设置里打开后，查看 PDF 即自动播放其音频
  }
  closeViewer() { this.renderListMode(true); }

  /* 自动播放（设置项「打开/翻页诗歌时自动播放音频」）：
     查看或翻页到某首诗歌时自动播放它的 MP3——等价于替你按了一次“播放”，
     所以会把正在浏览的列表作为当前播放列表，播放栏的上/下一首才能顺着往下走。
     关闭时查看/翻页完全不影响播放（与之前一致）。 */
  async autoPlayIfEnabled(h) {
    if (!this.plugin.settings.autoPlayMP3 || !h) return;
    // 正在播放的就是这一首（例如点「查看当前歌曲的 pdf」）→ 不要打断重来
    if (this.isPlaying && this.activeHymn && this.activeHymn.uid === h.uid) return;
    if (!h.mp3Path) {
      if (this.nowEl) this.nowEl.setText(hymnLabel(h) + '（暂无音频）');
      return;
    }
    await this.playFromList(h);
  }

  renderViewer() {
    const h = this.viewHymn;
    if (!h) { this.renderListMode(); return; }

    // 顶部工具栏：只保留标题（翻页/关闭按钮已移到 PDF 下方）
    this.viewerToolbar.empty();
    this.viewerToolbar.createSpan({ cls: 'hymns-viewer-title', text: hymnLabel(h) });

    this.renderViewerPdf(h);

    // 底部操作区：上一首 / 下一首 → 播放 / 加入播放列表 / 打开PDF / 复制 → 关闭
    this.viewerActions.empty();
    const prev = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '上一首' } });
    setIcon(prev, 'chevron-left');
    prev.addEventListener('click', () => this.viewerStep(-1));
    const next = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '下一首' } });
    setIcon(next, 'chevron-right');
    next.addEventListener('click', () => this.viewerStep(1));

    const playBtn = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '播放当前诗歌' } });
    setIcon(playBtn, 'play');
    playBtn.addEventListener('click', () => this.playFromList(h));
    const addBtn = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '加入播放列表' } });
    setIcon(addBtn, 'list-plus');
    addBtn.addEventListener('click', () => new AddToPlaylistModal(this.app, this.plugin, h).open());
    const openBtn = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '在新标签打开 PDF' } });
    setIcon(openBtn, 'file-text');
    openBtn.addEventListener('click', () => this.openInNewTab(h));
    const copyBtn = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '更多' } });
    setIcon(copyBtn, 'more-vertical');
    copyBtn.addEventListener('click', (e) => this.showCopyMenu(h, e));
    const close = this.viewerActions.createEl('button', { cls: 'hymns-icon-btn', attr: { 'aria-label': '关闭 PDF' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.closeViewer());
  }

  /* 释放 PDF 画布：必须先把宽高显式置 0，让 Chromium 立即回收 GPU 纹理，再从 DOM 移除。
     只 remove() 的话要等 GC，反复翻页时显存只涨不降 → 最终渲染进程崩溃（白屏）。 */
  disposePdfCanvases() {
    if (!this.viewerBody) return;
    this.viewerBody.querySelectorAll('canvas').forEach((c) => {
      try { c.width = 0; c.height = 0; } catch (e) { /* ignore */ }
      c.remove();
    });
  }
  /* 释放 pdf.js 文档（连同 loadingTask 一起销毁），并递增令牌作废所有在途渲染任务 */
  disposePdfDoc() {
    this._pdfToken = (this._pdfToken || 0) + 1;
    const doc = this._pdfDoc; this._pdfDoc = null;
    if (!doc) return;
    try { if (doc.loadingTask && doc.loadingTask.destroy) doc.loadingTask.destroy(); } catch (e) { /* ignore */ }
    try { doc.destroy(); } catch (e) { /* ignore */ }
  }

  /* 用 pdf.js 将 PDF 渲染到 canvas（跨平台，可靠）；过大 / 失败时回退为资源 URL 内嵌。 */
  async renderViewerPdf(h) {
    const body = this.viewerBody;
    this.disposePdfDoc();          // 释放上一份文档（同时作废所有在途渲染）
    this.disposePdfCanvases();     // 释放上一批画布（显存）
    // 渲染代际令牌：一旦开始新的渲染（翻页 / 换歌），上一次未完成的任务立即作废。
    // 否则旧任务的 await 结束后仍会往同一个 body 里 append canvas，画布数量成倍增长、
    // 显存耗尽 → Obsidian 白屏（这是“开了插件用一会儿就白屏”的主因）。
    const token = (this._pdfToken = (this._pdfToken || 0) + 1);
    const stale = () => token !== this._pdfToken;
    body.empty();

    const pdfPath = (h && h.pdfPath) ? String(h.pdfPath) : '';
    if (!pdfPath) { body.createDiv({ cls: 'hymns-empty', text: '该诗歌没有可用的 PDF 路径（请重建索引后再试）。' }); return; }
    let file = null;
    try { file = this.app.vault.getAbstractFileByPath(pdfPath); } catch (e) { file = null; }
    if (!(file instanceof TFile)) { body.createDiv({ cls: 'hymns-empty', text: '未找到 PDF：' + pdfPath }); return; }

    // 体积保护：超大 PDF（如《整编本诗歌》合集）连二进制都不读进内存，
    // 也不交给 iframe 内嵌（同样会拖垮侧边栏），只提示用“在新标签打开 PDF”。
    const size = (file.stat && file.stat.size) || 0;
    if (size > PDF_PREVIEW_MAX_BYTES) {
      this.renderViewerPdfFallback(body, pdfPath, null, {
        noEmbed: true,
        note: '该 PDF 较大（' + (size / 1048576).toFixed(1) + ' MB），已跳过侧边栏预览，请用下方“在新标签打开 PDF”。',
      });
      return;
    }

    // 读文件：vault 读不到时退回 adapter 读（避免个别路径在 vault 索引里不可见）
    let buf = null; let readErr = null;
    try { buf = await this.app.vault.readBinary(pdfPath); }
    catch (e) { readErr = e; try { buf = await this.app.vault.adapter.readBinary(pdfPath); } catch (e2) { readErr = e2; } }
    if (stale()) return;                                   // 读取期间已翻页 → 直接放弃
    if (!buf) { body.createDiv({ cls: 'hymns-empty', text: 'PDF 读取失败：' + ((readErr && readErr.message) || readErr) }); return; }

    let lib;
    try { lib = await this.plugin.ensurePdfLib(); }
    catch (e) {
      body.createDiv({ cls: 'hymns-empty', text: 'PDF 引擎加载失败：' + e.message + '\n可用下方“在新标签打开 PDF”按钮。' });
      return;
    }
    if (stale()) return;
    body.createDiv({ cls: 'hymns-empty', text: '加载 PDF 中…' });

    let doc = null;
    try {
      doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      if (stale()) { try { doc.destroy(); } catch (e2) { /* ignore */ } return; }
      this._pdfDoc = doc;
      body.empty();
      const targetW = Math.max(200, (body.clientWidth || 320));
      const total = Number(doc.numPages) || 0;
      if (!total) throw new Error('PDF 页数异常，文件可能已损坏');    // 防 numPages 为 NaN/0 时渲染出空白
      const maxPages = Math.min(total, PDF_PREVIEW_MAX_PAGES);
      for (let p = 1; p <= maxPages; p++) {
        if (stale()) return;                                // 已被新的渲染取代 → 立刻停手
        const page = await doc.getPage(p);
        if (stale()) { try { page.cleanup(); } catch (e2) { /* ignore */ } return; }
        const baseVp = page.getViewport({ scale: 1 });
        const scale = targetW / baseVp.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.background = '#fff';
        canvas.style.marginBottom = '8px';
        canvas.style.borderRadius = '4px';
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        if (stale()) { try { canvas.width = 0; canvas.height = 0; } catch (e2) { /* ignore */ } return; }
        body.appendChild(canvas);
        // 让出主线程：pdf.js 走“伪 worker”（解析在主线程），必须喘口气，否则侧边栏长时间无响应
        await sleep(0);
      }
      if (total > maxPages) {
        body.createDiv({ cls: 'hymns-note', text: '仅预览前 ' + maxPages + ' 页（共 ' + total + ' 页）；完整内容请用下方“在新标签打开 PDF”。' });
      }
    } catch (e) {
      if (stale()) return;
      console.error('[Hymns] PDF 渲染失败', pdfPath, e);
      this.renderViewerPdfFallback(body, pdfPath, e);
    }
  }

  /* 兜底：canvas 渲染失败时，用资源 URL 把 PDF 内嵌进侧边栏（不依赖 pdf.js）。
     opts.noEmbed = true 时只给提示（超大文件内嵌同样会拖垮 Obsidian）。 */
  renderViewerPdfFallback(body, pdfPath, err, opts) {
    body.empty();
    const o = opts || {};
    let res = '';
    if (!o.noEmbed) {
      try {
        if (this.app.vault.adapter && this.app.vault.adapter.getResourcePath) res = this.app.vault.adapter.getResourcePath(pdfPath);
      } catch (e) { res = ''; }
    }
    if (o.note) body.createDiv({ cls: 'hymns-empty', text: o.note });
    else body.createDiv({ cls: 'hymns-empty', text: 'PDF 渲染失败：' + ((err && err.message) || err) });
    if (res) {
      const frame = body.createEl('iframe', { cls: 'hymns-pdf-frame' });
      frame.setAttribute('src', res);
      body.createDiv({ cls: 'hymns-note', text: '已用内嵌方式打开；若仍空白，请用下方“在新标签打开 PDF”。' });
    } else {
      body.createDiv({ cls: 'hymns-note', text: '可用下方“在新标签打开 PDF”按钮。' });
    }
  }

  /* PDF 视图内的上一首/下一首：仅在“正在浏览的列表”内切换要查看的 PDF，
     不影响 MP3 播放状态，也不改动当前播放列表。 */
  viewerStep(dir) {
    let list = this.currentList;
    if (!list || !list.length) { list = this.hymns.slice(); this.setBrowseList(list); }
    // 必须用 uid 定位，不能用编号 code：同一编号可能有多个版本
    // （如 E836 与 E836（补充版）），按编号找会永远落在同编号的第一首，
    // 于是“上一首”跳过头、“下一首”原地不动。
    let i = this.viewHymn ? list.findIndex((x) => x.uid === this.viewHymn.uid) : -1;
    if (i < 0 && this.viewHymn) i = list.findIndex((x) => x.code === this.viewHymn.code); // 兜底：落到同编号
    if (i < 0) i = this.viewIndex;
    if (i < 0) i = 0;
    const j = i + dir;
    if (j < 0 || j >= list.length) { new Notice(dir > 0 ? '已经是列表最后一首' : '已经是列表第一首'); return; }
    const h = list[j];
    if (!h || h.uid === (this.viewHymn && this.viewHymn.uid)) return;
    this.viewHymn = h; this.viewIndex = j;
    this.renderViewer();
    this.autoPlayIfEnabled(h);          // 翻页同样受自动播放开关控制
  }

  /* ---- 播放 ---- */
  /* 用户主动点“播放”：把“正在浏览的列表”设为当前播放列表，并从该首开始播放。 */
  async playFromList(h) {
    let list = this.currentList;
    if (!list || !list.length) list = this.hymns.slice();
    this.setCurrentList(list);                                  // 只有主动播放才更新当前播放列表
    this.activeIndex = Math.max(0, list.findIndex((x) => x.uid === h.uid));
    this.activeHymn = h;
    await this.playHymn(h);
  }
  /* 只在“当前播放列表”内播放某一首（切歌 / 单曲循环）：不改变当前播放列表。 */
  async playInQueue(h) {
    const codes = this.plugin.currentSequence || [];
    const i = codes.indexOf(h.uid);
    this.activeIndex = i < 0 ? 0 : i;
    this.activeHymn = h;
    await this.playHymn(h);
  }

  async playHymn(h) {
    if (!h.mp3Path) { new Notice('该诗歌暂无 MP3'); return; }
    // 令牌：快速连续切歌时作废上一次尚未读完的请求，避免同时把多个 MP3 读进内存
    const token = (this._audioToken = (this._audioToken || 0) + 1);
    try {
      const buf = await this.app.vault.adapter.readBinary(h.mp3Path);
      if (token !== this._audioToken) return;               // 已被新的播放请求取代
      const blob = new Blob([buf], { type: 'audio/mpeg' });
      if (this._audioUrl) URL.revokeObjectURL(this._audioUrl);
      this._audioUrl = URL.createObjectURL(blob);
      this.audioEl.src = this._audioUrl;
      await this.audioEl.play();
      if (token !== this._audioToken) return;               // play() 期间又被切歌
      this.nowEl.setText(hymnLabel(h));
      this.plugin.addRecent(h.uid);
    } catch (e) {
      if (token !== this._audioToken) return;               // 被新播放打断的 reject 不算错误
      new Notice('播放失败：' + e.message);
    }
  }

  openInNewTab(h) {
    const f = this.app.vault.getAbstractFileByPath(h.pdfPath);
    if (!(f instanceof TFile)) { new Notice('未找到 PDF：' + h.pdfPath); return; }
    this.app.workspace.getLeaf(true).openFile(f);
    this.plugin.addRecent(h.code);
  }

  /* ---- 导航（切歌）：只在“当前播放列表”内移动，与正在浏览的列表无关 ---- */
  navNext() { this.navStep(1); }
  navPrev() { this.navStep(-1); }
  navStep(dir) {
    // 尚未开始播放（当前播放列表为空）：把“正在浏览的列表”作为播放列表（等同一次主动播放），从第 1 首开始
    if (!(this.plugin.currentSequence || []).length) {
      const bl = (this.currentList && this.currentList.length) ? this.currentList : this.hymns.slice();
      if (!bl.length) { new Notice('没有可切换的歌曲'); return; }
      this.setCurrentList(bl);
      const h0 = bl[0];
      this.activeIndex = 0;
      this.activeHymn = h0;
      if (this.plugin.settings.pdfFollow) {
        this.viewHymn = h0; this.viewIndex = 0;
        if (this.mode === 'viewer') this.renderViewer();
      }
      this.playInQueue(h0);
      return;
    }
    const codes = this.plugin.currentSequence || [];
    const list = codes.map((c) => this.plugin.resolveHymn(c)).filter(Boolean);
    if (!list.length) { new Notice('当前播放列表为空'); return; }
    const mode = this.plugin.settings.playMode;
    let i = this.activeIndex; if (i < 0 || i >= list.length) i = 0;
    if (mode === 'shuffle') {
      if (list.length === 1) { i = 0; }
      else { let n; do { n = Math.floor(Math.random() * list.length); } while (n === i); i = n; }
    } else {
      i = i + dir;
      if (i < 0) { if (mode === 'loop') i = list.length - 1; else { i = 0; this.stopAtEnd(); return; } }
      if (i >= list.length) { if (mode === 'loop') i = 0; else { i = list.length - 1; this.stopAtEnd(); return; } }
    }
    this.activeIndex = i;
    const h = list[i]; this.activeHymn = h;
    // 仅当勾选“联动”时，侧边栏 PDF 才随音频变动；默认不跟随，避免正在查阅的 PDF 被播放打断
    if (this.plugin.settings.pdfFollow) {
      this.viewHymn = h;
      const vi = this.currentList.findIndex((x) => x.uid === h.uid);
      this.viewIndex = vi < 0 ? i : vi;
      if (this.mode === 'viewer') this.renderViewer();
    }
    this.playInQueue(h);
  }
  stopAtEnd() {
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.currentTime = 0; }
    this.isPlaying = false;
  }
  onEnded() {
    const mode = this.plugin.settings.playMode;
    if (mode === 'one') {
      // 单曲循环：在当前播放列表内重播同一首，不改变当前播放列表
      const codes = this.plugin.currentSequence || [];
      const h = this.plugin.resolveHymn(codes[this.activeIndex]);
      if (h) this.playInQueue(h);
      return;
    }
    this.navStep(1); // sequential / loop / shuffle 统一交给 navStep
  }
}

/* ============ 插件主类 ============ */
class HymnsPlugin extends Plugin {
  async onload() {
    const data = await this.loadData() || {};
    this.settings = Object.assign({
      // 留空 = 扫描整个仓库（零配置即可用；识别靠文件名编号，路径只用于缩小范围）
      pdfFolder: '',
      mp3Folder: '',
      autoPlayMP3: false,
      playMode: 'sequential',
      pdfFollow: false,     // PDF 联动：选中后侧边栏 PDF 随播放变动，默认关闭
      autoCheckUpdate: true, // 启动时自动检测更新（12 小时节流一次）
      lastVersion: '',       // 上次已记录的版本号，用于判断「是否升级」并弹更新说明
      dismissedVersion: '',  // 用户点「稍后」的版本号，避免重复打扰
      lastUpdateCheckAt: 0   // 上次检查更新的时间戳（毫秒），用于节流
    }, data.settings || {});
    this.playlists = data.playlists || [];
    this.removedBuiltinIds = data.removedBuiltinIds || [];
    this.recent = data.recent || [];
    this.ensureBuiltinPlaylists();   // 首次加载自动写入内置默认播放列表
    this.hymns = [];
    this.hymnByUid = new Map();
    this.groupByCode = new Map();
    this.lyrics = {};
    this._lyricsErr = '';
    this.currentSequence = [];   // 当前播放列表（实时）
    this.view = null;
    this._pdfLib = null;

    this.registerView(VIEW_TYPE_HYMNS, (leaf) => new HymnsView(leaf, this));
    this.addSettingTab(new HymnsSettingTab(this.app, this));
    this.addRibbonIcon('music', '打开诗歌 Hymns', () => this.activateView());
    this.addCommand({ id: 'open-hymns-view', name: '打开诗歌面板', callback: () => this.activateView() });
    this.addCommand({ id: 'rebuild-hymns-index', name: '重建诗歌（PDF/MP3）索引', callback: async () => {
      await this.buildIndex(); if (this.view) this.view.renderListMode();
      new Notice('诗歌索引已重建，共 ' + this.hymns.length + ' 首');
    } });
    this.addCommand({ id: 'rebuild-hymns-lyrics', name: '重建歌词索引', callback: async () => {
      await this.rebuildLyrics(false);
    } });

    this.app.workspace.onLayoutReady(async () => {
      await this.buildIndex();
      await this.loadLyrics();
      if (!this.hymns.length) {
        // 0 首必须明说，否则用户只会看到“空列表”而无从下手
        new Notice('Hymns：没有扫描到任何诗歌 PDF。请到设置里把「PDF 文件夹」留空（扫描整个仓库），或用「自动检测」一键定位。', 12000);
      } else if (!Object.keys(this.lyrics).length) {
        // 有诗歌 PDF 但还没建歌词索引 → 首次启动自动建立（带进度提示），无需手动点按钮。
        // 自动建完后 lyrics.json 已落盘（即便全是图片型 PDF 也会写入 _empty 占位），
        // 故下次启动 loadLyrics 读到非空即跳过，不会反复慢启动。
        try {
          await this.rebuildLyrics(false);
        } catch (e) {
          new Notice('自动建立歌词索引失败：' + (e && e.message ? e.message : e) + '。可到设置手动点“重建歌词索引”。', 10000);
        }
      }
      if (this.view) this.view.renderListMode();
      // 启动后自动检测更新（受 settings.autoCheckUpdate 与 12 小时节流控制）
      this.onUpdateFlow();
    });
  }

  onunload() {
    if (this.view && this.view._audioUrl) URL.revokeObjectURL(this.view._audioUrl);
  }

  allData() {
    return { settings: this.settings, playlists: this.playlists, recent: this.recent, removedBuiltinIds: this.removedBuiltinIds };
  }
  async saveAll() { await this.saveData(this.allData()); }

  /* 动态解析插件自身目录（跨平台最可靠）：优先用 manifest.dir（Obsidian 加载插件时写入的真实文件夹名），
     否则扫描 .obsidian/plugins 按 manifest.id 反查，最后按 id 兜底拼接。 */
  async getPluginRel() {
    if (this._pluginRel) return this._pluginRel;
    const id = this.manifest && this.manifest.id;
    // 策略1：manifest.dir 已是插件真实文件夹名，桌面/移动通用，无需扫描（最稳）
    if (this.manifest && this.manifest.dir) {
      this._pluginRel = this.manifest.dir;
      return this._pluginRel;
    }
    // 策略2：扫描 .obsidian/plugins，按 manifest.id 反查真正文件夹名（id 与文件夹名可能不一致）
    const root = '.obsidian/plugins';
    try {
      const list = await this.app.vault.adapter.list(root);
      const folders = (list && list.folders) || [];
      for (const f of folders) {
        try {
          const m = JSON.parse(await this.app.vault.adapter.read(f + '/manifest.json'));
          if (m && m.id === id) { this._pluginRel = f; return f; }
        } catch (e) { /* 跳过无效目录 */ }
      }
    } catch (e) { /* list 不支持时走兜底 */ }
    // 策略3：兜底按 id 拼接（多数情况 id 即文件夹名）
    this._pluginRel = (id ? root + '/' + id : root + '/hymns');
    return this._pluginRel;
  }

  /* 歌词索引：Obsidian 插件沙箱里 require('./x.json') 无法解析本地文件，必须通过 vault.adapter 读取 */
  async loadLyrics() {
    const candidates = [
      (await this.getPluginRel()) + '/lyrics.json',
      'hymns-lyrics.json'
    ].filter(Boolean);
    let data = null; const errs = [];
    for (const p of candidates) {
      try {
        const text = await this.app.vault.adapter.read(p);
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object' && Object.keys(obj).length) { data = obj; break; }
        errs.push(p + ' 内容为空');
      } catch (e) { errs.push(p + ' → ' + (e && e.message ? e.message : e)); }
    }
    this.lyrics = data || {};
    this._lyricsErr = data ? '' : errs.join('；');
    const n = Object.keys(this.lyrics).length;
    if (!n) console.warn('[Hymns] 未加载到歌词索引：', this._lyricsErr);
  }
  /* key 为诗歌唯一标识 uid（= 编号，或 编号#版本标注） */
  getLyrics(id) { const e = this.lyrics[id]; return e ? (e.lyrics || '') : ''; }

  /* pdf.js 加载：在“隔离作用域”中执行 UMD，绝不写入 window.pdfjsLib / globalThis.pdfjsWorker。
     ⚠️ 关键：Obsidian 自带 PDF 查看器依赖 window.pdfjsLib（其内部 workerSrc=/lib/pdfjs/pdf.worker.min.mjs）。
     若插件把 pdf.js 注入到全局，会覆盖它 → 标签页里的 PDF 打不开（0/0）。故改为隔离加载。 */
  async ensurePdfLib() {
    if (this._pdfLib) return this._pdfLib;
    const dir = (await this.getPluginRel()) + '/lib/';
    let mainCode = '';
    let workerCode = '';
    try { mainCode = await this.app.vault.adapter.read(dir + 'pdf.min.js'); } catch (e) { /* ignore */ }
    try { workerCode = await this.app.vault.adapter.read(dir + 'pdf.worker.min.js'); } catch (e) { /* ignore */ }
    let lib = null; let lastErr = null; let source = '';
    if (mainCode) {
      try { lib = this.evalPdfLibIsolated(mainCode, workerCode); source = 'isolated'; } catch (e) { lastErr = e; }
    } else {
      lastErr = new Error('插件 lib/pdf.min.js 读取失败（路径：' + dir + '）');
    }
    if (!lib || typeof lib.getDocument !== 'function') {
      // 兜底：只读复用 Obsidian 自身已暴露的 pdf.js（不写入、不污染全局）。
      // ⚠️ 注意：Obsidian 自带的 pdf.js 依赖它自己的 worker/workerSrc，在插件里单独复用可能不可靠，
      //    因此这里记录 source 以便诊断（重建索引失败报告会写明用的是哪一份 pdf.js）。
      const g = (typeof window !== 'undefined') ? window : globalThis;
      if (g && g.pdfjsLib && typeof g.pdfjsLib.getDocument === 'function') { lib = g.pdfjsLib; source = 'obsidian-global'; }
    }
    if (!lib || typeof lib.getDocument !== 'function') {
      throw new Error('pdf.js 未能加载' + (lastErr ? ('（' + lastErr.message + '）') : '') + '：请确认插件 lib/pdf.min.js 存在且完整');
    }
    if (source === 'obsidian-global') console.warn('[Hymns] 隔离加载 pdf.js 失败，已回退到 Obsidian 内置 pdf.js（可能不稳定）', lastErr && lastErr.message);
    this._pdfLibSource = source;
    this._pdfLib = lib;
    return lib;
  }

  /* 在隔离作用域里同时执行 pdf.worker.min.js 与 pdf.min.js：
     - 用一个 Proxy 代理的 `globalThis` 遮蔽真实全局，UMD 的赋值（pdfjsLib / pdfjsWorker）
       只落到 sandbox 上，因此不会污染 window / globalThis；
     - sandbox.pdfjsWorker 存在 ⇒ pdf.js 走“伪 worker（主线程）”，无需 workerSrc、无需真实 Worker，
       彻底避开移动端 WebView 的 Worker 兼容问题，也不会触发需联网/需 workerSrc 的加载分支。 */
  evalPdfLibIsolated(mainCode, workerCode) {
    const realGlobal = (typeof globalThis !== 'undefined') ? globalThis : window;
    const store = Object.create(null);
    const sandbox = new Proxy(store, {
      get(t, k) { return (k in t) ? t[k] : realGlobal[k]; },
      set(t, k, v) { t[k] = v; return true; },
      has(t, k) { return (k in t) || (k in realGlobal); },
      deleteProperty(t, k) { delete t[k]; return true; },
    });
    const body = (workerCode ? (workerCode + '\n;\n') : '') + mainCode + '\n;';
    // 仅遮蔽 globalThis / module / exports / define：让两段 UMD 都走 root[...] 分支并写入 sandbox
    const fn = new Function('globalThis', 'module', 'exports', 'define', body);
    fn(sandbox, undefined, undefined, undefined);
    const lib = store.pdfjsLib || store['pdfjs-dist/build/pdf'] || null;
    if (lib && lib.GlobalWorkerOptions) {
      try { lib.GlobalWorkerOptions.workerPort = null; } catch (e) { /* ignore */ }
    }
    return lib;
  }

  /* 一键重建歌词索引：插件内用 pdf.js 抽取 PDF 文本（默认仅新增/缺失；full=true 全量重抽） */
  async rebuildLyrics(full) {
    const notice = new Notice('正在准备歌词索引…', 0);
    try {
      const lib = await this.ensurePdfLib();
      const base = (!full && this.lyrics && Object.keys(this.lyrics).length) ? this.lyrics : {};
      const baseCount = Object.keys(base).length;
      const pdfRoot = normalize(this.settings.pdfFolder).toLowerCase();
      const files = this.app.vault.getFiles().filter((f) => {
        const p = normalize(f.path).toLowerCase();
        return p.endsWith('.pdf') && inFolder(p, pdfRoot);   // 留空 = 整个仓库
      });
      // 同一编号的多个版本要用各自的 uid 作为歌词键（基础版的 uid = 编号，与旧索引兼容）
      const uidOfPath = this.computeUidMap(files);
      const result = Object.assign({}, base);
      const total = files.length;
      let done = 0, skipped = 0, empty = 0, failed = 0;
      const failures = [];
      const t0 = Date.now();
      if (full) notice.setMessage('完整重建将重抽全部 ' + total + ' 首 PDF，耗时较长，请耐心等待…');
      for (const file of files) {
        const parsed = parsePdfCode(file.name);
        if (!parsed) { done++; continue; }
        const uid = uidOfPath.get(file.path) || parsed.code;
        const ex = result[uid];
        if (!full && ex && ((ex.lyrics || '').length || ex._empty)) { done++; skipped++; continue; }
        try {
          let buf = null;
          try { buf = await this.app.vault.readBinary(file.path); }
          catch (e1) { buf = await this.app.vault.adapter.readBinary(file.path); }
          const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
          const pages = [];
          for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            const rows = extractPageRows(content);
            if (rows) pages.push(cleanRowList(rows));
          }
          try { await doc.destroy(); } catch (e2) { /* ignore */ }
          const entry = assembleLyrics(pages, file.name);
          const lyrics = entry.lyrics;
          const title = entry.title;
          if (!lyrics) {
            // 抽不到文字（常见于图片型/扫描版 PDF）：不算“失败”，也不要覆盖已有歌词
            empty++;
            const old = result[uid];
            if (!old || !(old.lyrics || '').length) result[uid] = { title: (old && old.title) ? old.title : title, lyrics: '', _empty: true };
          } else {
            result[uid] = { title, lyrics, ...(entry.sections ? { sections: entry.sections } : {}) };
          }
        } catch (e) {
          failed++;
          failures.push({
            path: file.path,
            name: file.name,
            message: (e && e.message) ? e.message : String(e),
            stack: (e && e.stack) ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '',
          });
          console.error('[Hymns] 歌词抽取失败', file.path, e);
        }
        done++;
        if (done % 10 === 0 || done === total) {
          const pct = total ? Math.round(done / total * 100) : 100;
          const el = (Date.now() - t0) / 1000;
          const eta = done > 0 ? Math.max(0, Math.round(el / done * (total - done))) : 0;
          notice.setMessage('正在生成歌词索引…（' + pct + '% · 剩余约 ' + eta + 's' + (failed ? ' · 失败 ' + failed : '') + '）');
          await sleep(0);
        }
      }
      const rel = await this.getPluginRel();
      await this.app.vault.adapter.write(rel + '/lyrics.json', JSON.stringify(result));
      // 把失败详情落盘，便于排查（没有失败时也写一份空报告）
      try {
        await this.app.vault.adapter.write(rel + '/lyrics-failures.json', JSON.stringify({
          time: new Date().toISOString(),
          pdfLib: this._pdfLibSource || 'unknown',
          total: total, skipped: skipped, empty: empty, failed: failed,
          failures: failures,
        }, null, 1));
      } catch (e) { /* ignore */ }
      this.lyrics = result;
      notice.hide();
      const added = Object.keys(result).length - baseCount;
      const parts = [
        '共 ' + Object.keys(result).length + ' 首',
        (full ? ('重抽 ' + total) : ('新增/更新 ' + added)),
        '跳过已索引 ' + skipped,
        '无歌词（图片型）' + empty,
      ];
      if (failed) parts.push('失败 ' + failed + '（详情见 lyrics-failures.json）');
      const summary = (full ? '完整重建完成：' : '歌词索引已更新：') + parts.join('，');
      new Notice(summary, failed ? 9000 : 6000);
      if (failed) console.warn('[Hymns] 歌词抽取失败清单：', failures);
      if (this.view) this.view.renderListMode();
    } catch (e) {
      notice.hide();
      console.error('[Hymns] 歌词索引生成失败', e);
      new Notice('歌词索引生成失败：' + e.message);
    }
  }

  /* 为一组 PDF 文件计算「路径 → uid」映射：按编号分组后调用 assignUid，
     保证插件索引与歌词索引对“哪个文件是基础版”的判断完全一致。 */
  computeUidMap(files) {
    const map = new Map();
    const byCode = new Map();
    for (const f of files) {
      const parsed = parsePdfCode(f.name);
      if (!parsed) continue;
      if (!byCode.has(parsed.code)) byCode.set(parsed.code, []);
      byCode.get(parsed.code).push({ f, v: parseVariant(f.name) });
    }
    for (const [code, list] of byCode) {
      list.sort((a, b) => compareVariantFiles(a.v, b.v, a.f.name, b.f.name));
      const metas = assignUid(list.map((x) => ({ name: x.f.name })), code);
      list.forEach((x, i) => map.set(x.f.path, metas[i].uid));
    }
    return map;
  }

  /* ---- 文件夹辅助（供设置页“浏览 / 自动检测 / 实时校验”使用）----
     仓库里所有文件夹：由文件路径反推各级父目录，天然只含“里面有文件的目录”。 */
  allFolders() {
    const set = new Set();
    for (const f of this.app.vault.getFiles()) {
      let cur = normalize(f.path);
      for (;;) {
        const i = cur.lastIndexOf('/');
        if (i <= 0) break;
        cur = cur.slice(0, i);
        set.add(cur);
      }
    }
    return Array.from(set).sort();
  }

  /* 统计某文件夹（含全部子文件夹）里“能被识别成诗歌”的文件数量。
     root 传空串 = 统计整个仓库。 */
  scanFolderHits(root, kind) {
    const r = normalize(root).toLowerCase();
    const isMp3 = kind === 'mp3';
    const parse = isMp3 ? parseMp3Code : parsePdfCode;
    const files = this.app.vault.getFiles();
    let n = 0; const codes = new Set(); const byLetter = new Map();
    for (const f of files) {
      const p = normalize(f.path).toLowerCase();
      if (!(isMp3 ? p.endsWith('.mp3') : p.endsWith('.pdf'))) continue;
      if (!inFolder(p, r)) continue;
      const c = parse(f.name);
      if (!c) continue;
      n++; codes.add(c.code);
      byLetter.set(c.letter, (byLetter.get(c.letter) || 0) + 1);
    }
    return { files: n, codes: codes.size, byLetter };
  }

  /* 自动检测：按“含所有后代”聚合每个目录的命中数。
     推荐原则——覆盖 >=90% 命中里最深的那一层（既收得全，又尽量具体）。 */
  detectFolder(kind) {
    const isMp3 = kind === 'mp3';
    const parse = isMp3 ? parseMp3Code : parsePdfCode;
    const folders = new Set();
    const hits = [];
    for (const f of this.app.vault.getFiles()) {
      const p = normalize(f.path);
      if (!(isMp3 ? p.toLowerCase().endsWith('.mp3') : p.toLowerCase().endsWith('.pdf'))) continue;
      if (!parse(f.name)) continue;
      const lp = p.toLowerCase();
      hits.push(lp);
      let cur = p;
      for (;;) {
        const i = cur.lastIndexOf('/');
        if (i <= 0) break;
        cur = cur.slice(0, i);
        folders.add(cur);
      }
    }
    const total = hits.length;
    const counts = [];
    for (const dir of folders) {
      const pre = dir.toLowerCase() + '/';
      let c = 0;
      for (const hp of hits) if (hp.startsWith(pre)) c++;
      if (c > 0) counts.push({ path: dir, total: c });
    }
    counts.sort((a, b) => (b.total - a.total) || (a.path < b.path ? -1 : 1));
    // 推荐：覆盖率 ≥90% 里最深的一层；若没有任何目录达到 90%（诗歌分散在多处），则推荐留空（全库）
    const cands = counts.filter((c) => c.total >= Math.max(1, Math.floor(total * 0.9)));
    let best = null;
    for (const c of cands) {
      const depth = c.path.split('/').length;
      if (!best || depth > best.depth || (depth === best.depth && c.total > best.total)) {
        best = { path: c.path, total: c.total, depth };
      }
    }
    return { total, counts, best };
  }

  /* 从侧边栏/提示里一键打开本插件的设置页 */
  openPluginSettings() {
    try {
      const st = this.app.setting;
      if (!st) return;
      st.open();
      if (st.openTabById) st.openTabById(this.manifest && this.manifest.id);
    } catch (e) { /* 版本不支持时忽略 */ }
  }

  /* ---- 索引构建 ----
     同一编号下存在多个 PDF 时（不同版本 / 不同调 / 完全不同的歌共号），
     以前只保留第一个，其余被静默丢掉；现在按 variant 全部收录并给出唯一 uid。
     文件夹留空 = 不限定范围（扫描整个仓库）。 */
  async buildIndex() {
    const pdfRoot = normalize(this.settings.pdfFolder).toLowerCase();
    const mp3Root = normalize(this.settings.mp3Folder).toLowerCase();
    const groups = new Map();   // code -> [{ file, parsed, v }]
    const mp3ByCode = new Map(); // code -> [{ path, v }]

    for (const file of this.app.vault.getFiles()) {
      const p = normalize(file.path).toLowerCase();
      if (p.endsWith('.pdf') && inFolder(p, pdfRoot)) {
        const parsed = parsePdfCode(file.name);
        if (!parsed) continue;
        if (!groups.has(parsed.code)) groups.set(parsed.code, []);
        groups.get(parsed.code).push({ file, parsed, v: parseVariant(file.name) });
      } else if (p.endsWith('.mp3') && inFolder(p, mp3Root)) {
        const parsed = parseMp3Code(file.name);
        if (!parsed) continue;
        if (!mp3ByCode.has(parsed.code)) mp3ByCode.set(parsed.code, []);
        mp3ByCode.get(parsed.code).push({ path: file.path, v: parseVariant(file.name) });
      }
    }

    const hymns = [];
    const dupGroups = [];   // 存在多个版本的编号（供“未配对 MP3”报告使用）
    for (const [code, items] of groups) {
      // 组内排序：基础版 → 序号版 → 带标注版；同级再按文件名保证确定性
      items.sort((a, b) => compareVariantFiles(a.v, b.v, a.file.name, b.file.name));
      const metas = assignUid(items.map((it) => ({ name: it.file.name })), code);
      items.forEach((it, i) => {
        const m = metas[i];
        hymns.push({
          uid: m.uid, code, variant: m.variant, variantKind: m.variantKind,
          letter: it.parsed.letter, num: it.parsed.num, appendix: it.parsed.appendix,
          title: cleanVariantTitle(extractTitle(it.file.name), m.v, items.length > 1),
          pdfPath: it.file.path, mp3Path: null,
          _key: m.key,
        });
      });
      if (items.length > 1) dupGroups.push(code);
    }

    // MP3 配对：无标注 MP3 只配无标注 PDF；带标注 PDF 必须配同样标注的 MP3
    const dupCodes = new Set(dupGroups);
    const sizeOf = (code) => (groups.get(code) || []).length;
    const noMp3 = [];
    for (const h of hymns) {
      const cands = mp3ByCode.get(h.code) || [];
      // 该编号只有一份 PDF 时放宽匹配（文件名里的括号可能只是标题的一部分，如 Q109.…(B137)）；
      // 一旦有多份 PDF，就必须严格按标注/版次对齐。
      const loose = sizeOf(h.code) <= 1;
      const hit = cands.length
        ? cands.find((m) => (loose ? true : mp3MatchKey(m.v) === h._key))
        : null;
      if (hit) h.mp3Path = hit.path;
      // 只在“同一编号有多个 PDF”时记录缺失，避免把整库缺音频的情况刷满
      else if (dupCodes.has(h.code)) noMp3.push({ code: h.code, variant: h.variant, title: h.title });
      delete h._key;
    }

    hymns.sort(compareHymns);
    this.hymns = hymns;
    this.hymnByUid = new Map(hymns.map((h) => [h.uid, h]));
    // 同一编号下的全部版本（基础版排第一），用于兼容旧的“仅存编号”数据
    this.groupByCode = new Map();
    for (const h of hymns) {
      if (!this.groupByCode.has(h.code)) this.groupByCode.set(h.code, []);
      this.groupByCode.get(h.code).push(h);
    }
    this.dupGroups = dupGroups;
    this.noMp3List = noMp3;
    this._indexBuilt = true;
  }

  /* 统一解析：先按 uid 精确命中；旧数据里存的是纯编号时，
     落到该编号的基础（无标注）那一首，保证老播放列表/最近打开不会失效。 */
  resolveHymn(id) {
    if (!id) return null;
    const h = this.hymnByUid && this.hymnByUid.get(id);
    if (h) return h;
    const g = this.groupByCode && this.groupByCode.get(id);
    return (g && g.length) ? g[0] : null;
  }

  /* ---- 内置默认播放列表：仅在“用户尚无同 id 歌单”且“未被主动删除”时写入一次并持久化；
     用户若主动删除（builtin 歌单），其 id 记入 removedBuiltinIds 不再补回。 */
  ensureBuiltinPlaylists() {
    let added = false;
    for (const b of BUILTIN_PLAYLISTS) {
      if (this.removedBuiltinIds.indexOf(b.id) !== -1) continue;
      if (this.playlists.some((p) => p.builtinId === b.id)) continue;
      // 兼容早期：若已存在同名但无 builtin 标记的歌单，避免重复创建
      if (this.playlists.some((p) => !p.builtinId && p.name === b.name)) continue;
      this.playlists.push({ name: b.name, codes: b.codes.slice(), builtin: true, builtinId: b.id });
      added = true;
    }
    if (added) this.saveAll();
  }

  /* ---- 播放列表 ---- */
  /* 新建的播放列表默认排在最前面 */
  createPlaylist(name) {
    if (this.playlists.find((p) => p.name === name)) return;
    this.playlists.unshift({ name, codes: [] });
    this.saveAll();
  }
  addToPlaylist(name, code) {
    let pl = this.playlists.find((p) => p.name === name);
    if (!pl) { pl = { name, codes: [] }; this.playlists.unshift(pl); }
    if (!pl.codes.includes(code)) pl.codes.push(code);
    this.saveAll();
  }
  removeFromPlaylist(name, idx) {
    const pl = this.playlists.find((p) => p.name === name); if (!pl) return;
    pl.codes.splice(idx, 1); this.saveAll();
  }
  /* 一次性移除多个下标（indices 为原始下标数组） */
  removeManyFromPlaylist(name, indices) {
    const pl = this.playlists.find((p) => p.name === name); if (!pl) return;
    const set = new Set(indices);
    pl.codes = pl.codes.filter((_, i) => !set.has(i));
    this.saveAll();
  }
  /* 调整播放列表自身顺序（dir: -1 上移 / 1 下移） */
  movePlaylist(name, dir) {
    const i = this.playlists.findIndex((p) => p.name === name);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= this.playlists.length) return;
    const t = this.playlists[i]; this.playlists[i] = this.playlists[j]; this.playlists[j] = t;
    this.saveAll();
  }
  moveInPlaylist(name, idx, dir) {
    const pl = this.playlists.find((p) => p.name === name); if (!pl) return;
    const j = idx + dir; if (j < 0 || j >= pl.codes.length) return;
    const t = pl.codes[idx]; pl.codes[idx] = pl.codes[j]; pl.codes[j] = t; this.saveAll();
  }
  deletePlaylist(name) {
    const pl = this.playlists.find((p) => p.name === name);
    if (pl && pl.builtinId && this.removedBuiltinIds.indexOf(pl.builtinId) === -1) {
      this.removedBuiltinIds.push(pl.builtinId);
    }
    this.playlists = this.playlists.filter((p) => p.name !== name);
    this.saveAll();
  }
  playPlaylist(name) {
    const pl = this.playlists.find((p) => p.name === name);
    if (!pl || !pl.codes.length) { new Notice('播放列表为空'); return; }
    const list = pl.codes.map((c) => this.resolveHymn(c)).filter(Boolean);
    if (!list.length) { new Notice('播放列表中没有可播放的诗歌'); return; }
    if (this.view) { this.view.setCurrentList(list); this.view.activeIndex = 0; this.view.activeHymn = list[0]; this.view.playFromList(list[0]); }
    new Notice('正在播放「' + name + '」');
  }
  playCurrentSequence() {
    const codes = this.currentSequence || [];
    if (!codes.length) { new Notice('当前没有正在播放的列表'); return; }
    const list = codes.map((c) => this.resolveHymn(c)).filter(Boolean);
    if (!list.length) { new Notice('当前播放列表为空'); return; }
    if (this.view) { this.view.setCurrentList(list); this.view.activeIndex = 0; this.view.activeHymn = list[0]; this.view.playFromList(list[0]); }
    new Notice('正在播放当前列表');
  }

  /* ---- 自动更新 ---- */
  compareVersion(v1, v2) {
    const a = String(v1 || '').split('.').map(Number);
    const b = String(v2 || '').split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /* 启动流程：先展示“刚更新到的新版本说明”（若有），再检查是否有更新的版本。 */
  async onUpdateFlow() {
    let changelogShown = false;
    try { changelogShown = await this.checkAndShowChangelog(); } catch (e) { console.error('[Hymns] 更新说明失败:', e); }
    try {
      if (changelogShown) setTimeout(() => this.checkForUpdate(), 4000);
      else this.checkForUpdate();
    } catch (e) { console.error('[Hymns] 检查更新失败:', e); }
  }

  /* 版本号变化时弹出“已更新至 vX”说明（更新成功后由 performUpdate 也触发一次） */
  async checkAndShowChangelog() {
    try {
      const current = this.manifest.version;
      const last = this.settings.lastVersion || '';
      if (!last) {
        // 全新安装 / 老版本升级上来：只记录版本号，不弹窗
        this.settings.lastVersion = current;
        await this.saveSettings();
        return false;
      }
      if (this.compareVersion(current, last) <= 0) {
        if (last !== current) { this.settings.lastVersion = current; await this.saveSettings(); }
        return false;
      }
      const changelog = await this.getChangelogFor(current);
      this.settings.lastVersion = current;
      await this.saveSettings();
      new HymnsUpdateModal(this.app, this, current, changelog, { title: '🎉 Hymns 已更新至 v' + current }).open();
      return true;
    } catch (e) { console.error('[Hymns] 显示更新说明失败:', e); return false; }
  }

  /* 手动查看当前版本说明（命令 / 设置按钮） */
  async showCurrentChangelog() {
    const v = this.manifest.version;
    const changelog = await this.getChangelogFor(v);
    new HymnsUpdateModal(this.app, this, v, changelog, { title: '📜 Hymns v' + v + ' 更新说明' }).open();
  }

  /* 打开历史更新（设置按钮 / 弹窗内“查看历史更新”） */
  async showUpdateHistory() {
    new HymnsUpdateModal(this.app, this, '', '', { historyOnly: true, title: '📜 Hymns 历史更新' }).open();
  }

  /* 拉取远端 manifest，与本地比对；manual=true 时无论结果都给提示 */
  async checkForUpdate(manual = false) {
    try {
      if (!manual && !this.settings.autoCheckUpdate) return;
      const now = Date.now();
      if (!manual && now - (this.settings.lastUpdateCheckAt || 0) < 12 * 3600 * 1000) return;
      this.settings.lastUpdateCheckAt = now;
      await this.saveSettings();

      const resp = await requestUrl({ url: UPDATE_BASE + 'manifest.json', method: 'GET', timeout: 10000 });
      if (resp.status !== 200) { if (manual) new Notice('检查更新失败，无法获取版本信息'); return; }
      const remote = JSON.parse(resp.text);
      const current = this.manifest.version;
      const latest = remote.version;
      if (this.compareVersion(latest, current) > 0) {
        if (manual) {
          const changelog = await this.getChangelogFor(latest);
          new HymnsUpdateModal(this.app, this, latest, changelog, { title: 'Hymns 有可用更新 v' + latest }).open();
        } else if (this.settings.dismissedVersion !== latest) {
          this.showUpdateNotification(latest);
        }
      } else if (manual) {
        new Notice('当前已是最新版本 v' + current);
      }
    } catch (e) {
      console.error('[Hymns] 检查更新失败:', e);
      if (manual) new Notice('检查更新失败：' + e.message);
    }
  }

  /* 右下角常驻通知：立即更新 / 稍后 */
  showUpdateNotification(latestVersion) {
    const notice = new Notice('', 0);
    const frag = document.createDocumentFragment();
    const wrap = document.createElement('div');
    wrap.style.padding = '8px'; wrap.style.minWidth = '280px';
    wrap.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">📢 Hymns 有新版本</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">最新版本: v' + latestVersion + ' ｜ 当前版本: v' + this.manifest.version + '</div>';
    const btnWrap = document.createElement('div');
    btnWrap.style.display = 'flex'; btnWrap.style.gap = '8px';
    const updateBtn = document.createElement('button');
    updateBtn.className = 'mod-cta'; updateBtn.textContent = '立即更新';
    updateBtn.style.fontSize = '12px'; updateBtn.style.padding = '4px 12px';
    const laterBtn = document.createElement('button');
    laterBtn.textContent = '稍后'; laterBtn.style.fontSize = '12px'; laterBtn.style.padding = '4px 12px';
    btnWrap.appendChild(updateBtn); btnWrap.appendChild(laterBtn);
    wrap.appendChild(btnWrap); frag.appendChild(wrap); notice.setMessage(frag);

    laterBtn.addEventListener('click', () => { this.settings.dismissedVersion = latestVersion; this.saveSettings(); notice.hide(); });
    updateBtn.addEventListener('click', async () => { notice.hide(); await this.performUpdate(latestVersion); });
  }

  /* 下载并覆盖插件本体；覆盖前把旧文件备份为 .old，完成后提示重启并弹出更新说明 */
  async performUpdate(targetVersion) {
    const notice = new Notice('正在下载更新...', 0);
    const start = Date.now();
    try {
      const read = async (file) => {
        const r = await requestUrl({ url: UPDATE_BASE + file, method: 'GET' });
        if (r.status !== 200) throw new Error('下载 ' + file + ' 失败 (HTTP ' + r.status + ')');
        return r;
      };
      const mainResp = await read('main.js');
      const manifestResp = await read('manifest.json');
      const stylesResp = await read('styles.css');

      const dir = (this.manifest && this.manifest.dir) || ('.obsidian/plugins/' + (this.manifest && this.manifest.id || 'hymns'));
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      // 覆盖前先备份旧文件，出问题可把 .old 改回
      for (const f of ['main.js', 'manifest.json', 'styles.css']) {
        try {
          if (await this.app.vault.adapter.exists(dir + '/' + f)) {
            const bin = await this.app.vault.adapter.readBinary(dir + '/' + f);
            await this.app.vault.adapter.writeBinary(dir + '/' + f + '.old', bin);
          }
        } catch (e) { console.warn('[Hymns] 备份 ' + f + ' 失败:', e); }
      }
      await this.app.vault.adapter.writeBinary(dir + '/main.js', mainResp.arrayBuffer);
      await this.app.vault.adapter.writeBinary(dir + '/manifest.json', manifestResp.arrayBuffer);
      await this.app.vault.adapter.writeBinary(dir + '/styles.css', stylesResp.arrayBuffer);

      this.settings.lastVersion = targetVersion;
      this.settings.dismissedVersion = '';
      await this.saveSettings();
      notice.hide();
      new Notice('✅ Hymns 已更新至 v' + targetVersion + '，请重启 Obsidian 以应用新版本。', 10000);
      const changelog = await this.getChangelogFor(targetVersion);
      new HymnsUpdateModal(this.app, this, targetVersion, changelog, { title: '🎉 Hymns 已更新至 v' + targetVersion }).open();
    } catch (e) {
      notice.hide();
      new Notice('更新失败：' + e.message, 8000);
      console.error('[Hymns] 更新失败:', e);
    }
  }

  /* 取得指定版本说明：内置 CHANGELOG_CONTENT → 远端 CHANGELOG.md 解析 */
  async getChangelogFor(version) {
    const local = CHANGELOG_CONTENT[version];
    if (local && local.trim()) return local;
    const remote = await this.fetchRemoteChangelog(version);
    return remote || '';
  }

  async fetchRemoteChangelog(version) {
    try {
      const resp = await requestUrl({ url: UPDATE_BASE + 'CHANGELOG.md', method: 'GET', timeout: 15000 });
      if (!resp || resp.status !== 200 || !resp.text) return null;
      const lines = resp.text.split('\n');
      let start = -1;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('##') && t.indexOf(version) !== -1) { start = i; break; }
      }
      if (start === -1) return null;
      const out = [];
      for (let i = start + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('## ')) break;
        out.push(lines[i]);
      }
      return out.join('\n').trim() || null;
    } catch (e) { console.error('[Hymns] 获取远端更新日志失败:', e); return null; }
  }

  /* 取得完整历史：优先远端 CHANGELOG.md 全量解析；缺省时回退本地 */
  async fetchRemoteChangelogAll() {
    const sections = [];
    try {
      const resp = await requestUrl({ url: UPDATE_BASE + 'CHANGELOG.md', method: 'GET', timeout: 15000 });
      if (resp && resp.status === 200 && resp.text) {
        const lines = resp.text.split('\n');
        let cur = null;
        for (const raw of lines) {
          const t = raw.trim();
          const m = t.match(/^##\s*\[?v?([0-9][0-9.]*)\]?\s*[-–]?\s*(.*)$/);
          if (m) { if (cur) sections.push(cur); cur = { version: m[1], date: (m[2] || '').trim(), body: [] }; }
          else if (cur) cur.body.push(raw);
        }
        if (cur) sections.push(cur);
      }
    } catch (e) { console.error('[Hymns] 获取远端历史失败:', e); }
    if (!sections.length) {
      for (const v of Object.keys(CHANGELOG_CONTENT)) {
        sections.push({ version: v, date: '', body: (CHANGELOG_CONTENT[v] || '').split('\n') });
      }
    }
    sections.sort((a, b) => this.compareVersion(b.version, a.version));
    return sections;
  }

  /* ---- 最近 ---- */
  addRecent(code) {
    this.recent = [code, ...this.recent.filter((c) => c !== code)].slice(0, 20);
    this.saveAll();
  }

  /* ---- 打开视图 ---- */
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_HYMNS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_HYMNS, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

module.exports = HymnsPlugin;
