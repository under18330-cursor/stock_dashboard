#!/usr/bin/env python3
"""由 data/ 內的原始資料產生：
  - data/twn_fear.json   自編台股恐懼貪婪指數（0=極度恐懼, 100=極度貪婪）
  - data/summary.json    前台重點數字
  - data/commentary.json 市場短評（有 ANTHROPIC_API_KEY 時由 Claude 撰寫，否則用規則產生）
  - data/commentary_log.json 短評歷史紀錄
"""
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import INDICES, TW, load, save, merge_rows, log  # noqa: E402

MODEL = os.environ.get("COMMENTARY_MODEL", "claude-opus-5-5")


# ---------- helpers ----------
def pct_rank(window, x):
    """x 在 window 中的百分位 (0-100)。"""
    vals = [v for v in window if v is not None]
    if len(vals) < 20 or x is None:
        return None
    below = sum(1 for v in vals if v < x)
    equal = sum(1 for v in vals if v == x)
    return 100.0 * (below + 0.5 * equal) / len(vals)


def rating(score):
    if score is None:
        return None
    if score < 25:
        return "極度恐懼"
    if score < 45:
        return "恐懼"
    if score <= 55:
        return "中性"
    if score < 75:
        return "貪婪"
    return "極度貪婪"


CNN_ZH = {"extreme fear": "極度恐懼", "fear": "恐懼", "neutral": "中性",
          "greed": "貪婪", "extreme greed": "極度貪婪"}


def chg(a, b):
    return None if a is None or not b else round((a / b - 1) * 100, 2)


def rnd(x, n=2):
    return None if x is None else round(x, n)


# ---------- 自編台股恐懼貪婪指數 ----------
def build_twn_fear():
    twii = load("index_TWII.json")
    closes = {r["d"]: r["c"] for r in twii}
    days = sorted(closes)
    vix = {r["d"]: r["vix"] for r in load("vixtwn.json")}
    pcr = {r["d"]: r.get("pc_oi") for r in load("pcr.json")}
    fut = {r["d"]: r.get("f_net") for r in load("futures_oi.json")}
    inst = {r["d"]: r.get("foreign") for r in load("institutional.json")}
    mar = {r["d"]: r.get("tse_bal") for r in load("margin.json")}

    # 原始因子（數值越大 = 越貪婪）
    raw = {k: {} for k in ("momentum", "vix", "pcr", "fut", "spot10", "margin")}
    inst_days = sorted(d for d in inst if inst[d] is not None)
    mar_days = sorted(d for d in mar if mar[d] is not None)
    for i, d in enumerate(days):
        if i >= 124:
            ma = sum(closes[x] for x in days[i - 124:i + 1]) / 125
            raw["momentum"][d] = closes[d] / ma - 1
        if d in vix:
            raw["vix"][d] = -vix[d]
        if pcr.get(d) is not None:
            raw["pcr"][d] = pcr[d]
        if fut.get(d) is not None:
            raw["fut"][d] = fut[d]
    for i, d in enumerate(inst_days):
        if i >= 9:
            raw["spot10"][d] = sum(inst[x] for x in inst_days[i - 9:i + 1])
    for i, d in enumerate(mar_days):
        if i >= 20 and mar[mar_days[i - 20]]:
            raw["margin"][d] = mar[d] / mar[mar_days[i - 20]] - 1

    names = {"momentum": "指數動能(對125日均線)", "vix": "波動率 VIXTWN", "pcr": "選擇權 P/C 未平倉比",
             "fut": "外資期貨淨未平倉", "spot10": "外資現貨近10日", "margin": "融資餘額20日變化"}
    rows = []
    for d in days[-260:]:
        comps = {}
        for k, series in raw.items():
            if d not in series:
                continue
            hist = [series[x] for x in sorted(series) if x <= d][-250:]
            p = pct_rank(hist, series[d])
            if p is not None:
                comps[k] = round(p, 1)
        if len(comps) >= 3:
            score = round(sum(comps.values()) / len(comps), 1)
            rows.append({"d": d, "score": score, "rating": rating(score), **comps})
    merge_rows("twn_fear.json", rows)
    return rows, names


