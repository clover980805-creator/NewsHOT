// updater.mjs —— 热点实时看板：上游聚合、分类加权、榜单构建
// 零第三方依赖，仅 Node 内置模块（fetch / fs / crypto）。
// 数据源全部是公开免费、无需 key 的接口；本文件不含任何密钥。
//
// 上游（2026-11-07 逐个联网验证通过）：
//   60s 主站    https://60s.viki.moe/v2/...（toutiao/weibo/zhihu/douyin/rednote/baidu/hot/ai-news/it-news/hacker-news/top）
//   60s 镜像    https://60s-api.viki.moe/v2/...（与主站同版本同接口，AI 快讯首选镜像）
//   uapis       https://uapis.cn/api/v1/misc/hotboard?type=...（澎湃/B站/新浪/腾讯/网易/36氪/虎嗅/IT之家/爱范儿/少数派/果壳/知乎日报/快手，及 60s 的兜底）
//   xxapi v2    https://v2.xxapi.cn/api/weibohot|baiduhot|douyinhot|bilibilihot（兜底第三环；其余 xxapi 端点需密钥，不用）
//   东方财富    https://np-weblist.eastmoney.com/comm/web/getFastNewsList（7x24 快讯，fastColumn=102 重要快讯）
// 已下线不用：api-hot（DNS 失败）、vvhan、tenapi；xxapi 旧域名 xxapi.cn/api/* 已 404，改走 v2.xxapi.cn。
// 兜底链：每平台按 60s 主站 → uapis → xxapi 顺序试（东方财富、Hacker News 直连，不走这条链；
//   AI 快讯走 60s 镜像 → 60s 主站）。单个请求超时 8 秒，整条链总时限 20 秒；
//   超时/失败的平台本轮保留旧缓存、计入失败名单，不阻塞其他平台、不清空榜单。

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;   // 单个请求超时
const CHAIN_DEADLINE_MS = 20000;   // 单平台整条兜底链总时限
const FETCH_CONCURRENCY = 6;       // 平台并行抓取数
const HEAT_SCALE = 100;            // 热度按 0-100 计：每源满分 100，按榜单长度归一化后求和；热度是主项
const RESONANCE_BONUS = 1;         // 共振加权：每多一个平台 +1

const S60 = 'https://60s.viki.moe';
const S60M = 'https://60s-api.viki.moe';
const UAPIS = 'https://uapis.cn/api/v1/misc/hotboard?type=';
const XXAPI = 'https://v2.xxapi.cn/api/';
const EASTMONEY_URL = () =>
  'https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=30&req_trace=' + randomUUID();

// ---------- 小工具 ----------

// 1234567 -> "123.5万"；<10000 直接返回数字字符串（Hacker News 的 score 直接用原值）
function formatWan(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(Math.round(v));
}

// 归一化标题：去空白与标点，用于跨平台去重（与种子快照同一口径）
export function normTitle(t) {
  return String(t).replace(/\s+/g, '').replace(/[，。、；：？！·…—\-_《》「」『』（）()【】\[\]"'‘’“”!?,.→|｜\/\\~～]+/g, '');
}

// ---------- 上游解析：统一成 {rank, title, url, hotLabel} ----------

function asItems(arr, mapFn) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const it = mapFn(arr[i], i);
    if (it && it.title && typeof it.url === 'string' && /^https?:\/\//.test(it.url)) out.push(it);
  }
  return out;
}

// 60s 通用热榜：{title, link, hot_value}
function parse60sHot(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({ rank: i + 1, title: String(x.title || '').trim(), url: x.link || '', hotLabel: formatWan(x.hot_value) }));
}

// 60s 知乎：{title, link, hot_value_desc: "1059 万热度"}
function parse60sZhihu(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({
    rank: i + 1,
    title: String(x.title || '').trim(),
    url: x.link || '',
    hotLabel: typeof x.hot_value_desc === 'string' ? (x.hot_value_desc.replace(/热度/g, '').trim() || null) : null,
  }));
}

