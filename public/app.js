// app.js —— 热点实时看板前端（零外部依赖）
// 打开先读浏览器本地缓存秒开（服务端快照仍是权威数据）；随后后台拉最新数据无感替换；
// 数据超过 15 分钟没更新时，后台静默触发一次服务端刷新，刷完自动换新。
(function () {
  var CACHE_KEY = 'news-board-cache-v1';
  var STALE_MS = 15 * 60 * 1000; // 15 分钟
  var board = null;
  var showMustOnly = false;
  var activePlatform = 'toutiao';
  var refreshing = false;
  var bgRefreshed = false;

  var statusText = document.getElementById('statusText');
  var refreshResult = document.getElementById('refreshResult');
  var refreshBtn = document.getElementById('refreshBtn');
  var infoStrip = document.getElementById('infoStrip');
  var totalList = document.getElementById('totalList');
  var totalEmpty = document.getElementById('totalEmpty');
  var categoriesEl = document.getElementById('categories');
  var capsulesEl = document.getElementById('capsules');
  var platformMeta = document.getElementById('platformMeta');
  var platformList = document.getElementById('platformList');
  var footText = document.getElementById('footText');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    var hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return m + '/' + day + ' ' + hh + ':' + mm;
  }

  function srcText(t) {
    return (t.sources || []).map(function (s) { return s.platformName + ' #' + s.rank; }).join(' · ');
  }

  function itemHtml(t, rank) {
    var tags = '';
    if (t.mustRead) tags += '<span class="tag must">必看</span>';
    if (t.categoryLabel) tags += '<span class="tag cat">' + esc(t.categoryLabel) + '</span>';
    var srcs = srcText(t);
    if (srcs) tags += '<span class="tag src">' + esc(srcs) + '</span>';
    var top3 = rank <= 3 ? ' top3' : '';
    return '<li class="rank-item"><span class="rank-num' + top3 + '">' + rank + '</span>' +
      '<div class="rank-body"><a class="rank-title" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.title) + '</a>' +
      (tags ? '<div class="tags">' + tags + '</div>' : '') + '</div></li>';
  }

  function platformItemHtml(it) {
    var hot = it.hotLabel ? '<span class="tag hot">' + esc(it.hotLabel) + '</span>' : '';
    return '<li class="rank-item"><span class="rank-num">' + it.rank + '</span>' +
      '<div class="rank-body"><a class="rank-title" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a>' +
      (hot ? '<div class="tags">' + hot + '</div>' : '') + '</div></li>';
  }

  function render() {
    if (!board || !board.hasData) return;
    var total = board.totalBoard || [];
    var show = showMustOnly ? total.filter(function (t) { return t.mustRead; }) : total;
    totalList.innerHTML = show.map(function (t, i) { return itemHtml(t, i + 1); }).join('');
    totalEmpty.hidden = show.length > 0;

    statusText.innerHTML = '更新于 <b>' + esc(fmtTime(board.updatedAt)) + '</b> · <b>' +
      (board.platforms ? board.platforms.length : 0) + '</b> 个平台 · <b>' +
      board.totalItems + '</b> 条 · 每 2 小时自动刷新';
    infoStrip.innerHTML = '<b>' + (board.platforms ? board.platforms.length : 0) + '</b> 个平台共 <b>' +
      board.totalItems + '</b> 条 → 精选 20 条，各平台来源与时间见下方平台榜。';
    footText.textContent = '数据每 2 小时自动刷新，更新于 ' + fmtTime(board.updatedAt);

    var catNames = { politics: '政治', economy: '经济', tech: '科技' };
    var catHtml = '';
    Object.keys(catNames).forEach(function (c) {
      var list = (board.categories && board.categories[c]) || [];
      if (!list.length) return;
      catHtml += '<div class="cat-card"><div class="cat-head"><h3>' + catNames[c] + '</h3><span>精选 ' + list.length + ' 条 · 前 5 条为必看</span></div>' +
        '<ol class="rank-list">' + list.map(function (t, i) { return itemHtml(t, i + 1); }).join('') + '</ol></div>';
    });
    categoriesEl.innerHTML = catHtml;

    var lists = board.platformLists || [];
    capsulesEl.innerHTML = lists.map(function (pl) {
      return '<button type="button" class="capsule' + (pl.id === activePlatform ? ' active' : '') +
        '" data-id="' + esc(pl.id) + '">' + esc(pl.name) + '</button>';
    }).join('');
    capsulesEl.querySelectorAll('.capsule').forEach(function (btn) {
      btn.addEventListener('click', function () { activePlatform = btn.getAttribute('data-id'); renderPlatforms(); });
    });
    renderPlatforms();
  }

  function renderPlatforms() {
    var lists = board ? (board.platformLists || []) : [];
    var metas = board ? (board.platforms || []) : [];
    var pl = lists.find(function (x) { return x.id === activePlatform; }) || lists[0];
    if (!pl) { platformMeta.textContent = ''; platformList.innerHTML = ''; return; }
    activePlatform = pl.id;
    var meta = metas.find(function (m) { return m.id === pl.id; });
    var metaText = pl.name + ' · ' + pl.items.length + ' 条';
    if (meta && meta.source) metaText += ' · 来源：' + meta.source;
    if (meta && meta.fetchedAt) metaText += ' · 更新于 ' + fmtTime(meta.fetchedAt);
    platformMeta.innerHTML = '<b>' + esc(pl.name) + '</b> · ' + pl.items.length + ' 条' +
      (meta && meta.source ? ' · 来源：' + esc(meta.source) : '') +
      (meta && meta.fetchedAt ? ' · 更新于 ' + esc(fmtTime(meta.fetchedAt)) : '');
    platformList.innerHTML = pl.items.map(platformItemHtml).join('');
    capsulesEl.querySelectorAll('.capsule').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-id') === activePlatform);
    });
  }

  function saveCache(b) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ board: b, savedAt: Date.now() })); } catch (e) { /* 缓存写失败不影响页面 */ }
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || !c.board || !c.savedAt || !c.board.hasData) return null;
      return c;
    } catch (e) { return null; }
  }

  function fetchBoard() {
    return fetch('/api/board').then(function (res) { return res.json(); });
  }

  function doRefresh(silent) {
    if (refreshing) return Promise.resolve(false);
    refreshing = true;
    if (!silent) { refreshBtn.disabled = true; refreshBtn.textContent = '刷新中...'; refreshResult.textContent = ''; }
    return fetch('/api/refresh', { method: 'POST' }).then(function (res) { return res.json(); }).then(function (data) {
      if (data && data.ok) {
        refreshResult.textContent = data.message || ('已更新 ' + data.updated + '/' + data.total);
        return fetchBoard().then(function (b) {
          if (b && b.hasData) { board = b; render(); saveCache(b); }
          return true;
        });
      }
      refreshResult.textContent = (data && data.message) || '刷新失败，仍显示上一次缓存';
      return false;
    }).catch(function () {
      refreshResult.textContent = '刷新失败，仍显示上一次缓存';
      return false;
    }).finally(function () {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '立即刷新';
    });
  }

  function maybeBackgroundRefresh() {
    if (bgRefreshed || !board || !board.updatedAt) return;
    if (Date.now() - new Date(board.updatedAt).getTime() > STALE_MS) {
      bgRefreshed = true;
      doRefresh(true); // 静默刷新：不改按钮文案，刷完自动换新
    }
  }

  function showLoadFailed() {
    statusText.textContent = '加载失败，点上方「立即刷新」再试一次';
    totalEmpty.hidden = false;
    totalEmpty.textContent = '加载失败，点上方「立即刷新」再试一次';
  }

  refreshBtn.addEventListener('click', function () { doRefresh(false); });
  document.getElementById('tabAll').addEventListener('click', function () {
    showMustOnly = false;
    document.getElementById('tabAll').classList.add('active');
    document.getElementById('tabMust').classList.remove('active');
    render();
  });
  document.getElementById('tabMust').addEventListener('click', function () {
    showMustOnly = true;
    document.getElementById('tabMust').classList.add('active');
    document.getElementById('tabAll').classList.remove('active');
    render();
  });

  // 启动：先读本地缓存秒开，再后台拉服务端最新数据
  var cached = loadCache();
  if (cached) {
    board = cached.board;
    render();
  }
  fetchBoard().then(function (b) {
    if (b && b.hasData) {
      board = b;
      render();
      saveCache(b);
      maybeBackgroundRefresh();
    } else if (!cached) {
      showLoadFailed();
    }
  }).catch(function () {
    if (!cached) showLoadFailed();
  });
})();
