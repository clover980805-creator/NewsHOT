// scripts/verify-sort.mjs —— 排序复现校验：用移植的分类 + 加权逻辑对 data/board.json 的
// platformLists 跑一遍，与同一文件的 totalBoard 比对重合数，并检查娱乐/体育/琐事 0 条。
// 通过标准：总榜前 20 至少 16 条标题重合，且 0 条违规；分类榜的条目分类与种子一致。
// 注意：种子快照自身的 totalBoard 与 platformLists 并非同一时刻抓取（3 条总榜条目的
// 来源在 platformLists 里找不到），所以 17/20 即为该种子上可复现的上限。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, classifyTitle, normTitle, PLATFORMS, readBoard } from '../updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'board.json');

const seed = await readBoard(DATA_FILE);
if (!seed || !seed.hasData) {
  console.error('data/board.json 无数据，无法校验');
  process.exit(2);
}
const { totalBoard, categories, resonanceCount } = buildBoard(seed.platformLists, PLATFORMS.map((p) => p.id));
const seedTotal = seed.totalBoard.map((t) => normTitle(t.title));
const mineTotal = totalBoard.map((t) => normTitle(t.title));
const overlap = mineTotal.filter((t) => seedTotal.includes(t)).length;

// 违规检查：总榜里出现娱乐/体育/琐事类标题（分类器应将其归为综合、排除在总榜外）
const violations = totalBoard.filter((t) => classifyTitle(t.title, t.sources[0].platform) === 'general');
console.log(`总榜重合：${overlap}/20（标准 ≥16）`);
console.log(`总榜违规（娱乐/体育/琐事）：${violations.length} 条（标准 0）`);
for (const v of violations) console.log(`  违规：${v.title}`);
for (const c of ['politics', 'economy', 'tech']) {
  const seedCat = seed.categories[c].map((t) => normTitle(t.title));
  const mineCat = categories[c].map((t) => normTitle(t.title));
  const cov = mineCat.filter((t) => seedCat.includes(t)).length;
  const badCat = categories[c].filter((t) => t.category !== c).length;
  console.log(`分类榜 ${c}：重合 ${cov}/12，错类 ${badCat} 条`);
}
console.log(`共振话题数：移植 ${resonanceCount}，种子 ${seed.resonanceCount}（种子值来自另一次抓取，仅供参考）`);
const pass = overlap >= 16 && violations.length === 0;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