# ---------- 重點摘要 ----------
def build_summary(twn_rows, names):
    s = {"generated": dt.datetime.now(TW).strftime("%Y-%m-%d %H:%M"), "indices": {}}
    intraday = load("intraday.json", {})
    for key, cfg in INDICES.items():
        rows = load(f"index_{key}.json")
        if len(rows) < 61:
            continue
        c = [r["c"] for r in rows]
        last = rows[-1]
        s["indices"][key] = {
            "name": cfg["name"], "date": last["d"], "close": last["c"],
            "price": (intraday.get(key) or {}).get("price"),
            "chg1d": chg(c[-1], c[-2]), "chg5d": chg(c[-1], c[-6]), "chg20d": chg(c[-1], c[-21]),
            "vs_ma20": chg(c[-1], sum(c[-20:]) / 20), "vs_ma60": chg(c[-1], sum(c[-60:]) / 60),
            "high_250d": max(r["h"] for r in rows[-250:]), "low_250d": min(r["l"] for r in rows[-250:]),
        }

    to = load("turnover.json")
    if len(to) >= 21:
        a = [r["amt"] for r in to]
        s["turnover"] = {"date": to[-1]["d"], "amt": a[-1], "prev": a[-2],
                         "avg5": rnd(sum(a[-5:]) / 5), "avg20": rnd(sum(a[-20:]) / 20),
                         "vs_avg20": chg(a[-1], sum(a[-20:]) / 20)}

    inst = load("institutional.json")
    if inst:
        last = inst[-1]
        f = [r.get("foreign") or 0 for r in inst]
        streak, sign = 0, (f[-1] > 0) - (f[-1] < 0)
        for v in reversed(f):
            if sign and ((v > 0) - (v < 0)) == sign:
                streak += 1
            else:
                break
        s["institutional"] = {
            "date": last["d"], "foreign": last.get("foreign"), "trust": last.get("trust"),
            "dealer": last.get("dealer"), "total": last.get("total"),
            "foreign_10d": rnd(sum(f[-10:])), "foreign_5d": rnd(sum(f[-5:])),
            "foreign_20d": rnd(sum(f[-20:])),
            "trust_10d": rnd(sum((r.get("trust") or 0) for r in inst[-10:])),
            "foreign_streak": streak * sign,
        }

    fut = load("futures_oi.json")
    if len(fut) >= 6:
        n = [r.get("f_net") for r in fut]
        s["futures"] = {"date": fut[-1]["d"], "foreign_net": n[-1], "chg1d": n[-1] - n[-2],
                        "chg5d": n[-1] - n[-6], "foreign_long": fut[-1].get("f_long"),
                        "foreign_short": fut[-1].get("f_short"),
                        "trust_net": fut[-1].get("t_net"), "dealer_net": fut[-1].get("d_net"),
                        "pct_rank_1y": rnd(pct_rank(n[-250:], n[-1]), 0)}

    mar = [r for r in load("margin.json") if r.get("tse_bal") is not None]
    if len(mar) >= 6:
        m = mar[-1]

        def side(p):
            if m.get(f"{p}_bal") is None:
                return None
            prev5 = mar[-6].get(f"{p}_bal")
            return {"buy": m.get(f"{p}_buy"), "sell": m.get(f"{p}_sell"), "redeem": m.get(f"{p}_redeem"),
                    "bal": m[f"{p}_bal"], "chg": m[f"{p}_bal"] - (m.get(f"{p}_prev") or m[f"{p}_bal"]),
                    "chg5d": None if prev5 is None else m[f"{p}_bal"] - prev5,
                    "amt": m.get(f"{p}_amt"), "mr": m.get(f"{p}_mr"),
                    "mr_prev": mar[-2].get(f"{p}_mr"),
                    "amt_chg": rnd((m.get(f"{p}_amt") or 0) - (m.get(f"{p}_amt_prev") or 0))}
        s["margin"] = {"date": m["d"], "tse": side("tse"), "otc": side("otc")}

    cnn = load("cnn_now.json", {})
    if cnn:
        s["cnn"] = {**{k: cnn.get(k) for k in ("score", "previous_close", "previous_1_week",
                                              "previous_1_month", "previous_1_year")},
                    "rating": CNN_ZH.get(cnn.get("rating"), cnn.get("rating")),
                    "date": (cnn.get("timestamp") or "")[:10]}
    vu = load("vix_us.json")
    if len(vu) >= 6:
        v1y = [r["vix"] for r in vu[-250:]]
        s["vix_us"] = {"date": vu[-1]["d"], "value": vu[-1]["vix"],
                       "chg1d": rnd(vu[-1]["vix"] - vu[-2]["vix"]),
                       "chg5d": rnd(vu[-1]["vix"] - vu[-6]["vix"]),
                       "high_1y": max(v1y), "low_1y": min(v1y),
                       "pct_rank_1y": rnd(pct_rank(v1y, vu[-1]["vix"]), 0)}
    vix = load("vixtwn.json")
    if len(vix) >= 6:
        s["vixtwn"] = {"date": vix[-1]["d"], "value": vix[-1]["vix"],
                       "chg1d": rnd(vix[-1]["vix"] - vix[-2]["vix"]),
                       "chg5d": rnd(vix[-1]["vix"] - vix[-6]["vix"])}
    pcr = load("pcr.json")
    if pcr:
        s["pcr"] = pcr[-1]
    if twn_rows:
        t = twn_rows[-1]
        s["twn_fear"] = {"date": t["d"], "score": t["score"], "rating": t["rating"],
                         "prev": twn_rows[-2]["score"] if len(twn_rows) > 1 else None,
                         "week_ago": twn_rows[-6]["score"] if len(twn_rows) > 5 else None,
                         "components": {names[k]: v for k, v in t.items() if k in names}}
    yu = build_yu(s)
    if yu:
        s["yu"] = yu
    save("summary.json", s)
    return s