// 60s 小红书：{rank, title, link, score: "947.5w"}
function parse60sRednote(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({
    rank: i + 1,
    title: String(x.title || '').trim(),
    url: x.link || '',
    hotLabel: x.score != null ? String(x.score).replace(/w$/, '万') : null,
  }));
}

// 60s 百度：{rank, title, url, score_desc: "780.97w"}
function parse60sBaidu(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({
    rank: i + 1,
    title: String(x.title || '').trim(),
    url: x.url || '',
    hotLabel: x.score_desc != null ? String(x.score_desc).replace(/w$/, '万') : null,
  }));
}

// 60s AI 快讯：{data: {news: [{title, link}]}}
function parse60sAiNews(json) {
  if (!json || json.code !== 200 || !json.data || !Array.isArray(json.data.news)) return null;
  return asItems(json.data.news, (x, i) => ({ rank: i + 1, title: String(x.title || '').trim(), url: x.link || '', hotLabel: null }));
}

// 60s IT 资讯：{title, link}（无热度）
function parse60sItNews(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({ rank: i + 1, title: String(x.title || '').trim(), url: x.link || '', hotLabel: null }));
}

// 60s Hacker News：{title, link, score}（hotLabel 就是点数，如 "51"）
function parse60sHn(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({ rank: i + 1, title: String(x.title || '').trim(), url: x.link || '', hotLabel: x.score != null ? String(x.score) : null }));
}

// uapis 热度文字："" / "0" -> null；"1833241播放" -> "183.3万播放"；其余原样（"342万"、"收藏:1 评论:0"）
function uapisHot(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '0') return null;
  const m = s.match(/^([\d.]+)播放$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 10000) return (n / 10000).toFixed(1) + '万播放';
    return s;
  }
  return s;
}

// uapis：{list: [{index, title, url, hot_value}]}
function parseUapis(json) {
  if (!json || !Array.isArray(json.list)) return null;
  return asItems(json.list, (x, i) => ({
    rank: Number(x.index) > 0 ? Number(x.index) : i + 1,
    title: String(x.title || '').trim(),
    url: x.url || '',
    hotLabel: uapisHot(x.hot_value),
  }));
}

// xxapi 微博：{data: [{title, hot, url}]}（url 里的中文查询词需转义，与种子一致）
function parseXxWeibo(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => {
    const title = String(x.title || '').trim();
    return { rank: i + 1, title, url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(title), hotLabel: x.hot ? String(x.hot) : null };
  });
}

// xxapi 百度：{data: [{title, hot, url}]}
function parseXxBaidu(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => ({ rank: i + 1, title: String(x.title || '').trim(), url: x.url || '', hotLabel: x.hot ? String(x.hot) : null }));
}

// xxapi 抖音：{data: [{word, hot_value, position}]}（抖音官方原始结构）
function parseXxDouyin(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => {
    const word = String(x.word || '').trim();
    return { rank: Number(x.position) > 0 ? Number(x.position) : i + 1, title: word, url: 'https://www.douyin.com/search/' + encodeURIComponent(word), hotLabel: formatWan(x.hot_value) };
  });
}

// xxapi B站：{data: [标题字符串]}（只有标题，无链接与热度；链接拼 B 站搜索页）
function parseXxBilibili(json) {
  if (!json || json.code !== 200 || !Array.isArray(json.data)) return null;
  return asItems(json.data, (x, i) => {
    const title = typeof x === 'string' ? x.trim() : String((x && x.title) || '').trim();
    const url = x && typeof x === 'object' && x.url ? x.url : 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(title);
    return { rank: i + 1, title, url, hotLabel: null };
  });
}

// 东方财富 7x24：{data: {fastNewsList: [{title, code}]}}，文章链接为 finance.eastmoney.com/a/<code>.html
function parseEastmoney(json) {
  if (!json || (json.code !== 1 && json.code !== '1') || !json.data || !Array.isArray(json.data.fastNewsList)) return null;
  return asItems(json.data.fastNewsList, (x, i) => {
    const code = String(x.code || '').trim();
    if (!/^\d+$/.test(code)) return null;
    return { rank: i + 1, title: String(x.title || '').trim(), url: 'https://finance.eastmoney.com/a/' + code + '.html', hotLabel: null };
  });
}

