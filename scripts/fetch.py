#!/usr/bin/env python3
"""後台資料抓取：指數K線、恐懼指數、三大法人、外資期貨未平倉、融資。

用法:
  python scripts/fetch.py              # 例行更新（補最近缺漏的交易日）
  python scripts/fetch.py --backfill   # 首次回補過去一年
  python scripts/fetch.py --only indices,cnn   # 只跑部分來源

資料以 JSON 累積存放在 data/，每次執行只會新增/覆寫同日期資料，歷史不會被刪除。
只使用 Python 標準函式庫。
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
TW = dt.timezone(dt.timedelta(hours=8))

INDICES = {
    "TWII": {"symbol": "^TWII", "name": "台股加權指數"},
    "KS11": {"symbol": "^KS11", "name": "韓國 KOSPI"},
    "DJI": {"symbol": "^DJI", "name": "道瓊工業指數"},
    "SOX": {"symbol": "^SOX", "name": "費城半導體"},
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------- HTTP ----------
def http(url, data=None, headers=None, retries=4, pause=3.0, timeout=30):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
         "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"}
    h.update(headers or {})
    body = urllib.parse.urlencode(data).encode() if data else None
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = e
            time.sleep(pause * (i + 2))
    raise RuntimeError(f"GET {url} failed: {last}")


def http_json(url, **kw):
    """抓 JSON；遇到防火牆擋頁（回 HTML）會退避重試。"""
    last = None
    for i in range(4):
        raw = http(url, **kw)
        try:
            return json.loads(raw)
        except ValueError:
            last = raw[:80]
            time.sleep(8 * (i + 1))
    raise RuntimeError(f"non-JSON from {url}: {last!r}")


# ---------- storage ----------
def load(name, default=None):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return [] if default is None else default


def save(name, obj):
    os.makedirs(DATA, exist_ok=True)
    p = os.path.join(DATA, name)
    with open(p, "w", encoding="utf-8") as f:
        if isinstance(obj, list):  # 一列一行，方便 git diff
            f.write("[\n" + ",\n".join(
                json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in obj) + "\n]\n")
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def merge_rows(name, rows, key="d"):
    """依日期合併進既有檔案（新資料覆寫同日），回傳合併後列表。"""
    cur = {r[key]: r for r in load(name)}
    for r in rows:
        cur[r[key]] = {**cur.get(r[key], {}), **r}
    out = [cur[k] for k in sorted(cur)]
    save(name, out)
    return out


def num(s):
    s = str(s).replace(",", "").strip()
    if s in ("", "-", "--"):
        return None
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


# ---------- 1. 指數 K 線 (Yahoo Finance) ----------
def yahoo(symbol, rng, interval):
    url = ("https://query2.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?range={rng}&interval={interval}")
    r = http_json(url)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    bars = []
    for i, t in enumerate(r.get("timestamp") or []):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        v = q["volume"][i] or 0
        bars.append([t, round(o, 2), round(h, 2), round(l, 2), round(c, 2), v])
    return r["meta"], bars


def fetch_indices(backfill):
    intraday = {}
    for key, cfg in INDICES.items():
        meta, bars = yahoo(cfg["symbol"], "2y" if backfill else "1mo", "1d")
        off = meta["gmtoffset"]
        rows = []
        for t, o, h, l, c, v in bars:
            d = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).strftime("%Y-%m-%d")
            row = {"d": d, "o": o, "h": h, "l": l, "c": c, "v": v}
            if key == "TWII":  # 加權指數的量改用證交所資料（見 apply_twse_volume），不採 Yahoo 的值
                del row["v"]
            rows.append(row)
        n = len(merge_rows(f"index_{key}.json", rows))
        time.sleep(1)
        _, m5 = yahoo(cfg["symbol"], "5d", "5m")
        time.sleep(1)
        _, h1 = yahoo(cfg["symbol"], "1mo", "60m")
        intraday[key] = {
            "name": cfg["name"], "symbol": cfg["symbol"], "gmtoffset": off,
            "tz": meta.get("exchangeTimezoneName"),
            "price": meta.get("regularMarketPrice"),
            "prevClose": meta.get("chartPreviousClose"),
            "marketTime": meta.get("regularMarketTime"),
            "m5": m5, "h1": h1,
        }
        log(f"  {key}: daily={n} m5={len(m5)} h1={len(h1)}")
        time.sleep(1)
    save("intraday.json", intraday)


# ---------- 2. 恐懼指數 ----------
def fetch_cnn(backfill):
    start = (dt.date.today() - dt.timedelta(days=370 if backfill else 20)).isoformat()
    d = http_json(
        f"https://production.dataviz.cnn.io/index/fearandgreed/graphdata/{start}",
        headers={"Origin": "https://edition.cnn.com", "Referer": "https://edition.cnn.com/"})
    rows = []
    for p in d["fear_and_greed_historical"]["data"]:
        day = dt.datetime.fromtimestamp(p["x"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        rows.append({"d": day, "score": round(p["y"], 1), "rating": p["rating"]})
    merge_rows("cnn_fear_greed.json", rows)
    comp = {k: {"score": round(v["score"], 1), "rating": v["rating"]}
            for k, v in d.items() if k not in ("fear_and_greed", "fear_and_greed_historical")
            and isinstance(v, dict) and "score" in v}
    now = d["fear_and_greed"]
    save("cnn_now.json", {
        "score": round(now["score"], 1), "rating": now["rating"], "timestamp": now["timestamp"],
        "previous_close": round(now["previous_close"], 1),
        "previous_1_week": round(now["previous_1_week"], 1),
        "previous_1_month": round(now["previous_1_month"], 1),
        "previous_1_year": round(now["previous_1_year"], 1),
        "components": comp})
    log(f"  CNN: {now['score']:.1f} {now['rating']} (+{len(rows)} rows)")


def fetch_vix_us(backfill):
    """CBOE VIX 指數（INDEXCBOE: VIX，美股波動率／恐慌指數），日 K。"""
    meta, bars = yahoo("^VIX", "2y" if backfill else "1mo", "1d")
    off = meta["gmtoffset"]
    rows = []
    for t, o, h, l, c, _v in bars:
        d = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).strftime("%Y-%m-%d")
        rows.append({"d": d, "o": o, "h": h, "l": l, "vix": c})
    out = merge_rows("vix_us.json", rows)
    log(f"  CBOE VIX: total {len(out)} rows, last {out[-1]['vix'] if out else None}")


def fetch_vix(backfill):
    """台指選擇權波動率指數 VIXTWN（期交所只提供近幾個月的月檔）。"""
    today = dt.datetime.now(TW).date()
    rows, y, m = [], today.year, today.month
    for _ in range(6 if backfill else 2):
        url = f"https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/{y}{m:02d}new.txt"
        try:
            txt = http(url, retries=2).decode("big5", "ignore")
        except RuntimeError:
            txt = ""
        for line in txt.splitlines():
            c = line.split("\t")
            if len(c) >= 5 and c[0].isdigit() and len(c[0]) == 8:
                vals = [num(x) for x in c[2:] if num(x) is not None]
                if vals:
                    rows.append({"d": f"{c[0][:4]}-{c[0][4:6]}-{c[0][6:]}", "vix": vals[0]})
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        time.sleep(1)
    out = merge_rows("vixtwn.json", rows)
    log(f"  VIXTWN: total {len(out)} rows")


def fetch_pcr(backfill):
    """臺指選擇權 Put/Call 比（期交所，一次最多查約 30 天）。"""
    today = dt.datetime.now(TW).date()
    rows = []
    end = today
    for _ in range(13 if backfill else 1):
        start = end - dt.timedelta(days=29)
        raw = http("https://www.taifex.com.tw/cht/3/pcRatioDown",
                   data={"queryStartDate": start.strftime("%Y/%m/%d"),
                         "queryEndDate": end.strftime("%Y/%m/%d")})
        for r in csv.reader(io.StringIO(raw.decode("big5", "ignore"))):
            if len(r) >= 7 and r[0][:2] == "20":
                rows.append({"d": r[0].replace("/", "-"), "pc_vol": num(r[3]), "pc_oi": num(r[6])})
        end = start - dt.timedelta(days=1)
        time.sleep(1.5)
    out = merge_rows("pcr.json", rows)
    log(f"  P/C ratio: total {len(out)} rows")


# ---------- 3. 期貨未平倉 / 三大法人 ----------
def fetch_futures(backfill):
    """三大法人臺股期貨(TXF)未平倉。回傳交易日清單。"""
    today = dt.datetime.now(TW).date()
    start = today - dt.timedelta(days=366 if backfill else 20)
    raw = b""
    for back in range(8):  # 迄日若尚無資料（假日/盤中）期交所會回錯誤頁，往前退
        end = today - dt.timedelta(days=back)
        raw = http("https://www.taifex.com.tw/cht/3/futContractsDateDown",
                   data={"queryStartDate": start.strftime("%Y/%m/%d"),
                         "queryEndDate": end.strftime("%Y/%m/%d"), "commodityId": "TXF"})
        if not raw.lstrip().startswith(b"<"):
            break
        time.sleep(1)
    who = {"外資及陸資": "f", "外資": "f", "投信": "t", "自營商": "d"}
    by = {}
    for r in csv.reader(io.StringIO(raw.decode("big5", "ignore"))):
        if len(r) < 15 or r[0][:2] != "20" or r[2].strip() not in who:
            continue
        k = who[r[2].strip()]
        row = by.setdefault(r[0].replace("/", "-"), {"d": r[0].replace("/", "-")})
        row[f"{k}_long"], row[f"{k}_short"], row[f"{k}_net"] = num(r[9]), num(r[11]), num(r[13])
        row[f"{k}_trade_net"] = num(r[7])
    out = merge_rows("futures_oi.json", list(by.values()))
    log(f"  期貨未平倉: total {len(out)} rows")
    return [r["d"] for r in out]


TWSE_PAUSE = 6.0  # 證交所有頻率限制（過快會回 307 / 擋頁）
TWSE_H = {"Referer": "https://www.twse.com.tw/zh/trading/foreign/bfi82u.html",
          "X-Requested-With": "XMLHttpRequest"}


def yi(x):  # 元 -> 億元
    return None if x is None else round(x / 1e8, 2)


INST_REFRESH = 5  # 每次重抓最近幾個交易日的三大法人


def fetch_institutional(dates):
    have = {r["d"] for r in load("institutional.json")}
    todo = [d for d in dates if d not in have]
    # 缺很多天（回補）時才用 FinMind 一次補齊
    if len(todo) > INST_REFRESH and via_finmind("三大法人", finmind_institutional, "institutional.json", todo):
        todo = []
    # 證交所 15:00 左右先公布初步數字，之後會修正（主要是投信）；所以最近幾個交易日每次都向證交所重抓
    recent = sorted(have | set(dates))[-INST_REFRESH:]
    rows = []
    for i, d in enumerate(sorted(set(todo) | set(recent))):
        try:
            j = http_json("https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&response=json"
                          f"&dayDate={d.replace('-', '')}", headers=TWSE_H)
        except RuntimeError as e:
            log(f"  skip {d}: {e}")
            continue
        finally:
            time.sleep(TWSE_PAUSE)
        if j.get("stat") != "OK" or not j.get("data"):
            continue
        row = {"d": d, "dealer": 0.0}
        for name, _buy, _sell, net in j["data"]:
            v = yi(num(net)) or 0
            if name.startswith("自營商"):
                row["dealer"] = round(row["dealer"] + v, 2)
            elif name.startswith("投信"):
                row["trust"] = v
            elif name.startswith("外資及陸資"):
                row["foreign"] = v
            elif name.startswith("合計"):
                row["total"] = v
        rows.append(row)
        if (i + 1) % 20 == 0:
            merge_rows("institutional.json", rows)
            log(f"  三大法人 {i + 1}/{len(todo)}")
    out = merge_rows("institutional.json", rows)
    log(f"  三大法人: +{len(rows)} total {len(out)}")


def fetch_turnover(backfill):
    """上市每日成交金額（量能），證交所 FMTQIK 以月為單位。"""
    today = dt.datetime.now(TW).date()
    rows = []

    def month(y, m):
        j = http_json("https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json"
                      f"&date={y}{m:02d}01", headers=TWSE_H)
        for r in (j.get("data") or []) if j.get("stat") == "OK" else []:
            yy, mm, dd = r[0].split("/")
            rows.append({"d": f"{int(yy) + 1911}-{mm}-{dd}", "amt": yi(num(r[2])),
                         "shares": round(num(r[1]) / 1e8, 2)})
        time.sleep(TWSE_PAUSE)

    def prev(y, m):
        return (y - 1, 12) if m == 1 else (y, m - 1)

    y, m = today.year, today.month
    for _ in range(13 if backfill else 2):
        month(y, m)
        y, m = prev(y, m)
    # 加權指數日 K 比成交資料早的部分，每次往前補 3 個月（證交所會限流，不一次抓完；失敗下次再補）
    have, twii = load("turnover.json"), load("index_TWII.json")
    first = min([r["d"] for r in have + rows] or [""])[:7]
    if twii and first and twii[0]["d"][:7] < first:
        y, m = prev(*map(int, first.split("-")))
        try:
            for _ in range(3):
                if f"{y}-{m:02d}" < twii[0]["d"][:7]:
                    break
                month(y, m)
                y, m = prev(y, m)
        except Exception as e:
            log(f"  較早月份補抓失敗，下次再試: {e}")
    out = merge_rows("turnover.json", rows)
    log(f"  成交金額: total {len(out)} rows")


# ---------- FinMind（有 FINMIND_TOKEN 時優先使用，一次可抓整段日期） ----------
def finmind(dataset, start):
    tok = os.environ.get("FINMIND_TOKEN")
    if not tok:
        return None
    j = http_json(f"https://api.finmindtrade.com/api/v4/data?dataset={dataset}&start_date={start}",
                  headers={"Authorization": f"Bearer {tok}"}, retries=2)
    if j.get("status") != 200:
        raise RuntimeError(f"FinMind {dataset}: {j.get('msg')}")
    return j["data"]


def finmind_institutional(start):
    data = finmind("TaiwanStockTotalInstitutionalInvestors", start)
    if data is None:
        return None
    by = {}
    for r in data:
        row = by.setdefault(r["date"], {"d": r["date"], "dealer": 0.0})
        v = yi(r["buy"] - r["sell"])
        n = r["name"]
        if n in ("Dealer_self", "Dealer_Hedging"):
            row["dealer"] = round(row["dealer"] + v, 2)
        elif n == "Investment_Trust":
            row["trust"] = v
        elif n == "Foreign_Investor":
            row["foreign"] = v
        elif n == "total":
            row["total"] = v
    return [r for r in by.values() if "foreign" in r]


def finmind_margin(start):
    data = finmind("TaiwanStockTotalMarginPurchaseShortSale", start)
    if data is None:
        return None
    by = {}
    for r in data:
        row = by.setdefault(r["date"], {"d": r["date"]})
        if r["name"] == "MarginPurchase":
            row.update(tse_buy=r["buy"], tse_sell=r["sell"], tse_redeem=r["Return"],
                       tse_prev=r["YesBalance"], tse_bal=r["TodayBalance"])
        elif r["name"] == "MarginPurchaseMoney":
            row["tse_amt"] = round(r["TodayBalance"] / 1e8, 2)
            row["tse_amt_prev"] = round(r["YesBalance"] / 1e8, 2)
    return [r for r in by.values() if "tse_bal" in r]


def via_finmind(name, fn, file, dates):
    """用 FinMind 補齊 dates 之中缺的日期；失敗或無金鑰回 False，改走官方逐日查詢。"""
    if not dates or not os.environ.get("FINMIND_TOKEN"):
        return False
    try:
        rows = fn(min(dates))
        out = merge_rows(file, rows)
        log(f"  {name} (FinMind): +{len(rows)} total {len(out)}")
        return True
    except Exception as e:
        log(f"  FinMind {name} failed, fallback to TWSE: {e}")
        return False


# ---------- 4. 融資 ----------
def twse_margin(d):
    j = http_json("https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json"
                  f"&selectType=MS&date={d.replace('-', '')}",
                  headers={**TWSE_H, "Referer": "https://www.twse.com.tw/zh/trading/margin/mi-margn.html"})
    if j.get("stat") != "OK" or not j.get("tables") or not j["tables"][0].get("data"):
        return {}
    out = {}
    for r in j["tables"][0]["data"]:
        if r[0].startswith("融資(交易單位)"):
            out.update(tse_buy=num(r[1]), tse_sell=num(r[2]), tse_redeem=num(r[3]),
                       tse_prev=num(r[4]), tse_bal=num(r[5]))
        elif r[0].startswith("融資金額"):
            out["tse_amt"] = round(num(r[5]) / 1e5, 2)  # 仟元 -> 億元
            out["tse_amt_prev"] = round(num(r[4]) / 1e5, 2)
    return out


def tpex_margin(d):
    j = http_json("https://www.tpex.org.tw/www/zh-tw/margin/balance?response=json"
                  f"&date={d.replace('-', '/')}")
    t = (j.get("tables") or [{}])[0]
    if j.get("date") != d.replace("-", "") or not t.get("summary"):
        return {}
    out = {}
    for r in t["summary"]:
        if r[1].startswith("合計"):
            out.update(otc_prev=num(r[2]), otc_buy=num(r[3]), otc_sell=num(r[4]),
                       otc_redeem=num(r[5]), otc_bal=num(r[6]))
        elif r[1].startswith("融資金"):
            out["otc_amt"] = round(num(r[6]) / 1e5, 2)
            out["otc_amt_prev"] = round(num(r[2]) / 1e5, 2)
    return out


def fetch_margin(dates):
    cur = {r["d"]: r for r in load("margin.json")}
    if via_finmind("上市融資", finmind_margin, "margin.json",
                   [d for d in dates if "tse_bal" not in cur.get(d, {})]):
        cur = {r["d"]: r for r in load("margin.json")}
    todo = [d for d in dates if "tse_bal" not in cur.get(d, {}) or "otc_bal" not in cur.get(d, {})]
    rows = []
    for i, d in enumerate(todo):
        row = {"d": d}
        try:
            if "tse_bal" not in cur.get(d, {}):
                row.update(twse_margin(d))
                time.sleep(TWSE_PAUSE)
            if "otc_bal" not in cur.get(d, {}):
                row.update(tpex_margin(d))
                time.sleep(1.0)
        except RuntimeError as e:
            log(f"  skip {d}: {e}")
        if len(row) > 1:
            rows.append(row)
        if (i + 1) % 20 == 0:
            merge_rows("margin.json", rows)
            log(f"  融資 {i + 1}/{len(todo)}")
    out = merge_rows("margin.json", rows)
    log(f"  融資: +{len(rows)} total {len(out)}")


# ---------- 5. 融資維持率（自行計算） ----------
# 大盤融資維持率 = Σ(個股融資餘額張數 × 1000 × 收盤價) ÷ 融資餘額金額
def _ratio(bal, close, amt_yi):
    mv = sum(b * 1000 * close[c] for c, b in bal.items() if b and close.get(c))
    return round(mv / (amt_yi * 1e8) * 100, 1) if amt_yi and mv else None


def tse_maintenance(d, amt_yi):
    ymd = d.replace("-", "")
    j = http_json("https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json"
                  f"&selectType=ALL&date={ymd}", headers=TWSE_H)
    time.sleep(TWSE_PAUSE)
    if j.get("stat") != "OK" or len(j.get("tables") or []) < 2:
        return None
    bal = {r[0].strip(): num(r[6]) for r in j["tables"][1].get("data") or []}
    j = http_json("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json"
                  f"&type=ALLBUT0999&date={ymd}", headers=TWSE_H)
    time.sleep(TWSE_PAUSE)
    close = {}
    for t in j.get("tables") or []:
        if "每日收盤行情" in (t.get("title") or ""):
            close = {r[0].strip(): num(r[8]) for r in t.get("data") or []}
    return _ratio(bal, close, amt_yi)


def otc_maintenance(d, amt_yi):
    q = d.replace("-", "/")
    j = http_json(f"https://www.tpex.org.tw/www/zh-tw/margin/balance?response=json&date={q}")
    t = (j.get("tables") or [{}])[0]
    if j.get("date") != d.replace("-", "") or not t.get("data"):
        return None
    bal = {r[0].strip(): num(r[6]) for r in t["data"]}
    time.sleep(1.0)
    j = http_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?response=json&date={q}")
    t = (j.get("tables") or [{}])[0]
    close = {r[0].strip(): num(r[2]) for r in t.get("data") or []}
    time.sleep(1.0)
    return _ratio(bal, close, amt_yi)


def kgi_maintenance():
    """凱基證券「大盤動態 > 信用交易」所用的 MoneyDJ 資料，一次回傳約 300 個交易日。"""
    base = "https://kgiweb.moneydj.com/b2brwdCommon/jsondata/c6/fb/f2/twstockdata.xdjjson"
    by = {}
    for tag, key in (("afterHours-market0002-1", "tse_mr"), ("afterHours-market0002-2", "otc_mr")):
        j = http_json(f"{base}?x={tag}&b=d&c=300", retries=2,
                      headers={"Referer": "https://kgiweb.moneydj.com/b2brwd/page/afterhours/market/0002"})
        for r in (j.get("ResultSet") or {}).get("Result") or []:
            v = num(r.get("V6"))
            if v:
                d = r["V1"].replace("/", "-")
                by.setdefault(d, {"d": d})[key] = v
        time.sleep(1)
    return list(by.values())


def fetch_maintenance(dates):
    have = {r["d"] for r in load("margin.json")}
    try:  # 優先用凱基/MoneyDJ 的現成數字；只寫入 margin.json 已有的日期
        rows = [r for r in kgi_maintenance() if r["d"] in have]
        merge_rows("margin.json", rows)
        log(f"  融資維持率 (KGI): {len(rows)} 日")
    except Exception as e:
        log(f"  KGI 來源失敗，改為自行計算: {e}")
    dates = dates[-3:]  # 備援：僅自行計算最近幾日（證交所有頻率限制）
    cur = {r["d"]: r for r in load("margin.json")}
    todo = [d for d in reversed(dates)  # 由新到舊補
            if d in cur and ("tse_mr" not in cur[d] or "otc_mr" not in cur[d])]
    rows = []
    for i, d in enumerate(todo):
        row = {"d": d}
        for p, fn in (("otc", otc_maintenance), ("tse", tse_maintenance)):
            if f"{p}_mr" in cur[d] or not cur[d].get(f"{p}_amt"):
                continue
            try:
                v = fn(d, cur[d][f"{p}_amt"])
                if v:
                    row[f"{p}_mr"] = v
            except RuntimeError as e:
                log(f"  skip {p} {d}: {e}")
        if len(row) > 1:
            rows.append(row)
        if (i + 1) % 10 == 0:
            merge_rows("margin.json", rows)
            log(f"  融資維持率 {i + 1}/{len(todo)}")
    out = merge_rows("margin.json", rows)
    log(f"  融資維持率: +{len(rows)} (total rows {len(out)})")


def apply_twse_volume():
    """加權指數日 K 的 v 改成證交所上市成交金額（億元）；證交所尚未公布的日期留空。"""
    amt = {r["d"]: r["amt"] for r in load("turnover.json")}
    rows = load("index_TWII.json")
    if not rows or not amt:
        return
    for r in rows:
        r["v"] = amt.get(r["d"])
    save("index_TWII.json", rows)
    log(f"  加權指數成交金額: {sum(1 for r in rows if r['v'] is not None)}/{len(rows)} 日")


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true", help="回補過去一年")
    ap.add_argument("--only", default="", help="逗號分隔: indices,cnn,vix,vixus,pcr,futures,turnover,inst,margin,mr")
    a = ap.parse_args()
    only = set(filter(None, a.only.split(",")))
    want = lambda k: not only or k in only
    errors = []

    def run(k, fn, *args):
        if not want(k):
            return None
        log(f"[{k}]")
        try:
            return fn(*args)
        except Exception as e:  # 單一來源失敗不影響其他來源
            errors.append(f"{k}: {e}")
            log(f"  !! {k} failed: {e}")
            return None

    run("indices", fetch_indices, a.backfill)
    run("cnn", fetch_cnn, a.backfill)
    run("vix", fetch_vix, a.backfill)
    run("vixus", fetch_vix_us, a.backfill)
    run("pcr", fetch_pcr, a.backfill)
    dates = run("futures", fetch_futures, a.backfill) or [r["d"] for r in load("futures_oi.json")]
    # 例行模式只檢查最近 10 個交易日是否有缺；回補模式檢查全部
    dates = dates if a.backfill else dates[-10:]
    # 今天若是平日，期交所資料還沒出來時也要試抓現貨盤後資料
    today = dt.datetime.now(TW).date()
    if today.weekday() < 5 and today.isoformat() not in dates:
        dates = dates + [today.isoformat()]
    run("turnover", fetch_turnover, a.backfill)
    if want("turnover") or want("indices"):
        try:
            apply_twse_volume()
        except Exception as e:
            errors.append(f"twii_volume: {e}")
            log(f"  !! twii_volume failed: {e}")
    run("inst", fetch_institutional, dates)
    run("margin", fetch_margin, dates)
    run("mr", fetch_maintenance, dates)

    meta = load("meta.json", {})
    meta["updated"] = dt.datetime.now(TW).strftime("%Y-%m-%d %H:%M")
    meta["errors"] = errors
    save("meta.json", meta)
    if errors and len(errors) >= 5:
        sys.exit(1)


if __name__ == "__main__":
    main()
