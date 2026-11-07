# 🔥 NewsHOT · 极简全网热点实时聚合看板

> **告别噪音与娱乐八卦，专注硬核资讯。**
> 零依赖、纯原生轻量架构，毫秒级冷启动，打通国内主流平台 + 科技/财经垂直资讯源的全网热点实时看板。

🌐 **线上演示站点**：[https://news.clover0805.top](https://news.clover0805.top)

---

## ⚡ 为什么做 NewsHOT？

在当下碎片化的信息洪流中，各大平台的热搜榜单充斥着娱乐绯闻、明星炒作、低质吃瓜与算法诱导内容。**我们每天获取重要信息的信噪比极低。**

NewsHOT 为解决这一痛点而生：
- **硬核智能过滤**：全自动文本分类模型与关键词清洗规则，**坚决过滤娱乐、体育、八卦、鸡毛蒜皮琐事**。
- **价值信息加权**：聚合算法为**政治、经济、科技、医药、民生**赋予高权重，并跨平台检测「共振热点」（多平台同时冲榜的高关注度真实事件）。
- **极度轻量克制**：
  - **零第三方依赖（0 npm packages）**：全工程仅使用 Node.js 现代内置模块（原生 ESM + fetch + http）。无需 `npm install`，无需折腾各种构建工具。
  - **零外部资源请求**：前端无 Google Fonts、无外链 CDN、无第三方 Tracking，纯本地系统字体栈与响应式 CSS，国内弱网环境秒开绝不白屏。
  - **毫秒级离线冷启动**：服务端原子写入持久化快照，访客端 LocalStorage + Service/Cache 两级缓存，打开即阅读，后台静默增量刷新。
  - **移动端全面适配**：流式排版、无水平横溢、大触控区、阅读舒适。

---

## 📊 聚合数据源（24 个权威与垂直平台）

系统实时聚合覆盖综合平台、科技极客、金融财经与官媒快讯等多层次维度：

| 分类 | 平台列表 |
|---|---|
| **综合门户 / 社交热搜** | 今日头条、百度热搜、微博热搜、抖音、快手、知乎、哔哩哔哩、腾讯新闻、网易新闻、搜狐新闻、新浪热搜 |
| **科技 / 开发者资讯** | 36氪、IT之家、虎嗅、果壳、稀土掘金、Asahi Linux 进展、Hacker News、AI 快讯、IT 资讯 |
| **财经 / 产业经济** | 东方财富 7×24 实时快讯、澎湃新闻、澎湃财经等 |

---

## 🛠️ 技术架构

NewsHOT 坚持以最纯粹的系统工程换取极高的稳健性与极低资源消耗（可在 1 核 512MB 的低配 VPS 上常年稳定运行）：

```text
[24 个数据源 API 抓取]
        │
        ▼ (超时熔断 + 兜底三环链 + 容灾缓存)
[智能分类与共振加权算法 (updater.mjs)]
        │
        ▼ (原子写入 /data/board.json)
[原生 Node.js HTTP 静态/API 服务 (server.mjs: 3210)]
        │
        ▲ (反向代理 + 自动 HTTPS + Gzip/Zstd)
[Caddy Ingress]
        │
        ▼
[客户端：米色报刊风极简 UI (原生 HTML/CSS/JS 秒开)]
```

---

## 🚀 极速上手与本地开发

### 运行环境
- Node.js >= 20.0.0

### 本地启动
```bash
# 克隆代码
git clone https://github.com/clover980805-creator/NewsHOT.git
cd NewsHOT

# 检查代码语法
node --check server.mjs updater.mjs scripts/update.mjs scripts/verify-sort.mjs

# 验证当前快照排序与分类逻辑
node scripts/verify-sort.mjs

# 启动本地服务（默认端口 3210）
node server.mjs
# 访问 http://127.0.0.1:3210
```

---

## 🚢 生产部署推荐（systemd + Caddy）

项目自带完备的生产级服务配置模板，位于 `deploy/` 目录：

1. **守护进程**：`deploy/news-board.service`（开机自启与异常自愈）
2. **定时拉取刷新**：`deploy/news-board-refresh.timer` 与 `deploy/news-board-refresh.service`（每 2 小时自动抓取各平台最新热点更新缓存）
3. **Web 反向代理**：`deploy/Caddyfile.snippet`（一键集成 Caddy 自动申请 TLS 证书与开启 HTTP/2、HTTP/3 及 Brotli/Zstd 压缩）

详细部署指南请参阅 [DEPLOY.md](./DEPLOY.md)。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 协议开源，欢迎自由派生、自建看板与贡献 PR。