// ---------- 平台表（24 个，全部新闻向；cap 为每平台保留条数，与种子快照一致） ----------
// source 字段写的是该平台在种子快照里实际走的上游；抓取时以链路实际成功的一环为准。

export const PLATFORMS = [
  { id: 'toutiao', name: '今日头条', cap: 50, chain: [
    { via: '60s 主站', url: S60 + '/v2/toutiao', parse: parse60sHot },
    { via: 'uapis', url: UAPIS + 'toutiao', parse: parseUapis },
  ] },
  { id: 'weibo', name: '微博热搜', cap: 50, chain: [
    { via: '60s 主站', url: S60 + '/v2/weibo', parse: parse60sHot },
    { via: 'uapis', url: UAPIS + 'weibo', parse: parseUapis },
    { via: 'xxapi', url: XXAPI + 'weibohot', parse: parseXxWeibo },
  ] },
  { id: 'thepaper', name: '澎湃新闻', cap: 20, chain: [
    { via: 'uapis', url: UAPIS + 'thepaper', parse: parseUapis },
  ] },
  { id: 'baidu', name: '百度热搜', cap: 50, chain: [
    { via: '60s 主站', url: S60 + '/v2/baidu/hot', parse: parse60sBaidu },
    { via: 'uapis', url: UAPIS + 'baidu', parse: parseUapis },
    { via: 'xxapi', url: XXAPI + 'baiduhot', parse: parseXxBaidu },
  ] },
  { id: 'zhihu', name: '知乎热榜', cap: 29, chain: [
    { via: '60s 主站', url: S60 + '/v2/zhihu', parse: parse60sZhihu },
    { via: 'uapis', url: UAPIS + 'zhihu', parse: parseUapis },
  ] },
  { id: 'douyin', name: '抖音热点', cap: 50, chain: [
    { via: '60s 主站', url: S60 + '/v2/douyin', parse: parse60sHot },
    { via: 'uapis', url: UAPIS + 'douyin', parse: parseUapis },
    { via: 'xxapi', url: XXAPI + 'douyinhot', parse: parseXxDouyin },
  ] },
  { id: 'bilibili', name: 'B站热搜', cap: 50, chain: [
    { via: 'uapis', url: UAPIS + 'bilibili', parse: parseUapis },
    { via: 'xxapi', url: XXAPI + 'bilibilihot', parse: parseXxBilibili },
  ] },
  { id: 'sina', name: '新浪热搜', cap: 45, chain: [
    { via: 'uapis', url: UAPIS + 'sina', parse: parseUapis },
  ] },
  { id: 'sinanews', name: '新浪新闻', cap: 45, chain: [
    { via: 'uapis', url: UAPIS + 'sina-news', parse: parseUapis },
  ] },
  { id: 'qqnews', name: '腾讯新闻', cap: 50, chain: [
    { via: 'uapis', url: UAPIS + 'qq-news', parse: parseUapis },
  ] },
  { id: 'netease', name: '网易新闻', cap: 50, chain: [
    { via: 'uapis', url: UAPIS + 'netease-news', parse: parseUapis },
  ] },
  { id: 'eastmoney', name: '东方财富快讯', cap: 30, chain: [
    { via: '东方财富直连', url: EASTMONEY_URL, parse: parseEastmoney, headers: { Referer: 'https://kuaixun.eastmoney.com/' } },
  ] },
  { id: 'kr36', name: '36氪', cap: 30, chain: [
    { via: 'uapis', url: UAPIS + '36kr', parse: parseUapis },
  ] },
  { id: 'huxiu', name: '虎嗅', cap: 22, chain: [
    { via: 'uapis', url: UAPIS + 'huxiu', parse: parseUapis },
  ] },
  { id: 'ithome', name: 'IT之家', cap: 12, chain: [
    { via: 'uapis', url: UAPIS + 'ithome', parse: parseUapis },
  ] },
  { id: 'ifanr', name: '爱范儿', cap: 20, chain: [
    { via: 'uapis', url: UAPIS + 'ifanr', parse: parseUapis },
  ] },
  { id: 'sspai', name: '少数派', cap: 10, chain: [
    { via: 'uapis', url: UAPIS + 'sspai', parse: parseUapis },
  ] },
  { id: 'guokr', name: '果壳', cap: 20, chain: [
    { via: 'uapis', url: UAPIS + 'guokr', parse: parseUapis },
  ] },
  { id: 'zhihudaily', name: '知乎日报', cap: 30, chain: [
    { via: 'uapis', url: UAPIS + 'zhihu-daily', parse: parseUapis },
  ] },
  { id: 'rednote', name: '小红书', cap: 20, chain: [
    { via: '60s 主站', url: S60 + '/v2/rednote', parse: parse60sRednote },
    { via: 'uapis', url: UAPIS + 'xiaohongshu', parse: parseUapis },
  ] },
  { id: 'kuaishou', name: '快手', cap: 50, chain: [
    { via: 'uapis', url: UAPIS + 'kuaishou', parse: parseUapis },
  ] },
  { id: 'hackernews', name: 'Hacker News', cap: 10, chain: [
    { via: '60s 主站', url: S60 + '/v2/hacker-news/top', parse: parse60sHn },
    { via: '60s 镜像', url: S60M + '/v2/hacker-news/top', parse: parse60sHn },
  ] },
  { id: 'ainews', name: 'AI快讯', cap: 4, chain: [
    { via: '60s 镜像', url: S60M + '/v2/ai-news', parse: parse60sAiNews },
    { via: '60s 主站', url: S60 + '/v2/ai-news', parse: parse60sAiNews },
  ] },
  { id: 'itnews', name: 'IT资讯', cap: 20, chain: [
    { via: '60s 主站', url: S60 + '/v2/it-news', parse: parse60sItNews },
    { via: '60s 镜像', url: S60M + '/v2/it-news', parse: parse60sItNews },
  ] },
];
const PRE_BAD = ["世界杯", "奥运会", "亚运会", "全运会", "冬奥会", "NBA", "CBA", "英超", "西甲", "中超", "联赛", "决赛", "半决赛", "季后赛", "常规赛", "锦标赛", "邀请赛", "冠军", "夺冠", "亚军", "季军", "金牌", "银牌", "铜牌", "奖牌", "比分", "进球", "点球", "红牌", "助攻", "篮板", "扣篮", "盖帽", "三分球", "球员", "教练", "门将", "前锋", "后卫", "选手", "赛后", "电竞", "英雄联盟", "王者荣耀", "全球总决赛", "乒乓", "羽毛球", "网球", "跳水", "体操", "马拉松", "比赛", "转会", "湖人", "勇士", "凯尔特人", "尼克斯", "快船", "掘金", "雄鹿", "76人", "灰熊", "热火", "独行侠", "国足", "男足", "女足", "男篮", "女篮", "国乒", "连胜", "客场", "主场", "S16", "S赛", "单曲", "新歌", "专辑", "巡演", "演唱会", "明星", "偶像", "粉丝", "应援", "塌房", "脱粉", "绯闻", "出轨", "八卦", "综艺", "真人秀", "热播", "票房", "上映", "首映", "红毯", "影帝", "影后", "电视剧", "偶像剧", "古装剧", "网剧", "动漫", "番剧", "好莱坞", "电影", "电影院", "手游", "端游", "MV", "拍照姿势", "吃什么", "怎么吃", "食谱", "菜谱", "星座", "运势", "塔罗", "占卜", "穿搭", "萌宠", "铲屎官", "夺金", "卫冕", "绝杀", "帽子戏法", "德比", "欧冠", "欧联", "亚冠", "全明星", "选秀", "带货", "主播", "网红", "分手", "求婚", "订婚"];
const POLITICS = ["习近平", "特朗普", "普京", "泽连斯基", "总统", "总理", "国防部", "外交部", "外交", "会谈", "会晤", "峰会", "议会", "国会", "两院", "民主党", "共和党", "共产党", "罢免", "软禁", "制裁", "导弹", "军事", "美军", "开战", "战争", "俄乌", "巴以", "以色列", "伊朗", "俄罗斯", "乌克兰", "朝鲜", "韩国", "日本", "南海", "人大", "政协", "国务院", "中央军委", "部长", "省长", "市长", "书记", "访华", "出访", "建交", "断交", "宣战", "停火", "撤军", "驻军", "航母", "军舰", "战斗机", "轰炸机", "军队", "部队", "演习", "军演", "间谍", "恐怖", "袭击", "政变", "抗议", "游行", "示威", "弹劾", "公投", "修宪", "宪法", "法案", "立法", "最高法", "最高检", "中纪委", "反腐", "落马", "联合国", "安理会", "北约", "欧盟", "G7", "G20", "金砖", "上合", "东盟", "世贸", "关税", "贸易战", "脱钩", "断供", "封锁", "禁运", "遣返", "签证", "移民", "难民", "边境", "主权", "领土", "钓鱼岛"];
const ECONOMY = ["股市", "A股", "港股", "美股", "资本市场", "股票", "股价", "股指", "银行", "贷款", "利息", "存款", "利率", "央行", "逆回购", "降准", "降息", "加息", "IPO", "退市", "财报", "营收", "盈利", "亏损", "市值", "股份", "股权", "基金", "理财", "科创板", "银行卡", "冻结", "涉诈", "经济", "零售", "电商", "期货", "债券", "国债", "外汇"];
const TECH = ["人工智能", "大模型", "模型", "芯片", "GPU", "CPU", "半导体", "英伟达", "机器人", "自动驾驶", "智能驾驶", "无人驾驶", "新能源", "卫星", "航天", "神舟", "天宫", "载荷", "科技", "iPhone", "5G", "6G", "量子", "激光", "雷达", "传感器", "云计算", "数据中心", "算力", "区块链", "元宇宙", "虚拟现实", "折叠屏", "无人机", "火箭", "SpaceX", "特斯拉", "比亚迪", "新能源汽车", "电动车", "混动", "插混", "脑机接口", "开源", "Linux", "GitHub", "操作系统", "算法", "机器狗", "宇树", "飞行汽车", "低空", "DeepSeek", "Anthropic", "OpenAI", "谷歌", "微软", "华为", "大疆", "相机", "触控屏", "显卡", "处理器", "数字人", "虚拟人", "人形机器人", "物联网", "智能家居"];
const MEDICINE = ["医院", "肿瘤", "癌症", "癌", "医药", "药品", "药物", "疫苗", "接种", "疫情", "病毒", "感染", "流感", "医生", "患者", "治疗", "手术", "器官", "诊断", "疾病", "生病", "病人", "病例", "病房", "病情", "健康", "医疗", "医保", "临床", "试验", "新药", "抗体", "基因", "细胞", "免疫", "公共卫生", "保健", "体检", "确诊"];
const LIVELIHOOD = ["下雪", "暴雪", "降雪", "气象", "预警", "天气", "降温", "寒潮", "台风", "地震", "洪水", "暴雨", "高温", "干旱", "停电", "停水", "供暖", "暖气", "物价", "购买力", "省钱", "养老", "社保", "教育", "学生", "学校", "考试", "高考", "中考", "考研", "租房", "租金", "交通", "地铁", "高铁", "动车", "航班", "机场", "堵车", "出行", "食品安全", "快递", "物流", "供水", "供电", "燃气", "取暖", "菜价", "肉价", "猪肉", "蔬菜", "粮食", "大米", "食用油", "赊账", "零食", "小学生", "大学生", "幼儿园", "托儿所", "学费", "房租", "水电费", "物业", "停车", "驾照", "公积金", "退休", "养老金", "低保", "救助"];

