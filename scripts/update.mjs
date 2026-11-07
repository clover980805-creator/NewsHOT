// scripts/update.mjs —— 定时刷新入口（systemd timer / cron 调用）
// 跑一轮 updater，成功则原子写 data/board.json；全部平台失败时保留旧缓存并以 exit 1 告警。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, updateBoard, writeBoardAtomic } from '../updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'board.json');

const oldBoard = await readBoard(DATA_FILE);
const { board, summary } = await updateBoard(oldBoard);
const stamp = new Date().toISOString();
if (summary.updated > 0) {
  await writeBoardAtomic(board, DATA_FILE);
  console.log(`[${stamp}] ${summary.message}，共 ${board.totalItems} 条`);
} else {
  console.log(`[${stamp}] ${summary.message}`);
}
for (const f of summary.failures) console.log(`  失败：${f.name}（${f.id}）：${f.reason}`);
process.exit(summary.updated > 0 ? 0 : 1);
