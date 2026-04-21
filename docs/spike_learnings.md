# ULMS Feasibility Spike — Learning Report

**Date:** 2026-04-21
**Spike location:** `spike/` (throwaway, will be deleted)
**Commit:** `cd53479`

## 測試的假設

正式版 ULMS 的核心設計是「多段 AI 透過共享 blackboard + status 欄位做 pipeline 接力」。spike 要回答的 yes/no 問題：

> 四個 claude 實例依序讀寫同一個 `blackboard.json`，用 `current_step` 做 handoff，會不會有寫入衝突、資料遺失、或協調失敗？

## 結論：假設成立

四個 `claude --print` 一次性 spawn、依序交棒，end-to-end 正確完成：

- Agent 4 交叉驗證 Agent 1–3 的輸出全部一致（`checks_passed: true`、`agent_1_message_length: 19` 跨 agent 對帳成功）
- `log[]` 四筆按時間序完整、沒有重覆或缺漏
- Blackboard 最終狀態 `workflow.status: "completed"`、四個 slot 都填滿

Claude 的 `Write` tool 底層是 atomic rename（tmp 寫完 rename 取代舊檔），**正式版不需要 lock file 或額外 advisory 協調** — status 欄位排序 + atomic 覆寫就是充分條件。

## 實測數字（4 agents, haiku, 一次完整 run）

| agent   |      cost | duration | cache_read |
| ------- | --------: | -------: | ---------: |
| 1       |   $0.0235 |    15.8s |       123K |
| 2       |   $0.0281 |    10.9s |       117K |
| 3       |   $0.0301 |    11.2s |       117K |
| 4       |   $0.0292 |    12.3s |       117K |
| **總計** | **$0.1109** | **50.3s** |   **475K** |

每 spawn 約 $0.028、12 秒，於 production 預算內。

## 走過的死路（留個紀錄免得再踩）

### 1. chokidar 直接 watch `blackboard.json`
Claude 的 Write 是 atomic rename → 舊 inode 消失、chokidar 盯不到新檔的 `change` event。可行修法是 watch 整個 `workspace/` 目錄配 `'all'` event + 檔名過濾。**但我們最後根本沒用 file watcher** — sequential coordinator `await` spawn exit 後直接讀 blackboard 就行。

### 2. node-pty 包 `claude --print`
PTY 讓 `isatty(stdin) == true`，似乎會讓 `claude --print` 的 non-interactive 路徑混亂：process 起來了、完全沒 stdout 輸出、卡住。退回 `child_process.spawn` 後秒通。

對 short-lived `--print` workload 來說 PTY 沒有好處 — UI 要看「終端機」的需求直接把 stdout/stderr 轉送到 renderer tab 就滿足了。

### 3. 考慮過、拒絕的：supervisor 風格 PTY + interactive TUI
Supervisor (`agent-team/supervisor/src/main/supervisor.ts`) 的 PTY + 解析終端文字 + ❯ 偵測的做法，**是為了長駐自動 agent**（GitHub 輪詢永不退出）設計的。套在我們這種一次性 spawn 會：
- 丟失 stream-json 的結構化訊息
- 完成偵測要靠「❯ 第二次出現」之類的脆弱 heuristic
- cost/duration 拿不到權威數字（要從文字解析）

架構 overkill。直到有人要把 ULMS agent 改成長駐才值得重新評估。

## 值得注意的副發現

### cache_read 每次 117K
每個 fresh claude spawn 都會重載 global system prompt、auto-memory、CLAUDE.md auto-discovery、全域 skills。四個 spawn 累計 475K cache_read tokens — 單價便宜但數量級大。

正式版可試的降 cost 方案（尚未驗證）：
- **`--bare`** — 最激進，跳過 auto-memory/CLAUDE.md/hooks。可能會讓某些 tool 失效，需實測。
- **`--append-system-prompt`** / **`--system-prompt`** — 明確指定 context，不依賴自動發現。
- **長駐 session 複用 warm cache** — 一個 spawn 裡接力多個 agent 身份（改 prompt 而非重 spawn）。是架構級改動。

當前規模（4 stages × $0.11/run）不值得優化；若未來跑到 100 stages 或 1000 runs/day 再看。

### 每個 agent 都出現 `rate_limit_event`
stream-json 流裡每個 agent 都吐一筆 `rate_limit_event`，但最後都 `subtype: success`。推測是 CLI 的軟警告，不阻塞執行。若正式版遇到它真的 block，需加 exponential backoff retry。

### stream-json 是對的選擇
相較 `--output-format json`（single-shot）：
- Tool_use 事件即時進 UI（能即時看 Read/Write 進度）
- 訊息類型自然分流（system / assistant / user / result），不用自寫 parser
- `result` 訊息帶 `total_cost_usd` 和 `duration_ms` — 每 spawn 的權威指標

## 帶進 ULMS v1 的結論

1. **Coordinator 就是 `for (agent) { await spawn; check blackboard; }`** — sequential pipeline 不需要 file watcher、state machine、或 lock file
2. **Status 欄位排序是正式版的 load-bearing invariant** — 任何破壞 Write atomicity 的變更（例如改成 streaming partial write）會直接打破這個基礎，寫進 regression test
3. **Short-lived `--print` 用 `child_process.spawn` + stdin + stream-json**；`node-pty` 只在需要互動（HITL 或 TUI-only tool）時才用
4. **要做 cross-spawn cost 監控** — `--max-budget-usd` 是 per-spawn 的，不是 per-workflow。coordinator 應自己累加 `result.total_cost_usd` 並設總額上限
5. **cache_read 優化先不做** — 測過需求再動

## 後續行動

- [ ] 刪除 `spike/` 目錄
- [ ] Phase 1 計畫根據以上 5 點修訂
- [ ] 如果要降 cache_read cost，開獨立小 spike 實測 `--bare` vs `--system-prompt` 覆寫方案
