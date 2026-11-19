/**
 * 台股盤勢儀表板 — Google Sheet 後台同步
 *
 * 安裝（只需一次）：
 *   1. 打開後台試算表 → 擴充功能 → Apps Script
 *   2. 把這整份程式貼上（取代原本內容）→ 儲存
 *   3. 上方函式選 setup → 執行 → 依畫面同意授權
 * 之後每小時自動從 GitHub 把 data/ 內的資料同步到各分頁（舊資料保留、新日期往下新增）。
 * 也可從試算表選單「盤勢後台 → 立即同步」手動更新。
 */
const BASE = 'https://raw.githubusercontent.com/under18330-cursor/stock_dashboard/HEAD/data/';

const OHLC = { d: '日期', o: '開', h: '高', l: '低', c: '收', v: '成交量' };
const SETS = [
  ['三大法人', 'institutional.json', { d: '日期', foreign: '外資(億)', trust: '投信(億)', dealer: '自營商(億)', total: '合計(億)' }],
  ['期貨未平倉', 'futures_oi.json', { d: '日期', f_net: '外資淨額(口)', f_long: '外資多單', f_short: '外資空單', f_trade_net: '外資當日交易淨額', t_net: '投信淨額', d_net: '自營淨額' }],
  ['融資', 'margin.json', { d: '日期', tse_buy: '上市買進(張)', tse_sell: '上市賣出', tse_redeem: '上市現償', tse_bal: '上市餘額(張)', tse_amt: '上市金額(億)', otc_buy: '上櫃買進(張)', otc_sell: '上櫃賣出', otc_redeem: '上櫃現償', otc_bal: '上櫃餘額(張)', otc_amt: '上櫃金額(億)', tse_mr: '上市維持率(%)', otc_mr: '上櫃維持率(%)' }],
  ['成交金額', 'turnover.json', { d: '日期', amt: '成交金額(億)', shares: '成交股數(億股)' }],
  ['台股恐懼貪婪', 'twn_fear.json', { d: '日期', score: '指數', rating: '評等', momentum: '動能', vix: '波動率', pcr: 'P/C比', fut: '外資期貨', spot10: '外資現貨10日', margin: '融資變化' }],
  ['CNN恐懼貪婪', 'cnn_fear_greed.json', { d: '日期', score: '指數', rating: '評等' }],
  ['VIXTWN', 'vixtwn.json', { d: '日期', vix: 'VIXTWN' }],
  ['VIX美股', 'vix_us.json', { d: '日期', vix: 'VIX 收盤', o: '開', h: '高', l: '低' }],
  ['PC比', 'pcr.json', { d: '日期', pc_vol: '成交量比(%)', pc_oi: '未平倉比(%)' }],
  ['加權指數', 'index_TWII.json', OHLC],
  ['KOSPI', 'index_KS11.json', OHLC],
  ['道瓊', 'index_DJI.json', OHLC],
  ['費半', 'index_SOX.json', OHLC],
  ['AI短評', 'commentary_log.json', { d: '時段', source: '來源', headline: '總結', body: '內容' }],
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('盤勢後台').addItem('立即同步', 'syncAll').addToUi();
}

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncAll').timeBased().everyHours(1).create();
  syncAll();
}

function syncAll() {
  const ss = SpreadsheetApp.getActive();
  const errors = [];
  SETS.forEach(([tab, file, cols]) => {
    try {
      syncOne(ss, tab, file, cols);
    } catch (e) {
      errors.push(tab + ': ' + e.message);
    }
  });
  const log = ss.getSheetByName('同步紀錄') || ss.insertSheet('同步紀錄');
  log.getRange(1, 1, 1, 2).setValues([['同步時間', '結果']]);
  log.insertRowAfter(1);
  log.getRange(2, 1, 1, 2).setValues([[new Date(), errors.length ? errors.join('；') : 'OK']]);
  if (log.getLastRow() > 500) log.deleteRows(501, log.getLastRow() - 500);
}

/** 以日期為鍵合併：GitHub 上有的日期以 GitHub 為準，試算表裡較舊、GitHub 已沒有的列仍保留。 */
function syncOne(ss, tab, file, cols) {
  const res = UrlFetchApp.fetch(BASE + file + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  const rows = JSON.parse(res.getContentText());
  const keys = Object.keys(cols);
  const sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
  const byDate = {};
  const last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, keys.length).getDisplayValues().forEach((r) => { if (r[0]) byDate[r[0]] = r; });
  }
  rows.forEach((r) => { byDate[r.d] = keys.map((k) => (r[k] === undefined || r[k] === null ? '' : r[k])); });
  const out = Object.keys(byDate).sort().reverse().map((d) => byDate[d]);  // 最新在最上面
  sheet.clearContents();
  sheet.getRange(1, 1, 1, keys.length).setValues([keys.map((k) => cols[k])]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');  // 日期欄維持文字，避免被轉格式
  if (out.length) sheet.getRange(2, 1, out.length, keys.length).setValues(out);
  sheet.setFrozenRows(1);
}