// ---------- 分类与加权（关键词表经种子快照拟合校验，见 scripts/verify-sort.mjs） ----------
// 顺序：先剔娱乐/体育/琐事（综合），再按 政治 → 经济 → 科技 → 医药 → 民生 匹配关键词，
// 均无匹配时：Hacker News / IT 资讯 / AI 快讯默认科技，其余默认综合。
// 例外（种子实证）：关键词优先于娱乐词——如含“基金”的标题即使含“战队”也归经济，
// 因此“战队”不在 PRE_BAD 里；反之“日本队夺冠”这类由“夺冠/决赛”等纯体育词先行拦截。
const CATEGORY_LABELS = { politics: '政治', economy: '经济', tech: '科技', medicine: '医药', livelihood: '民生', general: '综合' };
const CATEGORY_BONUS = { politics: 3, economy: 3, tech: 3, medicine: 2, livelihood: 0, general: 0 };
const ALLOWED_CATEGORIES = new Set(['politics', 'economy', 'tech', 'medicine', 'livelihood']);

export function classifyTitle(title, bestPlatform) {
  for (const kw of PRE_BAD) if (title.includes(kw)) return 'general';
  for (const kw of POLITICS) if (title.includes(kw)) return 'politics';
  for (const kw of ECONOMY) if (title.includes(kw)) return 'economy';
  for (const kw of TECH) if (title.includes(kw)) return 'tech';
  for (const kw of MEDICINE) if (title.includes(kw)) return 'medicine';
  for (const kw of LIVELIHOOD) if (title.includes(kw)) return 'livelihood';
  if (bestPlatform === 'hackernews' || bestPlatform === 'itnews' || bestPlatform === 'ainews') return 'tech';
  return 'general';
}

