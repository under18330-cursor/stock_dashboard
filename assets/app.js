/* 台股盤勢儀表板 — 前台 */
const LC = window.LightweightCharts;
const $ = (s, el = document) => el.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const charts = [];

const fmt = (x, d = 0) => x == null ? '—' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (x, d = 0) => x == null ? '—' : (x > 0 ? '+' : '') + fmt(x, d);
const cls = (x) => x > 0 ? 'up' : x < 0 ? 'down' : 'flat';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function load(name) {
  try {
    const r = await fetch(`data/${name}?t=${Math.floor(Date.now() / 60000)}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ---------- chart helpers ---------- */
function theme() {
  return {
    layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: 'transparent' }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') },
    timeScale: { borderColor: css('--axis') },
    crosshair: { mode: LC.CrosshairMode.Magnet },
  };
}
function makeChart(el, intraday = false) {
  const chart = LC.createChart(el, {
    ...theme(), autoSize: true,
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
    timeScale: { borderColor: css('--axis'), timeVisible: intraday, secondsVisible: false, rightOffset: 2 },
    handleScroll: true, handleScale: true,
  });
  charts.push(chart);
  return chart;
}
const candleOpts = () => ({
  upColor: css('--up'), downColor: css('--down'), borderUpColor: css('--up'), borderDownColor: css('--down'),
  wickUpColor: css('--up'), wickDownColor: css('--down'), priceLineVisible: false,
});
function dateOf(t) {
  if (typeof t === 'string') return t.replaceAll('-', '/');
  if (typeof t === 'object') return `${t.year}/${String(t.month).padStart(2, '0')}/${String(t.day).padStart(2, '0')}`;
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function tabs(el, items, onPick, active = 0) {
  el.innerHTML = items.map((t, i) => `<button type="button" aria-pressed="${i === active}">${esc(t)}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    [...el.children].forEach((c) => c.setAttribute('aria-pressed', c === b));
    onPick([...el.children].indexOf(b));
  });
}
const showLast = (chart, n, total) => chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - n) - 0.5, to: total + 1.5 });