# ---------- 游庭澔邏輯模擬 ----------
# 依 data/yu/rules.json 整理的規則，用現有資料模擬他的判讀；KD 參數 (9,3,3) 為假設值。
YU_MARKETS = {"TWII": ("台股", "twii_pct", 30), "SOX": ("費半", "soxx_pct", 55)}
YU_J_BUY, YU_J_STOP, YU_CNN_BUY, YU_CNN_PANIC, YU_CNN_STOP, YU_MR, YU_STEP = 25, 100, 40, 20, 75, 155, 5


def weekly_j(rows):
    """日 K 併成週 K 算 KD(9,3,3) 的 J 值；每個交易日回傳「當週截至該日」的 J，週末值即正式週 J。"""
    out, weeks, k0, d0, k1, d1 = [], [], 50.0, 50.0, 50.0, 50.0
    for r in rows:
        day = dt.date.fromisoformat(r["d"])
        key = day - dt.timedelta(days=day.weekday())
        if not weeks or weeks[-1]["k"] != key:
            k0, d0 = k1, d1
            weeks.append({"k": key, "h": r["h"], "l": r["l"]})
        else:
            weeks[-1]["h"] = max(weeks[-1]["h"], r["h"])
            weeks[-1]["l"] = min(weeks[-1]["l"], r["l"])
        hh = max(w["h"] for w in weeks[-9:])
        ll = min(w["l"] for w in weeks[-9:])
        rsv = (r["c"] - ll) / (hh - ll) * 100 if hh > ll else 50.0
        k1 = k0 * 2 / 3 + rsv / 3
        d1 = d0 * 2 / 3 + k1 / 3
        out.append({"d": r["d"], "j": round(3 * k1 - 2 * d1, 1), "week": key.isoformat()})
    return out