// ---------- 榜单构建 ----------

// platformLists: [{id, name, items: [{rank, title, url, hotLabel}]}]
// platformOrder: 平台 id 顺序（平分时保持先出现者优先，与种子一致）
export function buildBoard(platformLists, platformOrder) {
  const lenById = new Map(platformLists.map((pl) => [pl.id, pl.items.length]));
  const topics = new Map();
  for (const pl of platformLists) {
    for (const it of pl.items) {
      const key = normTitle(it.title);
      if (!key) continue;
      if (!topics.has(key)) topics.set(key, { title: it.title, sources: [] });
      topics.get(key).sources.push({ platform: pl.id, platformName: pl.name, rank: it.rank, url: it.url });
    }
  }
  const scored = [];
  for (const tp of topics.values()) {
    const srcs = [...tp.sources].sort((a, b) => (a.rank - b.rank) || (platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform)));
    const category = classifyTitle(tp.title, srcs[0].platform);
    const resonance = srcs.length;
    const heat = srcs.reduce((s, x) => s + (lenById.get(x.platform) - x.rank + 1) / lenById.get(x.platform), 0);
    const score = heat * HEAT_SCALE + CATEGORY_BONUS[category] + RESONANCE_BONUS * (resonance - 1);
    scored.push({
      title: tp.title,
      url: srcs[0].url,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      resonance,
      sources: srcs.map(({ platform, platformName, rank }) => ({ platform, platformName, rank })),
      score,
    });
  }
  const allowed = scored.filter((t) => ALLOWED_CATEGORIES.has(t.category));
  allowed.sort((a, b) => b.score - a.score); // 稳定排序：平分保持先出现者优先
  const strip = (t, mustRead) => ({
    category: t.category,
    categoryLabel: t.categoryLabel,
    mustRead,
    resonance: t.resonance,
    sources: t.sources,
    title: t.title,
    url: t.url,
  });
  const totalBoard = allowed.slice(0, 20).map((t, i) => strip(t, i < 10));
  const categories = {};
  for (const c of ['politics', 'economy', 'tech']) {
    categories[c] = allowed.filter((t) => t.category === c).slice(0, 12).map((t, i) => strip(t, i < 5));
  }
  // 共振话题数：出现在 2 个及以上平台、且分类在总榜白名单内的话题数
  const resonanceCount = allowed.filter((t) => t.resonance >= 2).length;
  return { totalBoard, categories, resonanceCount };
}

