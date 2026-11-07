# DEPLOY.md —— 给 Codex 的部署指令：热点实时看板部署到 VPS（news.clover0805.top）

目标：把本包部署到韩国 VPS，域名 `https://news.clover0805.top`，访客打开即有内容，每 2 小时自动刷新。

## 已知环境（不要重新猜，直接用）

- VPS：韩国，约 2 核 CPU、2GB 内存；SSH 别名 `vps-korea`＝`seoul-cloud`（Tailscale `100.69.223.101`，root；公网 `43.108.17.146`）。
- VPS 上已有 Caddy（Evidence 用 Docker/GHCR，Sanford 是 Caddy 直接托管静态文件 `/opt/sanford-guide`）；**不在 VPS 上构建、不加容器**。
- 应用目录：`/opt/news-board`（与 `/opt/evidence-navigator`、`/opt/sanford-guide` 同级）。
- Node 20；端口 **3210**（部署前确认空闲；Evidence 预览占过 3100/3400/3500 一带，不要撞）。
- DNS：**唯一能改 `clover0805.top` DNS 的是 cloudflared 的 Argo 证书**（`~/.cloudflared/cert.pem`，Win＋Mac 都有）；VPS 令牌 `vps-korea-ops` 只有 R2 写＋Zone 只读，**不要用它改 DNS**。
- Windows 侧暂存路径一律用完整形式，如 `C:/Users/Clover/AppData/Local/Temp/news-board/`（不要用 `/tmp/...`，Codex 的执行壳是 PowerShell，会解析错）。

## 步骤 1：确认 DNS

1. 查 `news.clover0805.top` 是否已解析到 VPS（`nslookup news.clover0805.top` 或公网 DNS 查询）。
2. 若不存在：用 **Windows** 上的 cloudflared 证书，按 stanford 子域名先例建记录——A 记录指向 VPS 公网 `43.108.17.146`、代理开；或 CNAME 指向 `evidence.clover0805.top`、代理开。
3. 再用公网 DNS 核实生效后再继续（DNS 未生效就部署，Caddy 拿不到证书）。

## 步骤 2：传包到 VPS

1. 把本包（ZIP 解压后的内容）传到 VPS `/opt/news-board/`（经 winssh 传到 Windows 暂存 `C:/Users/Clover/AppData/Local/Temp/news-board/` 再 scp 到 VPS，或直接 scp）。
2. 确认文件齐全：`server.mjs`、`updater.mjs`、`scripts/`、`public/`、`data/board.json`（种子缓存，部署后打开即有内容）、`deploy/`。
3. **不要 `npm install`**——零依赖；**不要在 VPS 上构建**。

## 步骤 3：Caddy（先只读摸清，再加新域名）

1. 先只读查看 VPS 现有 Caddyfile，摸清 Evidence / Sanford 的转发写法。
2. 照原样给新域名复制一份（`deploy/Caddyfile.snippet`）：`news.clover0805.top` 反代 `127.0.0.1:3210`。
3. **不要动 Evidence 的任何配置**。
4. `caddy validate` 通过后再 `caddy reload`（或按 VPS 现有方式重载）。

## 步骤 4：systemd（服务 + 定时刷新）

1. 复制 `deploy/news-board.service`、`deploy/news-board-refresh.service`、`deploy/news-board-refresh.timer` 到 `/etc/systemd/system/`。
2. `systemctl daemon-reload`；`systemctl enable --now news-board.service`；`systemctl enable --now news-board-refresh.timer`。
3. 检查：`systemctl status news-board` 为 running；`systemctl list-timers news-board-refresh.timer` 能看到下次触发时间（约 2 小时后）。

## 步骤 5：自动刷新验证（重点，必须做完）

1. 手动触发一次：`systemctl start news-board-refresh.service`，等它跑完（约 10 秒）。
2. 确认三点：`data/board.json` 更新时间推进；页面「更新于」变化；服务日志里有「已更新 XX/YY」（`journalctl -u news-board-refresh.service` 或看 `/var/log`，以实际日志位置为准）。
3. **验证“到点自动跑”**：建一个临时 2 分钟 timer（指向同一个 refresh service），等它到点触发一次，确认 `data/board.json` 再次更新；验完删掉临时 timer，恢复 2 小时 timer。
4. 只有手动触发和定时触发都确认有效，才算自动刷新机制生效。

## 步骤 6：验收（缺一不可）

1. 公网打开 `https://news.clover0805.top`：冷开即有内容（种子缓存），无白屏、无转圈等加载。
2. 点「立即刷新」：按钮左边出现「已更新 XX/YY」（如 `已更新 24/24`），不是展开的平台名单。
3. 等一个 2 小时周期（或手动触发后），页面「更新于」时间推进。
4. 真浏览器打开核对：总榜前 20 没有娱乐、体育类条目；分类榜（政治/经济/科技）与平台榜俱在；点标题跳原文。
5. 确认页面没有向 Google Fonts 或任何外部字体/样式资源发请求（国内网络下外部字体会阻塞渲染致白屏；本包前端已是零外部资源，部署时不要引入）。
6. 确认手机上打开正常（无横向溢出）。

## 回滚

- 停服务：`systemctl stop news-board.service news-board-refresh.timer`。
- 恢复旧 Caddy 配置并 reload。
- 删 `/opt/news-board`（删前备份 `data/board.json`，那是当时最新的缓存）。

## 禁止事项

- 不改任何 DNS（除非步骤 1 里明确需要建 `news.clover0805.top` 记录，且只能用 Windows 上的 cloudflared 证书）。
- 不动 Evidence、Sanford 的任何配置与文件。
- 不在 VPS 上 `npm install` 或构建；不往包里加任何密钥。