def build_yu(s):
    rules = load("yu/rules.json", {})
    targets = {}
    for r in rules.get("rules", []):
        if r.get("id") == "size_target":
            targets = r.get("thresholds") or {}
    cnn = (s.get("cnn") or {}).get("score")
    mr = ((s.get("margin") or {}).get("tse") or {}).get("mr")
    yu = {"cnn": cnn, "mr": mr, "markets": {}, "signals": []}
    order = {"red": 3, "green": 2, "yellow": 1, "gray": 0}
    for key, (name, tkey, tdef) in YU_MARKETS.items():
        rows = load(f"index_{key}.json")
        if len(rows) < 60:
            continue
        js = weekly_j(rows)
        j = js[-1]["j"]
        prev = [x["j"] for x in js if x["week"] != js[-1]["week"]]
        win = rows[-250:]
        hi = max(win, key=lambda r: r["c"])          # 近一年收盤高點
        since = [r for r in win if r["d"] >= hi["d"]]
        lo = min(since, key=lambda r: r["c"])        # 高點以來收盤低點
        close = rows[-1]["c"]
        dd = (close / hi["c"] - 1) * 100
        max_dd = (lo["c"] / hi["c"] - 1) * 100
        step, max_step = int(-dd // YU_STEP), int(-max_dd // YU_STEP)
        target = targets.get(tkey) or tdef
        zone = j < YU_J_BUY and cnn is not None and cnn < YU_CNN_BUY
        if j > YU_J_STOP or (cnn is not None and cnn > YU_CNN_STOP):
            light, verdict = "red", "停止買入，股市創高就調節、讓現金回升"
        elif zone and step >= 1 and step >= max_step:
            light, verdict = "green", f"可進場：跌幅達第 {step} 個 5% 級距，依跌幅分批加碼"
        elif zone and step >= 1:
            light, verdict = "yellow", f"買進區但已自低點反彈，不追價；收盤跌破前低 {lo['c']:,.0f} 再加碼"
        elif j < YU_J_BUY:
            light, verdict = "yellow", "週乖離到位但情緒或跌幅未確認，只小量"
        else:
            light, verdict = "gray", "未到週乖離買點，觀望"
        yu["markets"][key] = {
            "name": name, "date": rows[-1]["d"], "close": close, "j": j, "j_prev": prev[-1] if prev else None,
            "high": hi["c"], "high_date": hi["d"], "low": lo["c"], "low_date": lo["d"],
            "dd": round(dd, 1), "max_dd": round(max_dd, 1), "step": step, "max_step": max_step,
            "target": target, "progress": round(min(100, -dd / target * 100)) if target else None,
            "light": light, "verdict": verdict}
        yu["signals"].append({"label": f"{name}週 J 值", "value": f"{j:.1f}", "rule": f"< {YU_J_BUY} 買點／> {YU_J_STOP} 停買",
                              "state": "hit" if j < YU_J_BUY else "stop" if j > YU_J_STOP else "off"})
        yu["signals"].append({"label": f"{name}自高點跌幅", "value": f"{dd:.1f}%",
                              "rule": f"每 5% 加碼一次，第 {step} 級／目標 {target}%",
                              "state": "hit" if step >= 1 else "off"})
    if not yu["markets"]:
        return None
    if cnn is not None:
        yu["signals"].append({"label": "CNN 恐懼貪婪", "value": f"{cnn:.0f}", "rule": f"< {YU_CNN_BUY} 可佈建／< {YU_CNN_PANIC} 極度恐慌／> {YU_CNN_STOP} 貪婪",
                              "state": "hit" if cnn < YU_CNN_BUY else "stop" if cnn > YU_CNN_STOP else "off"})
    if mr is not None:
        yu["signals"].append({"label": "台股融資維持率", "value": f"{mr:.1f}%", "rule": f"接近 150%（≤ {YU_MR}%）為恐慌確認",
                              "state": "hit" if mr <= YU_MR else "off"})
    best = max(yu["markets"].values(), key=lambda m: order[m["light"]] if m["light"] != "red" else -1)
    reds = [m for m in yu["markets"].values() if m["light"] == "red"]
    yu["light"] = "red" if len(reds) == len(yu["markets"]) else best["light"]
    yu["can_enter"] = [m["name"] for m in yu["markets"].values() if m["light"] == "green"]
    yu["verdict"] = {"green": "可進場（" + "、".join(yu["can_enter"]) + "）", "yellow": "買進區，等訊號確認",
                     "gray": "觀望", "red": "停止買入"}[yu["light"]]
    yu["hits"] = sum(1 for x in yu["signals"] if x["state"] == "hit")
    return yu


def yu_text(yu):
    """規則式的游庭澔邏輯判讀（AI 未提供時使用）。"""
    if not yu:
        return ""
    parts = []
    for m in yu["markets"].values():
        parts.append(f"{m['name']}週 J 值 {m['j']:.1f}、自高點 {m['dd']:.1f}%（第 {m['step']} 個 5% 級距，目標 {m['target']}%）→ {m['verdict']}")
    tail = []
    if yu.get("cnn") is not None:
        c = yu["cnn"]
        tail.append(f"CNN {c:.0f}" + ("，極度恐慌" if c < YU_CNN_PANIC else "，低於 40 情緒確認" if c < YU_CNN_BUY
                                       else "，偏貪婪" if c > YU_CNN_STOP else "，情緒未到佈建區"))
    if yu.get("mr") is not None:
        tail.append(f"融資維持率 {yu['mr']:.1f}%" + ("，接近 150% 恐慌水位" if yu["mr"] <= YU_MR else "，未到 150% 恐慌水位"))
    return "【游庭澔邏輯】" + "；".join(parts) + "。" + "；".join(tail) + "。"


# ---------- 短評 ----------
def sgn(x, unit=""):
    return "—" if x is None else f"{x:+,.2f}{unit}" if isinstance(x, float) else f"{x:+,}{unit}"


def rule_based(s):
    """沒有 API 金鑰時的規則式短評。"""
    out = []
    tw = s["indices"].get("TWII")
    to, inst, fut, mar = s.get("turnover"), s.get("institutional"), s.get("futures"), s.get("margin")
    score = 0
    if tw:
        trend = "位於月線之上" if (tw["vs_ma20"] or 0) >= 0 else "位於月線之下"
        out.append(f"【盤勢】加權指數收 {tw['close']:,.0f}（{sgn(tw['chg1d'], '%')}），近5日 {sgn(tw['chg5d'], '%')}，"
                   f"{trend}（乖離 {sgn(tw['vs_ma20'], '%')}）。"
                   + "；".join(f"{v['name']} {sgn(v['chg1d'], '%')}" for k, v in s["indices"].items() if k != "TWII") + "。")
        score += (tw["vs_ma20"] or 0) > 0
        score -= (tw["vs_ma20"] or 0) < 0
    if to:
        lvl = "放量" if to["vs_avg20"] > 10 else "量縮" if to["vs_avg20"] < -10 else "量能持平"
        out.append(f"【量能】上市成交 {to['amt']:,.0f} 億，較20日均量 {sgn(to['vs_avg20'], '%')}，屬{lvl}。")
    if inst:
        st = inst["foreign_streak"]
        streak = f"，連{abs(st)}日{'買超' if st > 0 else '賣超'}" if abs(st) >= 2 else ""
        out.append(f"【法人】外資 {sgn(inst['foreign'], ' 億')}{streak}、投信 {sgn(inst['trust'], ' 億')}、"
                   f"自營 {sgn(inst['dealer'], ' 億')}；外資近10日合計 {sgn(inst['foreign_10d'], ' 億')}。")
        score += (inst["foreign_10d"] or 0) > 0
        score -= (inst["foreign_10d"] or 0) < 0
    if fut:
        side = "淨多單" if fut["foreign_net"] > 0 else "淨空單"
        move = "空單增加/多單減少" if fut["chg1d"] < 0 else "空單回補/多單增加"
        out.append(f"【期貨】外資台指期{side} {abs(fut['foreign_net']):,} 口（日變動 {sgn(fut['chg1d'], ' 口')}，{move}），"
                   f"位於近一年第 {fut['pct_rank_1y']:.0f} 百分位。")
        score += fut["chg5d"] > 0
        score -= fut["chg5d"] < 0
    if mar and mar.get("tse"):
        t, o = mar["tse"], mar.get("otc")
        txt = f"【融資】上市融資 {sgn(t['chg'], ' 張')}，餘額 {t['bal']:,} 張（{t['amt']:,.0f} 億）"
        if o:
            txt += f"；上櫃 {sgn(o['chg'], ' 張')}，餘額 {o['bal']:,} 張"
        if t.get("mr"):
            txt += f"。融資維持率上市 {t['mr']:.1f}%" + (f"、上櫃 {o['mr']:.1f}%" if o and o.get("mr") else "")
            if t["mr"] < 140:
                txt += "，已接近 130% 追繳線，留意斷頭賣壓"
        hint = ""
        if tw and (tw["chg1d"] or 0) < 0 and t["chg"] > 0:
            hint = "。指數下跌但融資增加，散戶逢低承接，籌碼偏不安定"
        elif tw and (tw["chg1d"] or 0) > 0 and t["chg"] < 0:
            hint = "。指數上漲而融資減少，籌碼趨於安定"
        out.append(txt + hint + "。")
    mood = []
    if s.get("twn_fear"):
        mood.append(f"台股恐懼貪婪指數 {s['twn_fear']['score']:.0f}（{s['twn_fear']['rating']}）")
    if s.get("vix_us"):
        mood.append(f"美股 VIX {s['vix_us']['value']:.1f}（{sgn(s['vix_us']['chg1d'])}）")
    if s.get("vixtwn"):
        mood.append(f"VIXTWN {s['vixtwn']['value']:.1f}（{sgn(s['vixtwn']['chg1d'])}）")
    if s.get("cnn"):
        mood.append(f"CNN 恐懼貪婪 {s['cnn']['score']:.0f}（{s['cnn']['rating']}）")
    if mood:
        out.append("【情緒】" + "、".join(mood) + "。")
    view = "偏多" if score >= 2 else "偏空" if score <= -2 else "多空拉鋸"
    headline = f"綜合研判：籌碼與趨勢訊號{view}。"
    return headline, "\n".join(out)


SYSTEM = """你是台股盤勢分析師，為一位每天早上開盤前與下午收盤後查看儀表板的投資人撰寫短評。
依據提供的 JSON 數據（指數、成交量能、三大法人、外資期貨未平倉、融資、恐懼貪婪指數）寫出繁體中文短評。

輸出格式（純文字，不要 Markdown 符號）：
第一行：一句話總結目前市場量能動向與氣氛（30 字內）。
接著 4 到 5 段，每段以【量能】【法人籌碼】【期貨】【融資】【情緒】【留意】這類標籤開頭，每段 1 至 2 句。

要求：
- 只使用資料中的數字，不要編造資料裡沒有的事件或新聞。
- 重點是解讀數字之間的關係（例如價漲量縮、外資現貨買超但期貨空單增加、指數跌而融資增），不要只複述數字。
- 金額單位為億元新台幣，期貨為口，融資為張；mr 為大盤融資維持率(%)，低於 130% 會被追繳，越接近代表斷頭賣壓風險越高。
- 語氣中性精簡，前面各段總長 250 字左右。這是資訊整理，不是投資建議，不要給買賣指令。

最後另起一段，以【游庭澔邏輯】開頭，80 至 120 字，模擬財經作者游庭澔的資產配置邏輯會怎麼判讀 JSON 裡的 yu 欄位：
- 他的邏輯：景氣位階決定下多重；週 KD 的 J 值（週乖離）低於 25 是中期回調買點、高於 100 停止買入讓獲利奔跑；
  CNN 恐懼貪婪低於 40 可佈建、低於 20 極度恐慌、高於 75 偏貪婪；台股融資維持率接近 150% 是恐慌確認；
  買法是自高點每跌 5% 加碼一次並預設現金投完的目標跌幅（yu.markets 的 target）；反彈後不追價，等跌破前低再加碼；
  現金用完才賣短債，再來才是質押或正 2；主力看費半與那斯達克，台股為輔。
- yu.markets 各市場的 light 與 verdict 是程式依上述規則算好的結論（green 可進場、yellow 買進區但等確認、gray 觀望、red 停止買入），
  請照這個結論解讀並說明是哪些指標支持，不要自行改判；景氣燈號、PMI 等資料裡沒有的指標不要提。
- 這一段是邏輯模擬，請用「依其邏輯」這類說法，不要寫成他本人的發言。"""


def ai_comment(s):
    """用 Claude 撰寫短評；沒有金鑰或呼叫失敗時回傳 None。"""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        log("  anthropic SDK 未安裝，改用規則式短評")
        return None
    client = anthropic.Anthropic()
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",  # 主模型拒答時由伺服器自動改用備援模型
            system=SYSTEM,
            messages=[{"role": "user", "content": "今日數據如下：\n" + json.dumps(s, ensure_ascii=False)}],
        )
    except anthropic.AuthenticationError as e:
        log(f"  Claude API 金鑰無效: {e}")
        return None
    except anthropic.RateLimitError as e:
        log(f"  Claude API 流量限制: {e}")
        return None
    except anthropic.APIStatusError as e:
        log(f"  Claude API 錯誤 {e.status_code}: {e}")
        return None
    except anthropic.APIConnectionError as e:
        log(f"  Claude API 連線失敗: {e}")
        return None
    if resp.stop_reason == "refusal":
        log("  Claude 拒絕回應，改用規則式短評")
        return None
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if not text:
        return None
    head, _, body = text.partition("\n")
    return head.strip(), body.strip(), resp.model