/* ---------- 1. 指數 K 線 + 均線 / 布林通道 / BIAS ---------- */
// 回傳每根 K 的 MA5/10/20、布林上下軌(20, 2σ)、BIAS20(%)
function indicators(data) {
  const c = data.map((b) => b.close);
  const out = { ma5: [], ma10: [], ma20: [], up: [], lo: [], bias: [] };
  const sma = (i, n) => { let t = 0; for (let k = i - n + 1; k <= i; k++) t += c[k]; return t / n; };
  data.forEach((b, i) => {
    if (i >= 4) out.ma5.push({ time: b.time, value: sma(i, 5) });
    if (i >= 9) out.ma10.push({ time: b.time, value: sma(i, 10) });
    if (i >= 19) {
      const m = sma(i, 20);
      let v = 0;
      for (let k = i - 19; k <= i; k++) v += (c[k] - m) ** 2;
      const sd = Math.sqrt(v / 20);
      out.ma20.push({ time: b.time, value: m });
      out.up.push({ time: b.time, value: m + 2 * sd });
      out.lo.push({ time: b.time, value: m - 2 * sd });
      out.bias.push({ time: b.time, value: (c[i] - m) / m * 100 });
    }
  });
  return out;
}
// 週 KD(9,3,3) 的 J 值：日 K 併成週 K，每個交易日給「當週截至該日」的值（週末值＝正式週 J）
const mondayOf = (d) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); };
function weeklyJ(daily) {
  const out = [], weeks = [];
  let k0 = 50, d0 = 50, k1 = 50, d1 = 50;
  daily.forEach((b) => {
    const key = mondayOf(b.time);
    const w = weeks[weeks.length - 1];
    if (!w || w.k !== key) { k0 = k1; d0 = d1; weeks.push({ k: key, h: b.high, l: b.low }); }
    else { w.h = Math.max(w.h, b.high); w.l = Math.min(w.l, b.low); }
    const win = weeks.slice(-9);
    const hh = Math.max(...win.map((x) => x.h)), ll = Math.min(...win.map((x) => x.l));
    const rsv = hh > ll ? (b.close - ll) / (hh - ll) * 100 : 50;
    k1 = k0 * 2 / 3 + rsv / 3; d1 = d0 * 2 / 3 + k1 / 3;
    out.push({ time: b.time, value: +(3 * k1 - 2 * d1).toFixed(1) });
  });
  return out;
}
const J_KEYS = ['TWII', 'SOX'];  // 顯示週 J 值的指數
function indexCard(root, key, daily, intra) {
  const last = daily[daily.length - 1], prev = daily[daily.length - 2];
  const diff = last.c - prev.c, pct = diff / prev.c * 100;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head">
      <div><h2>${esc(intra?.name || key)}</h2>
        <div class="price"><span class="v">${fmt(last.c, 2)}</span>
          <span class="${cls(diff)}">${diff > 0 ? '▲' : diff < 0 ? '▼' : ''} ${fmt(Math.abs(diff), 2)}（${sgn(pct, 2)}%）</span>
          <span class="tag">${last.d.replaceAll('-', '/')}</span></div></div>
      <div class="tabs range"></div>
    </div>
    <div class="tabs toggles">
      <button type="button" data-k="ma" aria-pressed="true">均線</button>
      <button type="button" data-k="bb" aria-pressed="true">布林通道</button>
      <button type="button" data-k="bias" aria-pressed="true">BIAS 20</button>
      ${J_KEYS.includes(key) ? '<button type="button" data-k="wj" aria-pressed="true">週 J 值</button>' : ''}
    </div>
    <div class="legend"></div>
    <div class="legend ind"></div>
    <div class="chart tall"></div>`;
  root.appendChild(card);
  const legend = $('.legend', card), legend2 = $('.legend.ind', card);
  const on = { ma: true, bb: true, bias: true, wj: J_KEYS.includes(key) };
  const wjAll = on.wj ? weeklyJ(daily.map((r) => ({ time: r.d, high: r.h, low: r.l, close: r.c }))) : [];
  let chart, cur = 3;
  const off = intra?.gmtoffset || 0;
  const bars = (arr) => arr.map(([t, o, h, l, c]) => ({ time: t + off, open: o, high: h, low: l, close: c }));
  const dailyBars = daily.map((r) => ({ time: r.d, open: r.o, high: r.h, low: r.l, close: r.c }));
  const sw = (v) => `<i class="sw" style="background:var(${v})"></i>`;

  function draw(i) {
    cur = i;
    if (chart) { charts.splice(charts.indexOf(chart), 1); chart.remove(); }
    const isIntra = i < 3 && !!intra;
    chart = makeChart($('.chart', card), isIntra);
    // 指標用完整序列計算（均線需要前 20 根暖身），再裁成要顯示的區間
    let full = dailyBars, from = null, show = 250;
    if (isIntra) {
      full = bars(i === 2 ? intra.h1 : intra.m5);
      if (i === 0) {  // 1D：最近一個交易日
        const day = (b) => Math.floor(b.time / 86400);
        from = full.find((b) => day(b) === day(full[full.length - 1])).time;
      }
    }
    const ind = indicators(full);
    const cut = (arr) => from == null ? arr : arr.filter((r) => r.time >= from);
    const data = cut(full);
    const showJ = on.wj && !isIntra;  // 週 J 只在日線圖顯示
    const low = on.bias && showJ ? 0.44 : on.bias || showJ ? 0.26 : 0.06;
    $('.chart', card).style.height = showJ ? '440px' : '';
    const series = chart.addCandlestickSeries(candleOpts());
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: low } });
    series.setData(data);
    const line = (rows, color, opt = {}) => {
      const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, ...opt });
      s.setData(cut(rows));
      return s;
    };
    const S = {};
    if (on.bb) {
      S.up = line(ind.up, css('--bb'), { lineStyle: 2 });
      S.lo = line(ind.lo, css('--bb'), { lineStyle: 2 });
    }
    if (on.ma) {
      S.ma5 = line(ind.ma5, css('--ma5'));
      S.ma10 = line(ind.ma10, css('--ma10'));
      S.ma20 = line(ind.ma20, css('--ma20'), { lineWidth: 2 });
    }
    if (on.bias) {  // 獨立刻度，畫在下方 20% 的副圖
      S.bias = chart.addHistogramSeries({ priceScaleId: 'bias', priceLineVisible: false, lastValueVisible: false,
        priceFormat: { type: 'custom', minMove: 0.01, formatter: (x) => x.toFixed(1) + '%' } });
      chart.priceScale('bias').applyOptions({ scaleMargins: showJ ? { top: 0.6, bottom: 0.22 } : { top: 0.8, bottom: 0 } });
      S.bias.setData(cut(ind.bias).map((r) => ({ ...r, color: r.value >= 0 ? css('--up') : css('--down') })));
    }
    if (showJ) {  // 最下方副圖；25 以下為買點、100 以上停買
      S.wj = chart.addLineSeries({ priceScaleId: 'wj', color: css('--yu-j'), lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, priceFormat: { type: 'custom', minMove: 0.1, formatter: (x) => 'J ' + x.toFixed(0) },
        autoscaleInfoProvider: () => ({ priceRange: { minValue: -15, maxValue: 115 } }) });
      chart.priceScale('wj').applyOptions({ scaleMargins: { top: 0.82, bottom: 0.01 } });
      S.wj.setData(wjAll);
      S.wj.createPriceLine({ price: 25, color: css('--yu-buy'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      S.wj.createPriceLine({ price: 100, color: css('--yu-sell'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    }
    if (isIntra) chart.timeScale().fitContent(); else showLast(chart, show, data.length);

    const lastOf = (rows) => { const r = cut(rows); return r.length ? r[r.length - 1].value : null; };
    const paint = (t, b, v) => {
      const c = cls(b.close - b.open);
      legend.innerHTML = `<b>${dateOf(t)}</b>　開 ${fmt(b.open, 2)}　高 ${fmt(b.high, 2)}　低 ${fmt(b.low, 2)}　收 <b class="${c}">${fmt(b.close, 2)}</b>`;
      const parts = [];
      if (on.ma) parts.push(`${sw('--ma5')}MA5 <b>${fmt(v.ma5, 0)}</b>`, `${sw('--ma10')}MA10 <b>${fmt(v.ma10, 0)}</b>`, `${sw('--ma20')}MA20 <b>${fmt(v.ma20, 0)}</b>`);
      if (on.bb) parts.push(`${sw('--bb')}布林 <b>${fmt(v.lo, 0)} ~ ${fmt(v.up, 0)}</b>`);
      if (on.bias) parts.push(`BIAS20 <b class="${cls(v.bias)}">${v.bias == null ? '—' : sgn(v.bias, 2) + '%'}</b>`);
      if (showJ) parts.push(`${sw('--yu-j')}週J <b style="color:var(${v.wj < 25 ? '--yu-buy' : v.wj > 100 ? '--yu-sell' : '--ink'})">${v.wj == null ? '—' : fmt(v.wj, 1)}</b>${v.wj < 25 ? '（<25 買點）' : v.wj > 100 ? '（>100 停買）' : ''}`);
      legend2.innerHTML = parts.join('　');
    };
    const def = () => paint(data[data.length - 1].time, data[data.length - 1],
      { ma5: lastOf(ind.ma5), ma10: lastOf(ind.ma10), ma20: lastOf(ind.ma20), up: lastOf(ind.up), lo: lastOf(ind.lo), bias: lastOf(ind.bias), wj: wjAll.length ? wjAll[wjAll.length - 1].value : null });
    def();
    chart.subscribeCrosshairMove((p) => {
      const b = p.time && p.seriesData.get(series);
      if (!b) return def();
      const g = (k) => (S[k] && p.seriesData.get(S[k]) ? p.seriesData.get(S[k]).value : null);
      paint(p.time, b, { ma5: g('ma5'), ma10: g('ma10'), ma20: g('ma20'), up: g('up'), lo: g('lo'), bias: g('bias'), wj: g('wj') });
    });
  }
  tabs($('.tabs.range', card), ['1D', '5D', '1M', '1Y'], draw, 3);
  $('.toggles', card).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    on[b.dataset.k] = !on[b.dataset.k];
    b.setAttribute('aria-pressed', on[b.dataset.k]);
    draw(cur);
  });
  draw(3);
}

/* ---------- 通用：tab 切換的日資料圖 ---------- */
// views: [{label, rows:[{time,value}], type:'hist'|'line', unit, digits, signed}]
function seriesCard(el, { title, date, top = '', views, note = '', show = 120 }) {
  el.innerHTML = `
    <div class="card-head"><h2>${esc(title)}</h2><span class="tag">${date ? '資料日 ' + date.replaceAll('-', '/') : ''}</span></div>
    ${top}
    <div class="tabs"></div>
    <div class="legend"></div>
    <div class="chart"></div>
    ${note ? `<p class="note">${note}</p>` : ''}`;
  const legend = $('.legend', el);
  let chart;
  function draw(i) {
    const v = views[i];
    if (chart) { charts.splice(charts.indexOf(chart), 1); chart.remove(); }
    chart = makeChart($('.chart', el));
    const up = css('--up'), down = css('--down');
    let s;
    const pf = { type: 'custom', minMove: 1 / 10 ** (v.digits || 0), formatter: (x) => fmt(x, v.digits || 0) };
    if (v.type === 'line') {
      s = chart.addLineSeries({ color: css('--accent'), lineWidth: 2, priceLineVisible: false, priceFormat: pf });
      s.setData(v.rows);
      (v.lines || []).forEach((y) => s.createPriceLine({ price: y, color: css('--axis'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
    } else {
      s = chart.addHistogramSeries({ priceLineVisible: false, priceFormat: pf, color: css('--accent') });
      s.setData(v.signed === false ? v.rows : v.rows.map((r) => ({ ...r, color: r.value >= 0 ? up : down })));
    }
    showLast(chart, show, v.rows.length);
    const def = () => {
      const r = v.rows[v.rows.length - 1];
      legend.innerHTML = r ? `<b>${dateOf(r.time)}</b>　${esc(v.label)} <b>${v.signed === false || v.type === 'line' ? fmt(r.value, v.digits) : sgn(r.value, v.digits)}</b> ${v.unit || ''}` : '';
    };
    def();
    chart.subscribeCrosshairMove((p) => {
      const b = p.time && p.seriesData.get(s);
      if (!b) return def();
      const val = v.signed === false || v.type === 'line' ? fmt(b.value, v.digits) : sgn(b.value, v.digits);
      const c = v.signed === false || v.type === 'line' ? '' : cls(b.value);
      legend.innerHTML = `<b>${dateOf(p.time)}</b>　${esc(v.label)} <b class="${c}">${val}</b> ${v.unit || ''}`;
    });
  }
  if (views.length > 1) tabs($('.tabs', el), views.map((v) => v.label), draw); else $('.tabs', el).remove();
  draw(0);
}
const pick = (rows, f) => rows.map((r) => ({ time: r.d, value: f(r) })).filter((r) => r.value != null && !Number.isNaN(r.value));
const tile = (k, n, u = '', s = '', c = '') => `<div class="tile"><div class="k">${k}</div><div class="n ${c}">${n}<span class="u">${u}</span></div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
function rolling(rows, f, n) {
  const out = [];
  let sum = 0;
  const vals = rows.map((r) => f(r) || 0);
  vals.forEach((v, i) => { sum += v; if (i >= n) sum -= vals[i - n]; if (i >= n - 1) out.push({ time: rows[i].d, value: +sum.toFixed(2) }); });
  return out;
}

/* ---------- 2. 恐懼貪婪 ---------- */
function gauge(score, rating) {
  const c = score < 45 ? 'style="color:var(--fear2)"' : score > 55 ? 'style="color:var(--greed2)"' : '';
  return `<div class="gauge-row"><span class="score">${fmt(score, 0)}</span><span class="rating" ${c}>${esc(rating || '')}</span></div>
    <div class="meter"><div class="track"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="pin" style="left:${Math.max(0, Math.min(100, score))}%"></div>
      <div class="labels"><span>0 極度恐懼</span><span>50 中性</span><span>極度貪婪 100</span></div></div>`;
}
function fearCards(sum, twn, cnn, cnnNow, vix) {
  const zh = { 'extreme fear': '極度恐懼', fear: '恐懼', neutral: '中性', greed: '貪婪', 'extreme greed': '極度貪婪' };
  const t = sum?.twn_fear, v = sum?.vixtwn;
  if (t && twn) {
    const comps = Object.entries(t.components || {}).map(([k, x]) =>
      `<div class="row"><span>${esc(k)}</span><div class="bar"><i style="width:${x}%"></i></div><span>${fmt(x, 0)}</span></div>`).join('');
    seriesCard($('#fear-twn'), {
      title: '台股恐懼貪婪指數（自編）', date: t.date,
      top: gauge(t.score, t.rating) + `<div class="tiles">
        ${tile('前一日', fmt(t.prev, 0))}${tile('一週前', fmt(t.week_ago, 0))}
        ${v ? tile('VIXTWN 波動率', fmt(v.value, 2), '', `日 ${sgn(v.chg1d, 2)}／5日 ${sgn(v.chg5d, 2)}`) : ''}
        ${sum.pcr ? tile('P/C 未平倉比', fmt(sum.pcr.pc_oi, 1), '%') : ''}</div>
        <div class="comps">${comps}</div>`,
      views: [
        { label: '恐懼貪婪指數', type: 'line', rows: pick(twn, (r) => r.score), digits: 1, lines: [25, 75] },
        { label: 'VIXTWN', type: 'line', rows: pick(vix || [], (r) => r.vix), digits: 2 },
      ],
      note: '台灣沒有官方恐懼貪婪指數；此為自編：各因子取近一年百分位後平均（條狀越長越偏貪婪）。VIXTWN 為期交所臺指選擇權波動率指數，越高越恐慌。',
    });
  }
  if (cnnNow && cnn) {
    const names = { market_momentum_sp500: '股價動能 (S&P500)', stock_price_strength: '股價強度', stock_price_breadth: '市場廣度',
      put_call_options: 'Put/Call 選擇權', market_volatility_vix: '波動率 VIX', junk_bond_demand: '垃圾債需求', safe_haven_demand: '避險需求' };
    const comps = Object.entries(names).filter(([k]) => cnnNow.components?.[k]).map(([k, n]) =>
      `<div class="row"><span>${n}</span><div class="bar"><i style="width:${cnnNow.components[k].score}%"></i></div><span>${fmt(cnnNow.components[k].score, 0)}</span></div>`).join('');
    seriesCard($('#fear-cnn'), {
      title: 'CNN 恐懼與貪婪指數（美股）', date: (cnnNow.timestamp || '').slice(0, 10),
      top: gauge(cnnNow.score, zh[cnnNow.rating] || cnnNow.rating) + `<div class="tiles">
        ${tile('前一日', fmt(cnnNow.previous_close, 0))}${tile('一週前', fmt(cnnNow.previous_1_week, 0))}
        ${tile('一個月前', fmt(cnnNow.previous_1_month, 0))}${tile('一年前', fmt(cnnNow.previous_1_year, 0))}</div>
        <div class="comps">${comps}</div>`,
      views: [{ label: 'CNN Fear & Greed', type: 'line', rows: pick(cnn, (r) => r.score), digits: 1, lines: [25, 75] }],
    });
  }
}

/* ---------- 3. 法人 / 期貨 ---------- */
function instCard(sum, inst) {
  const s = sum?.institutional;
  if (!s || !inst?.length) return;
  const st = s.foreign_streak;
  seriesCard($('#inst'), {
    title: '三大法人買賣超（上市）', date: s.date,
    top: `<div class="tiles">
      ${tile('外資', sgn(s.foreign, 1), '億', Math.abs(st) >= 2 ? `連 ${Math.abs(st)} 日${st > 0 ? '買超' : '賣超'}` : '', cls(s.foreign))}
      ${tile('投信', sgn(s.trust, 1), '億', '', cls(s.trust))}
      ${tile('自營商', sgn(s.dealer, 1), '億', '', cls(s.dealer))}
      ${tile('合計', sgn(s.total, 1), '億', '', cls(s.total))}
      ${tile('外資近10日合計', sgn(s.foreign_10d, 1), '億', `5日 ${sgn(s.foreign_5d, 0)}／20日 ${sgn(s.foreign_20d, 0)}`, cls(s.foreign_10d))}</div>`,
    views: [
      { label: '外資', rows: pick(inst, (r) => r.foreign), unit: '億', digits: 1 },
      { label: '外資10日累計', rows: rolling(inst, (r) => r.foreign, 10), unit: '億', digits: 1 },
      { label: '投信', rows: pick(inst, (r) => r.trust), unit: '億', digits: 1 },
      { label: '自營商', rows: pick(inst, (r) => r.dealer), unit: '億', digits: 1 },
      { label: '合計', rows: pick(inst, (r) => r.total), unit: '億', digits: 1 },
    ],
  });
}
function futCard(sum, fut) {
  const s = sum?.futures;
  if (!s || !fut?.length) return;
  seriesCard($('#fut'), {
    title: '外資台指期貨未平倉', date: s.date,
    top: `<div class="tiles">
      ${tile('外資淨未平倉', sgn(s.foreign_net), '口', `近一年第 ${fmt(s.pct_rank_1y)} 百分位`, cls(s.foreign_net))}
      ${tile('日變動', sgn(s.chg1d), '口', '', cls(s.chg1d))}
      ${tile('5日變動', sgn(s.chg5d), '口', '', cls(s.chg5d))}
      ${tile('多單／空單', `${fmt(s.foreign_long)}`, '口', `空單 ${fmt(s.foreign_short)} 口`)}
      ${tile('投信淨額', sgn(s.trust_net), '口', `自營 ${sgn(s.dealer_net)} 口`)}</div>`,
    views: [
      { label: '外資淨未平倉', rows: pick(fut, (r) => r.f_net), unit: '口' },
      { label: '投信', rows: pick(fut, (r) => r.t_net), unit: '口' },
      { label: '自營商', rows: pick(fut, (r) => r.d_net), unit: '口' },
    ],
    note: '臺股期貨（大台 TXF）多空未平倉口數淨額；正值＝淨多單，負值＝淨空單。',
  });
}

/* ---------- 4. 融資 / 量能 ---------- */
function marginCard(sum, mar) {
  const s = sum?.margin;
  if (!s || !mar?.length) return;
  const row = (n, x) => x ? `<tr><td>${n}</td><td>${fmt(x.buy)}</td><td>${fmt(x.sell)}</td><td>${fmt(x.redeem)}</td>
    <td class="${cls(x.chg)}"><b>${sgn(x.chg)}</b></td><td>${fmt(x.bal)}</td><td>${fmt(x.amt, 1)}</td><td class="${cls(x.amt_chg)}">${sgn(x.amt_chg, 1)}</td>
    <td><b>${x.mr == null ? '—' : fmt(x.mr, 1) + '%'}</b>${x.mr != null && x.mr_prev != null ? ` <span class="tag">${sgn(x.mr - x.mr_prev, 1)}</span>` : ''}</td></tr>` : '';
  const d = (p) => (r) => r[p + '_bal'] != null && r[p + '_prev'] != null ? r[p + '_bal'] - r[p + '_prev'] : null;
  seriesCard($('#margin'), {
    title: '上市櫃融資', date: s.date,
    top: `<div class="xscroll"><table class="mini"><thead><tr><th>單位：張</th><th>買進</th><th>賣出</th><th>現償</th><th>增減</th><th>餘額</th><th>金額(億)</th><th>金額增減</th><th>維持率</th></tr></thead>
      <tbody>${row('上市', s.tse)}${row('上櫃', s.otc)}</tbody></table></div>`,
    views: [
      { label: '上市融資餘額', type: 'line', rows: pick(mar, (r) => r.tse_amt), unit: '億', digits: 1 },
      { label: '上市增減', rows: pick(mar, d('tse')), unit: '張' },
      { label: '上櫃融資餘額', type: 'line', rows: pick(mar, (r) => r.otc_amt), unit: '億', digits: 1 },
      { label: '上櫃增減', rows: pick(mar, d('otc')), unit: '張' },
      { label: '上市維持率', type: 'line', rows: pick(mar, (r) => r.tse_mr), unit: '%', digits: 1, lines: [130] },
      { label: '上櫃維持率', type: 'line', rows: pick(mar, (r) => r.otc_mr), unit: '%', digits: 1, lines: [130] },
    ],
    note: '融資維持率來源：凱基證券大盤動態（MoneyDJ）。個股維持率低於 130% 會被追繳，大盤值越接近 130% 代表斷頭賣壓風險越高。',
  });
}
function turnoverCard(sum, to) {
  const s = sum?.turnover;
  if (!s || !to?.length) return;
  seriesCard($('#turnover'), {
    title: '上市成交金額（量能）', date: s.date,
    top: `<div class="tiles">
      ${tile('成交金額', fmt(s.amt), '億', `前一日 ${fmt(s.prev)} 億`)}
      ${tile('對20日均量', sgn(s.vs_avg20, 1), '%', s.vs_avg20 > 10 ? '放量' : s.vs_avg20 < -10 ? '量縮' : '持平')}
      ${tile('5日均量', fmt(s.avg5), '億')}${tile('20日均量', fmt(s.avg20), '億')}</div>`,
    views: [{ label: '成交金額', rows: pick(to, (r) => r.amt), unit: '億', signed: false }],
  });
}

/* ---------- AI 短評 ---------- */
function aiCard(c) {
  if (!c) return;
  $('#ai-headline').textContent = c.headline || '';
  $('#ai-body').innerHTML = (c.body || '').split('\n').filter(Boolean)
    .map((l) => `<p>${esc(l).replace(/^【(.+?)】/, '<b>【$1】</b>')}</p>`).join('');
  $('#ai-meta').textContent = `${c.generated}・${c.source === 'rule-based' ? '規則式摘要（未設定 AI 金鑰）' : c.source}`;
}

/* ---------- 游庭澔邏輯模擬：AI 短評內的一列 ---------- */
const LAMP_ZH = { green: '綠燈', yellow: '黃燈', red: '紅燈', gray: '灰燈' };
function yuAiCard(sum, com) {
  const y = sum?.yu, el = $('#yu-ai');
  if (!y || !el) return;
  const mk = Object.values(y.markets).map((m) => `<div class="m ${m.light}">
    <div class="t"><i class="lamp ${m.light}" title="${LAMP_ZH[m.light]}"></i>${esc(m.name)}：${m.light === 'green' ? '🟢 ' : ''}${esc(m.verdict)}</div>
    <div class="d">週 J 值 ${fmt(m.j, 1)}（上週 ${fmt(m.j_prev, 1)}）｜自高點 ${fmt(m.dd, 1)}%，第 ${m.step} 個 5% 級距｜目標跌幅 ${m.target}% 已走 ${m.progress}%</div></div>`).join('');
  const chips = y.signals.map((x) => `<span class="chip ${x.state}" title="${esc(x.rule)}"><i class="lamp ${x.state === 'hit' ? 'green' : x.state === 'stop' ? 'red' : ''}"></i>${esc(x.label)} <b>${esc(x.value)}</b></span>`).join('');
  el.hidden = false;
  el.innerHTML = `<div class="yu-head"><i class="lamp big ${y.light}" title="${LAMP_ZH[y.light]}"></i><b>游庭澔邏輯模擬</b>
      <span class="verdict">${y.light === 'green' ? '🟢 ' : ''}${esc(y.verdict)}</span>
      <span class="tag">買進訊號 ${y.hits}／${y.signals.length} 項亮綠燈・依其週誌規則推算，非本人觀點</span></div>
    <div class="yu-mk">${mk}</div><div class="chips">${chips}</div>
    ${com?.yu ? `<p>${esc(com.yu).replace(/^【(.+?)】/, '<b>【$1】</b>')}</p>` : ''}`;
}

/* ---------- 游庭澔近 3 年進出圖 ---------- */
function yuCard(ev, alloc, wk, twDaily) {
  const el = $('#yu');
  if (!el) return;
  if (!ev?.length || !wk?.length) { el.innerHTML = '<p class="note">尚無資料</p>'; return; }
  const TYPES = { buy: ['買股', '--yu-buy', 'arrowUp', 'belowBar'], sell: ['賣出／調節', '--yu-sell', 'arrowDown', 'aboveBar'],
    bond: ['債券進出', '--yu-bond', 'circle', 'aboveBar'], pledge: ['質押', '--yu-pledge', 'square', 'belowBar'], pause: ['停止買入', '--yu-pause', 'square', 'aboveBar'] };
  // 週線：整理檔為底，本站日 K 有的週以日 K 為準並往後延伸
  const weeks = new Map(wk.map((w) => [mondayOf(w.d), { time: w.d, value: w.c }]));
  (twDaily || []).forEach((r) => { const k = mondayOf(r.d); const w = weeks.get(k); if (w) w.value = Math.round(r.c); else weeks.set(k, { time: r.d, value: Math.round(r.c) }); });
  const line = [...weeks.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, v]) => v);
  const timeOf = (d) => (weeks.get(mondayOf(d)) || line.filter((w) => w.time <= d).pop() || line[0]).time;
  const evs = ev.map((e) => ({ ...e, time: timeOf(e.d) }));
  const stock = [];
  (alloc || []).filter((a) => a.stock != null).forEach((a) => { const t = timeOf(a.d); if (!stock.length || stock[stock.length - 1].time !== t) stock.push({ time: t, value: a.stock, est: a.est, cash: a.cash }); });
  const shown = new Set(Object.keys(TYPES));
  let twOnly = false;
  el.innerHTML = `
    <div class="card-head"><h2>游庭澔 資產配置週誌：進出點 × 加權指數（週線）</h2><span class="tag">${evs[0].d.slice(0, 7).replace('-', '/')} – ${evs[evs.length - 1].d.replaceAll('-', '/')}・${evs.length} 筆</span></div>
    <div class="yu-filters">${Object.entries(TYPES).map(([k, t]) => `<label><input type="checkbox" checked data-k="${k}"><i class="lamp" style="background:var(${t[1]})"></i>${t[0]}</label>`).join('')}
      <label><input type="checkbox" id="yu-tw">只看台股相關（006208）</label></div>
    <div class="legend"></div>
    <div class="chart yu"></div>
    <div class="legend">股市部位 %（他自述）</div>
    <div class="chart yu-al"></div>
    <div class="yu-key"><span>▲ 買股（線下）</span><span>▼ 賣出／調節</span><span>● 債券進出</span><span>■ 質押（線下）／停止買入（線上）</span><span>編號後有「台」＝該次動到台股</span></div>
    <div class="yu-scroll"><table class="yu"><thead><tr><th>#</th><th>日期</th><th>動作</th><th>標的</th><th>當週加權</th><th>理由／觸發指標</th><th>股／債／現</th></tr></thead><tbody></tbody></table></div>
    <p class="note">資料為其會員週誌的重點整理（非原文），標記位置是該週加權指數收盤；他的主力是美股 QQQ／SOXX，台股 006208 為輔。點標記或表格列可互相對照。股市部位為他自述，2025/9 後多為文字推估。非投資建議。</p>`;
  const legend = $('.legend', el), tb = $('tbody', el);
  const chart = makeChart($('.chart', el));
  const idx = chart.addAreaSeries({ lineColor: css('--ink2'), topColor: css('--wash'), bottomColor: 'transparent', lineWidth: 2, priceLineVisible: false,
    priceFormat: { type: 'custom', minMove: 1, formatter: (x) => fmt(x, 0) } });
  idx.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.14 }, minimumWidth: 64 });
  idx.setData(line);
  // 股市部位另開一張小圖，時間軸與主圖同步
  const chart2 = makeChart($('.chart.yu-al', el));
  chart2.applyOptions({ timeScale: { visible: false } });
  chart2.addLineSeries({ visible: false, priceScaleId: 'pad' }).setData(line.map((w) => ({ time: w.time })));  // 對齊主圖的時間格
  const al = chart2.addLineSeries({ color: css('--accent'), lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    pointMarkersVisible: true, priceFormat: { type: 'custom', minMove: 1, formatter: (x) => x.toFixed(0) + '%' } });
  al.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 }, minimumWidth: 64 });
  al.setData(stock.map(({ time, value }) => ({ time, value })));
  chart.timeScale().fitContent();
  let lock = false;
  const sync = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (lock || !r) return; lock = true; b.timeScale().setVisibleLogicalRange(r); lock = false; });
  sync(chart, chart2); sync(chart2, chart);
  chart2.timeScale().setVisibleLogicalRange(chart.timeScale().getVisibleLogicalRange());
  const vis = (e) => shown.has(e.type) && (!twOnly || e.tw);
  const tkey = (t) => typeof t === 'string' ? t : `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  function paint() {
    idx.setMarkers(evs.filter(vis).sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0).map((e) => ({ time: e.time, position: TYPES[e.type][3], shape: TYPES[e.type][2], color: css(TYPES[e.type][1]),
      text: e.n + (e.tw ? '台' : ''), size: e.tw ? 1.4 : 1 })));
    tb.innerHTML = evs.filter(vis).map((e) => `<tr data-n="${e.n}"><td><span class="yu-no" style="background:var(${TYPES[e.type][1]})">${e.n}</span></td>
      <td class="n">${e.d.replaceAll('-', '/')}</td><td><span class="tag">${TYPES[e.type][0]}</span><br>${esc(e.action)}</td>
      <td>${e.tw ? '<b>' + esc(e.targets) + '</b>' : esc(e.targets)}</td><td class="n">${fmt(e.twii_close)}</td><td>${esc(e.reason)}</td><td class="n">${esc(e.alloc_note || '—')}</td></tr>`).join('');
  }
  const def = () => { const w = line[line.length - 1]; legend.innerHTML = `<b>${dateOf(w.time)} 當週</b>　加權指數 <b>${fmt(w.value)}</b>　｜　滑到標記可看該次進出`; };
  const hl = (n, scroll) => {
    tb.querySelectorAll('tr.hl').forEach((r) => r.classList.remove('hl'));
    const r = tb.querySelector(`tr[data-n="${n}"]`);
    if (!r) return;
    r.classList.add('hl');
    if (scroll) { const box = $('.yu-scroll', el); box.scrollTo({ top: r.offsetTop - box.clientHeight / 2 + r.clientHeight / 2, behavior: 'smooth' }); }
  };
  chart.subscribeCrosshairMove((p) => {
    const b = p.time && p.seriesData.get(idx);
    if (!b) return def();
    const t = tkey(p.time), hits = evs.filter((e) => e.time === t && vis(e)), s = stock.find((x) => x.time === t);
    legend.innerHTML = `<b>${dateOf(p.time)} 當週</b>　加權指數 <b>${fmt(b.value)}</b>` + (s ? `　股市部位 <b>${s.est ? '≈' : ''}${s.value}%</b>${s.cash != null ? `／現金 ${s.cash}%` : ''}` : '') +
      hits.map((e) => `　<b style="color:var(${TYPES[e.type][1]})">#${e.n} ${esc(e.action)}</b>（${esc(e.targets)}）`).join('');
  });
  chart.subscribeClick((p) => { if (!p.time) return; const t = tkey(p.time); const e = evs.find((x) => x.time === t && vis(x)); if (e) hl(e.n, true); });
  tb.addEventListener('click', (ev2) => {
    const r = ev2.target.closest('tr'); if (!r) return;
    const e = evs.find((x) => x.n === +r.dataset.n); hl(e.n, false);
    const i = line.findIndex((w) => w.time === e.time);
    chart.timeScale().setVisibleLogicalRange({ from: i - 26, to: i + 26 });
  });
  $('.yu-filters', el).addEventListener('change', (e2) => {
    const c = e2.target;
    if (c.id === 'yu-tw') twOnly = c.checked; else if (c.checked) shown.add(c.dataset.k); else shown.delete(c.dataset.k);
    paint();
  });
  paint(); def();
}

