# 台股盤勢儀表板

每日開盤前、收盤後看的市場儀表板。前台是純靜態網頁（GitHub Pages），後台由 GitHub Actions 定時抓資料、累積在 `data/`，並同步到 Google Sheet。

## 前台內容（`index.html`）

| 區塊 | 內容 | 來源 |
|---|---|---|
| AI 短評 | 依下列所有數據產生的量能、籌碼、情緒解讀 | Claude API（未設金鑰時為規則式摘要） |
| 指數走勢 | 加權指數、KOSPI、道瓊、費半 K 線；1D / 5D / 1M / 1Y，可拖曳縮放 | Yahoo Finance |
| 市場情緒 | 台股恐懼貪婪指數（自編）＋ VIXTWN；CNN Fear & Greed | 期交所、CNN |
| 法人籌碼 | 三大法人買賣超、外資近 10 日合計；外資台指期淨未平倉 | 證交所 / FinMind、期交所 |
| 融資與量能 | 上市、上櫃融資買賣張數／增減／餘額、融資維持率（自行估算）；上市成交金額 | 證交所 / FinMind、櫃買中心 |

後台頁 `admin.html` 可瀏覽每個資料集全部歷史並下載 CSV。

> **台股恐懼貪婪指數**：台灣沒有官方版本，這裡是自編指數。取六個因子（指數對 125 日均線乖離、VIXTWN、選擇權 P/C 未平倉比、外資期貨淨未平倉、外資現貨近 10 日買賣超、融資餘額 20 日變化），各自換算成近一年百分位後平均，0＝極度恐懼、100＝極度貪婪。

## 啟用步驟

1. **GitHub Pages**：Settings → Pages → Source 選 *Deploy from a branch*，分支選預設分支、資料夾 `/ (root)`。
2. **Secrets**（Settings → Secrets and variables → Actions → New repository secret）
   - `FINMIND_TOKEN`：FinMind API 金鑰。有它才能一次補齊三大法人／上市融資；沒有時會改用證交所逐日查詢（較慢且容易被限流）。
   - `ANTHROPIC_API_KEY`（選用）：設定後 AI 短評由 Claude 撰寫；未設定則顯示規則式摘要。
3. **Google Sheet 後台**：打開後台試算表 → 擴充功能 → Apps Script → 貼上 [`gsheet/sync.gs`](gsheet/sync.gs) → 執行 `setup`。之後每小時自動同步。

## 更新排程（台北時間，週一至週五）

| 時間 | 做什麼 |
|---|---|
| 08:35（含週六） | 美股收盤、CNN 指數、晨間短評 |
| 09:10–13:40 每 30 分 | 盤中指數 K 線 |
| 15:10、16:40 | 三大法人、期貨未平倉、午後短評 |
| 21:40 | 融資餘額 |

排程在 `.github/workflows/update.yml`，也可在 Actions 頁手動執行（可勾選回補一年）。GitHub 排程在尖峰時段可能延遲數分鐘到數十分鐘。

## 本機執行

```bash
python scripts/fetch.py --backfill   # 首次：回補一年
python scripts/fetch.py              # 例行更新
python scripts/analyze.py            # 計算恐懼貪婪指數、摘要與短評
python -m http.server 8000           # 開 http://localhost:8000
```

抓取程式只用 Python 標準函式庫；AI 短評需要 `pip install anthropic`。

## 資料檔（`data/`）

每個檔案是以日期 `d` 為鍵的 JSON 陣列，每次更新只新增或覆寫同日期，歷史不會刪除。

`index_*.json` 日 K｜`intraday.json` 5 分／60 分 K｜`institutional.json` 三大法人（億元）｜`futures_oi.json` 台指期未平倉（口）｜`margin.json` 融資（張／億元）｜`turnover.json` 成交金額｜`vixtwn.json`｜`pcr.json`｜`cnn_fear_greed.json`｜`twn_fear.json`｜`commentary_log.json` 短評紀錄

## 已知限制

- VIXTWN 期交所只公開最近約四個月的檔案，更早的歷史無法回補，之後會逐日累積。
- 盤中 K 線非即時，約每 30 分鐘更新一次（Yahoo 資料本身也有延遲）。
- 本頁為資訊整理，非投資建議。
