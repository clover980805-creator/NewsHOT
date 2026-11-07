// server.mjs —— 热点实时看板 Web 服务（零第三方依赖，仅 Node 内置模块）
//   GET  /api/board    读 data/board.json 原样返回（文件不存在或损坏时返回 {hasData:false}，不 500）
//   POST /api/refresh  跑 updater（进程内锁，重复调用直接返回“正在刷新”）
//   GET  /healthz      存活探针 {"ok":true}
//   静态文件 public/（首页 index.html + app.js + styles.css）
// 端口默认 127.0.0.1:3210，可用 PORT / HOST 环境变量改。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, updateBoard, writeBoardAtomic } from './updater.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ROOT, 'data', 'board.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let refreshing = false;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleRefresh(req, res) {
  if (refreshing) {
    sendJson(res, 200, { ok: false, message: '正在刷新，请稍候' });
    return;
  }
  refreshing = true;
  try {
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
    if (summary.updated === 0) {
      sendJson(res, 200, { ok: false, message: '刷新失败，仍显示上一次缓存' });
    } else {
      sendJson(res, 200, { ok: true, updated: summary.updated, total: summary.total, message: summary.message });
    }
  } catch (e) {
    console.error('[refresh] 异常：', e);
    sendJson(res, 200, { ok: false, message: '刷新失败，仍显示上一次缓存' });
  } finally {
    refreshing = false;
  }
}

async function handleStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/board') {
      const board = await readBoard(DATA_FILE);
      sendJson(res, 200, board || { hasData: false });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      await handleRefresh(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET') {
      await handleStatic(req, res, url.pathname);
      return;
    }
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    console.error('[server] 异常：', e);
    sendJson(res, 500, { ok: false, message: '服务异常' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`news-board listening on http://${HOST}:${PORT}`);
});
