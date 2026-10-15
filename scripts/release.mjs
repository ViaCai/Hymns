#!/usr/bin/env node
/**
 * Hymns 一键发版脚本
 * 用法: node scripts/release.mjs <版本号>   例: node scripts/release.mjs 1.0.1
 *
 * 做的事:
 *   1. 把 manifest.json 的 version 改成新版本（保留 minAppVersion）
 *   2. 在 versions.json 追加 新版本 -> minAppVersion（按版本号降序）
 *   3. git add + commit "Release x.y.z"
 *   4. git tag x.y.z
 *   5. 推送 main 与 tag
 * 之后 GitHub Actions 会自动创建 Release 并附上 main.js / styles.css / manifest.json。
 *
 * 注意: 打 tag 前请先手动在 CHANGELOG.md 写好该版本的更新内容。
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/release.mjs <版本号, 如 1.0.1>');
  process.exit(1);
}

function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i]; }
  return 0;
}
function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

// 1. manifest.json
const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const minApp = manifest.minAppVersion;
if (manifest.version === version) {
  console.log('manifest.json 已是 ' + version + '，跳过版本号修改');
} else {
  manifest.version = version;
  writeJson(manifestPath, manifest);
  console.log('manifest.json -> version ' + version);
}

// 2. versions.json
const versionsPath = join(root, 'versions.json');
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
versions[version] = minApp;
const sorted = {};
for (const k of Object.keys(versions).sort(cmp)) sorted[k] = versions[k];
writeJson(versionsPath, sorted);
console.log('versions.json -> 追加 ' + version + ' -> ' + minApp);

// 3. git 提交 + 打 tag + 推送
try {
  execSync('git add manifest.json versions.json', { cwd: root, stdio: 'inherit' });
  execSync('git commit -m "Release ' + version + '"', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('提交失败（可能无改动被提交，可忽略）:', e.message);
}
execSync('git tag ' + version, { cwd: root, stdio: 'inherit' });
execSync('git push origin main', { cwd: root, stdio: 'inherit' });
execSync('git push origin ' + version, { cwd: root, stdio: 'inherit' });

console.log('\n✅ 已推送 ' + version + '（main + tag）。GitHub Actions 会自动创建 Release。');
console.log('   如需提交 Obsidian 官方市场，再向 obsidianmd/obsidian-releases 提 PR，');
console.log('   在 community-plugins.json 加入:');
console.log('   { "id": "hymns", "name": "Hymns", "author": "ViaCai", "repo": "ViaCai/Hymns" }');
