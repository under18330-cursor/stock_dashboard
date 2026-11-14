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

/* ---------- 1. 指數 K 線 ---------- */
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
      <div class="tabs"></div>
    </div>
    <div class="legend"></div>
    <div class="chart tall"></div>`;
  root.appendChild(card);
  const legend = $('.legend', card);
  let chart, series;
  const off = intra?.gmtoffset || 0;
  const bars = (arr) => arr.map(([t, o, h, l, c]) => ({ time: t + off, open: o, high: h, low: l, close: c }));
  const dailyBars = daily.map((r) => ({ time: r.d, open: r.o, high: r.h, low: r.l, close: r.c }));
  const defLegend = '<span class="tag">移到圖上看開高低收；可拖曳、縮放</span>';

  function draw(i) {
    if (chart) { charts.splice(charts.indexOf(chart), 1); chart.remove(); }
    const el = $('.chart', card);
    const isIntra = i < 3 && !!intra;
    chart = makeChart(el, isIntra);
    series = chart.addCandlestickSeries(candleOpts());
    let data = dailyBars, show = 250;
    if (isIntra) {
      if (i === 0) {  // 1D：最近一個交易日的 5 分 K
        const all = bars(intra.m5);
        const day = (b) => Math.floor(b.time / 86400);
        data = all.filter((b) => day(b) === day(all[all.length - 1]));
      } else if (i === 1) data = bars(intra.m5);
      else data = bars(intra.h1);
      show = data.length;
    }
    series.setData(data);
    if (isIntra) chart.timeScale().fitContent(); else showLast(chart, show, data.length);
    legend.innerHTML = defLegend;
    chart.subscribeCrosshairMove((p) => {
      const b = p.time && p.seriesData.get(series);
      if (!b) { legend.innerHTML = defLegend; return; }
      const c = cls(b.close - b.open);
      legend.innerHTML = `<b>${dateOf(p.time)}</b>　開 ${fmt(b.open, 2)}　高 ${fmt(b.high, 2)}　低 ${fmt(b.low, 2)}　收 <b class="${c}">${fmt(b.close, 2)}</b>`;
    });
  }
  tabs($('.tabs', card), ['1D', '5D', '1M', '1Y'], draw, 3);
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
    note: '融資維持率為自行估算：Σ(個股融資餘額 × 收盤價) ÷ 融資餘額金額。個股維持率低於 130% 會被追繳，大盤值越接近 130% 代表斷頭賣壓風險越高。',
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

/* ---------- main ---------- */
(async function main() {
  const keys = ['TWII', 'KS11', 'DJI', 'SOX'];
  const [meta, sum, com, intra, twn, cnn, cnnNow, vix, inst, fut, mar, to, ...idx] = await Promise.all([
    'meta.json', 'summary.json', 'commentary.json', 'intraday.json', 'twn_fear.json', 'cnn_fear_greed.json', 'cnn_now.json',
    'vixtwn.json', 'institutional.json', 'futures_oi.json', 'margin.json', 'turnover.json',
    ...keys.map((k) => `index_${k}.json`)].map(load));
  $('#updated').innerHTML = meta ? `資料更新：${esc(meta.updated)}（台北時間）` +
    (meta.errors?.length ? `　<span class="err">${meta.errors.length} 個來源更新失敗，詳見後台</span>` : '') : '尚無資料，請先執行後台抓取';
  aiCard(com);
  keys.forEach((k, i) => { if (idx[i]?.length > 2) indexCard($('#indices'), k, idx[i], intra?.[k]); });
  fearCards(sum, twn, cnn, cnnNow, vix);
  instCard(sum, inst);
  futCard(sum, fut);
  marginCard(sum, mar);
  turnoverCard(sum, to);
  // 深淺色切換時重新整理（顏色取自 CSS 變數）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
})();
