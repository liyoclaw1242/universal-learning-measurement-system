# Spike Handoff — Fix chokidar watcher & investigate cost

> 給本地 Claude Code CLI 的任務單。讀完後按「要做的修正」執行、按「修完後要調查」補報告、按「驗證」確認。

## 0. 你是誰、這是什麼

你是一位在 macOS 本機運作的 Claude Code CLI。你要處理的是 ULMS 的「技術可行性驗證 spike」——**這是丟棄品，不要重構、不要加測試、不要改架構**。跑通就好。spike 的程式碼在 `spike/` 目錄下，約 400 行 JS+HTML。

專案位置（此機器上的絕對路徑，依你實際位置調整）：
- spike 本身：`<workspace>/spike/`
- 可能存在的參考專案：`/Users/liyoclaw/Projects/agent-team/supervisor/`

## 1. 當前狀態

首次執行結果：
- Agent 1 成功：14.5 s、$0.028 cost、blackboard 正確更新（`current_step: 1`、`agent_1_output` 填入）
- Agent 2、3、4 **完全沒被觸發**，UI 停在 Agent 1 完成後

完整的 Agent 1 輸出 JSON（僅供參考）：
```
duration_ms: 14491
total_cost_usd: 0.02777445
model: claude-haiku-4-5-20251001
cache_read_input_tokens: 116967   ← 這個高得不尋常
input_tokens: 529
output_tokens: 1173
```

## 2. 問題診斷

`spike/main.js` 裡的 chokidar watcher 設定：

```js
watcher = chokidar.watch(BLACKBOARD, {
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
watcher.on('change', () => { ... });
```

**Watch 一個具體檔案** 在 macOS 上遇到 atomic rename（tmp → rename 取代舊檔）時會失敗：chokidar 盯著舊 inode，新檔出現時它可能只看到 `unlink` 沒看到 `add`，`change` handler 永遠不被呼叫。Claude Code 的 Write tool 應該是用 atomic rename 策略，剛好踩到這個陷阱。

## 3. 要做的修正（只改 `spike/main.js`）

### 修改點：`startWorkflow` 裡的 watcher 初始化

**原始（約 line 190 附近）：**
```js
if (watcher) await watcher.close();
watcher = chokidar.watch(BLACKBOARD, {
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
watcher.on('change', () => {
  evaluate().catch((err) => console.error('evaluate error:', err));
});
```

**改為：**
```js
if (watcher) await watcher.close();
watcher = chokidar.watch(WORKSPACE, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
watcher.on('all', (event, filePath) => {
  if (require('path').basename(filePath) === 'blackboard.json') {
    evaluate().catch((err) => console.error('evaluate error:', err));
  }
});
```

改動說明：
- Watch 整個 `workspace/` 目錄而不是單一檔案
- 用 `'all'` 事件 catch-all（`change` / `add` / `unlink` 都接），用檔名過濾而非依賴 inode
- `ignoreInitial: true` 避免啟動瞬間的誤觸發

**不要改其他任何東西**。不要加 TypeScript。不要拆模組。不要重新命名變數。就這一塊。

## 4. 修完後要調查（報告給使用者，不要自己改 spec）

### 4a. 參考 supervisor 專案的 watcher / spawn 做法

如果 `/Users/liyoclaw/Projects/agent-team/supervisor/` 存在，用 Read + Glob 看它怎麼：
- 監聽檔案變更（用什麼庫、哪種事件模式）
- spawn 子行程（flag、env、timeout 處理）
- 協調多次 spawn 之間的狀態

**列出 3–5 個「跟 spike 不同、值得正式版借鑒」的設計選擇**，報告即可，不要套用到 spike。

### 4b. 調查成本偏高的原因

Agent 1 的 cache_read_input_tokens = 116,967，這個數字異常高。推測是 Claude Code 自動載入了：
- 全域 system prompt
- 當前目錄的 `CLAUDE.md`（auto-discovery）
- 全域 skills
- 其他 auto-context

試試加下面其中一個 flag 到 `spawnAgent` 的 `args`，重新跑一次，比對 cost 與 cache_read_input_tokens：

候選方案：
1. `--bare` —— 最激進，跳過所有自動機制（hooks / LSP / plugins / CLAUDE.md / keychain）
2. `--disable-slash-commands` —— 只禁用 skills
3. `--no-session-persistence` —— spike 已經有了，保留
4. 明確指定 `--system-prompt "You are a file-editing agent. Follow the instructions exactly."` 覆寫預設 system prompt

**實測跑 Agent 1 一次**，報告每種候選方案下的：
- `total_cost_usd`
- `cache_read_input_tokens`
- `duration_ms`
- 功能是否還正常（能不能 Read/Write blackboard）

注意：`--bare` 可能會讓 Write tool 失效（如果 tool 依賴自動載入的設定）。若失效就改選其他方案。

## 5. 驗證（fix 是否成功）

1. `cd spike && npm start`
2. 點 Start Workflow
3. **四個 agent 全部跑完**，每個 UI 步驟轉綠
4. 最終 `workspace/blackboard.json` 的 `workflow.status === "completed"`
5. `data.agent_4_output.checks_passed === true`
6. `log` 陣列有 4 筆紀錄

任何一條不滿足，不要自己 debug 深入，把症狀回報給使用者。

## 6. 絕對不要做

- 不要加 TypeScript / 不要改 `.js` 成 `.ts`
- 不要加測試框架
- 不要加額外 npm 依賴（除非 fix 需要——目前不需要）
- 不要重構 `spawnAgent` / `evaluate` / 任何既有結構
- 不要改 prompt 字串
- 不要動 `package.json` 的 dependencies
- 不要把 spike 目錄之外的檔案改掉

## 7. 報告格式（完成後給使用者看）

```
## Fix
- 修改了什麼（貼 diff 或檔名+行號）
- 跑起來了嗎？四個 agent 都綠？

## Supervisor reference
- 看了哪些檔案
- 3~5 個值得借鑒的設計選擇（條列）

## Cost investigation
- 試了哪些 flag 組合
- 每種下的 cost / cache tokens / duration
- 建議正式版用哪個組合
```

預估總時間：**30 分鐘**（fix 5 分鐘、supervisor 掃讀 10 分鐘、cost 實驗 15 分鐘）。
超過 1 小時還沒完成，停下來討論。