// ---------- 抓取 ----------

async function fetchWithTimeout(url, timeoutMs, extraHeaders) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, */*;q=0.8', ...(extraHeaders || {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  return res;
}

async function fetchPlatform(p) {
  const started = Date.now();
  let lastError = '未尝试';
  for (const link of p.chain) {
    const elapsed = Date.now() - started;
    if (elapsed >= CHAIN_DEADLINE_MS) { lastError = '整条链超时 20 秒'; break; }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, CHAIN_DEADLINE_MS - elapsed);
    try {
      const url = typeof link.url === 'function' ? link.url() : link.url;
      const res = await fetchWithTimeout(url, timeoutMs, link.headers);
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      const json = await res.json();
      const parsed = link.parse(json);
      const items = (parsed || []).filter((it) => it && it.title && /^https?:\/\//.test(it.url || ''));
      if (items.length === 0) { lastError = '上游返回空榜单'; continue; }
      return { ok: true, items: items.slice(0, p.cap), source: link.via };
    } catch (e) {
      lastError = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? '请求超时 8 秒' : `请求失败：${(e && e.message) || e}`;
      continue;
    }
  }
  return { ok: false, error: lastError };
}

async function runAll(platforms, concurrency) {
  const results = new Array(platforms.length);
  let idx = 0;
  async function worker() {
    while (idx < platforms.length) {
      const i = idx++;
      results[i] = await fetchPlatform(platforms[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------- 一轮完整更新 ----------

// oldBoard: 上一轮 board.json 内容（可为 null）；失败平台保留旧缓存。
// 返回 { board, summary: { updated, total, failures: [{id, name, reason}], message } }
export async function updateBoard(oldBoard) {
  const results = await runAll(PLATFORMS, FETCH_CONCURRENCY);
  const now = new Date().toISOString();
  const oldLists = new Map(((oldBoard && Array.isArray(oldBoard.platformLists)) ? oldBoard.platformLists : []).map((pl) => [pl.id, pl]));
  const oldMeta = new Map(((oldBoard && Array.isArray(oldBoard.platforms)) ? oldBoard.platforms : []).map((p) => [p.id, p]));
  const platformLists = [];
  const platformsMeta = [];
  const failures = [];
  let updated = 0;
  for (let i = 0; i < PLATFORMS.length; i++) {
    const p = PLATFORMS[i];
    const r = results[i];
    if (r.ok) {
      updated++;
      platformLists.push({ id: p.id, name: p.name, items: r.items });
      platformsMeta.push({ id: p.id, name: p.name, count: r.items.length, fetchedAt: now, source: r.source });
    } else {
      failures.push({ id: p.id, name: p.name, reason: r.error });
      const old = oldLists.get(p.id);
      if (old) {
        platformLists.push({ id: old.id, name: old.name, items: old.items });
        const om = oldMeta.get(p.id);
        platformsMeta.push(om ? { ...om } : { id: p.id, name: p.name, count: old.items.length, fetchedAt: now, source: '' });
      } else {
        platformsMeta.push({ id: p.id, name: p.name, count: 0, fetchedAt: now, source: '' });
      }
    }
  }
  const { totalBoard, categories, resonanceCount } = buildBoard(platformLists, PLATFORMS.map((p) => p.id));
  const totalItems = platformLists.reduce((s, pl) => s + pl.items.length, 0);
  const board = {
    categories,
    hasData: totalItems > 0,
    platformLists,
    platforms: platformsMeta,
    resonanceCount,
    totalBoard,
    totalItems,
    updatedAt: now,
  };
  return {
    board,
    summary: {
      updated,
      total: PLATFORMS.length,
      failures,
      message: updated === 0 ? '刷新失败，仍显示上一次缓存' : `已更新 ${updated}/${PLATFORMS.length}`,
    },
  };
}

// ---------- board.json 读写（与种子同一序列化格式：键排序、2 空格缩进、无尾换行） ----------

export function stableStringify(value, indent = 2) {
  const pad = (n) => ' '.repeat(n);
  function str(v, level) {
    if (v === null) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const items = v.map((x) => pad((level + 1) * indent) + str(x, level + 1));
      return '[\n' + items.join(',\n') + '\n' + pad(level * indent) + ']';
    }
    const keys = Object.keys(v).sort();
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => pad((level + 1) * indent) + JSON.stringify(k) + ': ' + str(v[k], level + 1));
    return '{\n' + items.join(',\n') + '\n' + pad(level * indent) + '}';
  }
  return str(value, 0);
}

export async function readBoard(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 原子写：写临时文件 → fsync → 改名，避免写一半被读到
export async function writeBoardAtomic(board, filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(stableStringify(board));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
}