def main():
    twn_rows, names = build_twn_fear()
    s = build_summary(twn_rows, names)
    ai = None if "--no-ai" in sys.argv else ai_comment(s)
    if ai:
        headline, body, model = ai
        source = f"Claude ({model})"
    else:
        headline, body = rule_based(s)
        source = "rule-based"
    # 【游庭澔邏輯】獨立成欄位，前台另外呈現；AI 沒寫時用規則式補上
    keep, yu_par = [], ""
    for line in body.split("\n"):
        if line.strip().startswith("【游庭澔邏輯】"):
            yu_par = line.strip()
        else:
            keep.append(line)
    body = "\n".join(keep).strip()
    yu_par = yu_par or yu_text(s.get("yu"))
    now = dt.datetime.now(TW)
    c = {"generated": now.strftime("%Y-%m-%d %H:%M"), "source": source,
         "headline": headline, "body": body}
    if yu_par:
        c["yu"] = yu_par
    save("commentary.json", c)
    # 歷史紀錄：每天上午/下午各留一筆
    slot = now.strftime("%Y-%m-%d ") + ("AM" if now.hour < 12 else "PM")
    merge_rows("commentary_log.json", [{"d": slot, **c}])
    log(f"[analyze] twn_fear={s.get('twn_fear', {}).get('score')} commentary={source}")
    print(headline + "\n" + body + ("\n" + yu_par if yu_par else ""))


if __name__ == "__main__":
    main()