/* ---------- main ---------- */
(async function main() {
  if (document.body.dataset.page === 'yu') {  // 分頁：游庭澔近 3 年進出圖
    const [meta, ev, al, wk, tw] = await Promise.all(['meta.json', 'yu/events.json', 'yu/allocation.json', 'yu/twii_weekly.json', 'index_TWII.json'].map(load));
    $('#updated').textContent = meta ? `指數更新：${meta.updated}（台北時間）` : '';
    yuCard(ev, al, wk, tw);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
    return;
  }
  const keys = ['TWII', 'KS11', 'DJI', 'SOX'];
  const [meta, sum, com, intra, twn, cnn, cnnNow, vix, inst, fut, mar, to, ...idx] = await Promise.all([
    'meta.json', 'summary.json', 'commentary.json', 'intraday.json', 'twn_fear.json', 'cnn_fear_greed.json', 'cnn_now.json',
    'vixtwn.json', 'institutional.json', 'futures_oi.json', 'margin.json', 'turnover.json',
    ...keys.map((k) => `index_${k}.json`)].map(load));
  $('#updated').innerHTML = meta ? `資料更新：${esc(meta.updated)}（台北時間）` +
    (meta.errors?.length ? `　<span class="err">${meta.errors.length} 個來源更新失敗，詳見後台</span>` : '') : '尚無資料，請先執行後台抓取';
  aiCard(com);
  yuAiCard(sum, com);
  keys.forEach((k, i) => { if (idx[i]?.length > 2) indexCard($('#indices'), k, idx[i], intra?.[k]); });
  fearCards(sum, twn, cnn, cnnNow, vix);
  instCard(sum, inst);
  futCard(sum, fut);
  marginCard(sum, mar);
  turnoverCard(sum, to);
  // 深淺色切換時重新整理（顏色取自 CSS 變數）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
})();
