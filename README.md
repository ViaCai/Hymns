# Hymns（诗歌）Obsidian 插件

诗歌浏览、搜索、播放与收藏插件：按编号（如 `D116`）或关键词（空格分隔，如 `恩典 耶稣`）实时搜索，预览 PDF，播放 MP3，收藏与播放列表。桌面端与移动端通用。

注意：插件本体只有几KB，本插件还需要去QQ群1128049033中下载诗歌PDF（500MB）和MP3（3.79 GB），下载好请解压到你的obsidian里你自己的仓库任意位置。每次启动时，插件会自动扫描仓库，创建诗歌索引和歌词索引。

## 功能

- **实时搜索**：按编号或关键词即时过滤，分组展示（大本诗歌 / 补充诗歌 / 儿童诗歌 / 青年诗歌 / 行政区 / 特会诗歌 / 其他）。
- **PDF 预览**：侧边栏（或主视图）查看诗歌 PDF，支持翻页、缩放、全屏。
- **MP3 播放**：一键播放诗歌音频，支持顺序 / 单曲循环 / 列表循环；可切换音频来源。
- **收藏与播放列表**：收藏诗歌；内置 7 个主题歌单（倪柝声 / 李常受 / 余洁麟 / 和受恩 / 霍华德 / 以撒·华滋 / 约翰·牛顿），也可自建歌单。删除均二次确认，支持多选 / 全选批量删除与列表排序。
- **歌词索引**：随插件附带 `lyrics.json`（由“重建歌词索引”生成，不纳入版本库），可在列表与查看器中复制歌词。
- **自动检测更新**：启动时（默认 12 小时节流一次）比对云端版本，发现新版本弹通知，更新后展示更新说明并可查看历史。

## 安装

### 方式一：手动安装（GitHub）

1. 下载本仓库 `main.js` / `styles.css` / `manifest.json` 三个文件。
2. 在 Obsidian 库里新建文件夹 `.obsidian/plugins/hymns/`，把三个文件放进去。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 Hymns。
4. 首次使用在插件设置里指定 PDF 文件夹与 MP3 文件夹（留空 = 扫描整个仓库）。

> 歌词索引 `lyrics.json` 不随仓库分发，请到插件设置点「重建歌词索引」生成本地副本（首次约需数分钟）。

### 方式二：BRAT

在 BRAT 中添加本仓库 `ViaCai/Hymns` 即可。

## 设置

- **PDF 文件夹 / MP3 文件夹**：留空 = 扫描整个仓库。诗歌靠文件名编号识别（如 `D116`、`E836（补充版）`）。
- **联动**：在底部播放栏「联动」里勾选 MP3 随 PDF 切换 / PDF 随 MP3 切换。
- **重建索引 / 歌词索引**：改了文件夹或新增诗歌后重建。
- **更新**：自动检查更新开关、立即检查更新、查看当前版本说明、查看历史更新。

## 发布（提交 Obsidian 官方插件市场）

本仓库采用「打 tag 自动出 Release」的流程，无需手动在 GitHub 建 Release。

1. 在 `CHANGELOG.md` 顶部写好新版本的更新内容（按 `## [x.y.z] - 日期` 格式）。
2. 运行一键发版脚本（会自动改 `manifest.json` / `versions.json`、提交、打 tag、推送）：
   ```bash
   node scripts/release.mjs 1.0.1
   ```
   > 首次发布当前 1.0.0 时，直接打 tag 即可：
   > ```bash
   > git tag 1.0.0 && git push origin 1.0.0
   > ```
3. GitHub Actions 会自动创建 Release，并附上 `main.js` / `styles.css` / `manifest.json`。
4. 到 [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) 提 PR，在 `community-plugins.json` 加入：
   ```json
   { "id": "hymns", "name": "Hymns", "author": "ViaCai", "repo": "ViaCai/Hymns" }
   ```

插件自身的**自动检测更新**读取的是 `main` 分支的原始文件，与官方市场的 Release 分发互不冲突，二者可同时生效。

## 目录结构

```
hymns/
├── main.js          # 插件主体
├── styles.css       # 样式
├── manifest.json    # 插件元信息
├── lib/             # 依赖库（如 PDF.js）
├── versions.json    # 各版本最低 Obsidian 版本
├── CHANGELOG.md     # 更新日志
└── README.md
```

---

## English

### Hymns — an Obsidian hymnal plugin

Browse, search, play and bookmark hymns: instant search by number (e.g. `D116`) or keywords, PDF preview, MP3 playback, favourites and playlists. Works on desktop and mobile.

### Installation

Manual installation:

1. Download `main.js`, `styles.css` and `manifest.json` from the [latest release](https://github.com/ViaCai/Hymns/releases/latest).
2. Create the folder `<your-vault>/.obsidian/plugins/hymns/`.
3. Put the three files into that folder.
4. Reload Obsidian, then enable **Hymns** in *Settings → Community plugins*.

Via BRAT: add `ViaCai/Hymns` in the BRAT plugin and let it install the latest release.

### Usage

1. Put your hymn PDF/MP3 files anywhere inside your vault. The folder names are configurable in the plugin settings — leave them empty to scan the whole vault.
2. Hymn numbers are detected from file names, e.g. `D116 <title>.pdf` or `D116-<title>.mp3`.
3. On every startup the plugin scans the vault and builds the hymn index and the lyrics index automatically.
4. Open the Hymns view from the ribbon, then search, preview the PDF and play the MP3.

### Settings

- **PDF folder / MP3 folder** — leave empty to scan the whole vault.
- **Link PDF and MP3** — follow the current hymn in both viewers.
- **Rebuild index / Rebuild lyrics index** — rebuild after adding or moving files.
- **Updates** — toggle the automatic update check, check for updates now, view the current changelog and the update history.

### Notes on plugin behavior

- **Vault enumeration** — the plugin lists the files in your vault in order to locate hymn PDF/MP3 files. This is required so that you do not have to configure each file manually.
- **Clipboard access** — used only when you click on "Copy lyrics".
- **Dynamic code execution** — the bundled PDF.js library is evaluated with `new Function` inside an isolated sandbox object (`evalPdfLibIsolated`). This keeps the library out of the global scope and allows PDF rendering to work on mobile without a Web Worker.

### License

MIT

---

## 许可证

MIT License（见 [LICENSE](LICENSE)）

## ☕ 如果觉得这款插件对您有帮助，也可以支持我的项目

加6:10 所以我们有了时机，就当向众人行善，尤其是向信仰之家的人。

<img src="https://raw.githubusercontent.com/ViaCai/bitiful-helper/main/images/wechat-pay.png" alt="微信收款码" width="240" />

