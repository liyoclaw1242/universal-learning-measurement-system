# ULMS Education Spike v2 — Learning Report

**Date:** 2026-04-22
**Spike location:** `spike/` (throwaway)
**Spike cost:** ~$3.7 (well under $20 budget)
**Predecessor:** [v1 Feasibility Spike](./spike_learnings.md) — 技術可行性驗證

---

## 摘要

**假設：方法論 skill（零領域知識）+ 使用者教材 + 使用者維度，能否對任何領域產出可用題目？**

**Spike 結果：部分成立 — 有條件地成立**

- **方法論的 domain-agnostic 核心站得住**：跨 Rust（技術）和經濟學（非技術）兩個性質截然不同的領域，**同一組 4 個 SKILL.md** 都能產出 production-grade 題目，**無需為領域客製化**
- **但 `domain_guidance` 不是可選，是架構 load-bearing 部分**：無 guidance 時品質在 0.75 邊際、有 2–3 題 needs_revision；加 lightweight guidance（4–5 行偏好敘述）後兩領域都推到 0.80+、全 accept
- **對正式版的建議**：保留 domain-agnostic 架構，但把 `domain_guidance` 從「可選」升級為「強建議輸入」或於 skill 層級實作「無 guidance 時保守模式」分支；並補兩條 Agent 4 的方法論檢查（stem 素材驗證、選項長度差距）

---

## 兩個 Test Case 的結果

### Rust（TC1）

**教材**：The Rust Book §4.1 "What Is Ownership?"（至 Move 概念說明結束）— ~16K chars
**維度**：`ownership_concept` / `memory_model` / `code_prediction` / `scope_reasoning` — 4 dims
**題型分布**：mc_single 0.5 / fill 0.3 / ordering 0.2，6 題

| 輪次         | accept | needs_revision | 平均 quality | 鐵律違反 |
| ------------ | -----: | -------------: | -----------: | -------: |
| R1 no-guide  |      4 |              2 |         0.75 |    B ×1  |
| R2 with-guide|      6 |              0 |         0.82 |        0 |

**R1 關鍵缺陷**：item_003 Agent 3 在程式碼範例中加入了教材原本沒有的 `println!("{s}")` 外層行 — 違反鐵律 B（內容只源自教材）。加 guidance 後此類自編完全消失。

### 經濟學（TC2）

**教材**：OpenStax Principles of Economics §1.1 "What Is Economics, and Why Is It Important?" — ~9K chars
**維度**：`core_concept` / `tradeoff_reasoning` / `scenario_analysis` / `system_thinking` — 4 dims（刻意同構於 Rust 4 dims 的認知層級）
**題型分布**：同 Rust

| 輪次         | accept | needs_revision | 平均 quality | 鐵律違反 |
| ------------ | -----: | -------------: | -----------: | -------: |
| R1 no-guide  |      3 |              3 |         0.755|        0 |
| R2 with-guide|      6 |              0 |         0.808|        0 |

**R1 關鍵缺陷**：item_003 使用 cloze 模板「___ 是有限的，而 ___ 似乎無限」，模板結構本身洩漏答案形式；item_004 的構念效度失敗（題幹中「資源不足」與答案「稀缺性」為語義同義詞）。加 guidance 後消失。

### 跨領域比較（最關鍵對照）

| 指標                     | Rust R1 | Rust R2 | Econ R1 | Econ R2 |
| ------------------------ | ------: | ------: | ------: | ------: |
| 平均 quality             |    0.75 |    0.82 |   0.755 |   0.808 |
| accept                   |       4 |       6 |       3 |       6 |
| needs_revision           |       2 |       0 |       3 |       0 |
| guidance Δ               |       — |   +0.07 |       — |  +0.053 |

**兩領域、同一組 skill、同一個改善幅度、同一個落地點** — 這是方法論可泛化的直接證據。

---

## 4 個 Agent 的表現

### Agent 1 — Extractor（8.5 / 10）

**強項**：
- Smoke test 獨立驗證 10 KUs 全部帶 `source_excerpt`（原文摘錄），4 個 misconception 全部帶 `evidence_from_material`
- 跨四輪下游 items 都能追溯回合理的 KU，暗示 KU 的顆粒度與覆蓋度合宜
- 鐵律 A/B/C 三條全部遵守，是四個 agent 中最穩定的

**弱項**：
- Log entry 的 `at` 時戳曾填通用值 `2026-04-22T00:00:00Z` 而非實際當下時間（minor，不影響功能）

### Agent 2 — Mapper（7.5 / 10）

**強項**：
- 四輪 items 的難度分布、題型分布都符合 `assessment_params` 要求
- 下游 items 的 KU 覆蓋合理，沒觀察到孤兒維度或無對應 KU 的情況

**弱項**：
- `health_warnings` 欄位在四輪中**沒看到被主動觸發**過 — 可能（a）輸入真的沒問題、（b）agent 判斷閾值偏寬。從 Rust/Econ 的 assessment_params 含有 `ordering: 0.2`（對兩個領域都略勉強）來看，(b) 更可能。Agent 2 的 sanity check 可能過度保守

### Agent 3 — Designer（6.5 / 10）

**強項**：
- 有 guidance 時表現優異（Rust R2 item_003 的 Copy/Move 雙對照設計、Econ R2 item_004 的因果鏈排序）
- 題型選擇會參考 KU 的 `testable_aspects`，不是硬套統一題型

**弱項（關鍵）**：
- **最吃上游輸入品質的 agent**。無 guidance 時會退化：
  - 技術領域 → 自編程式碼填補素材不足（Rust R1 item_003 違反鐵律 B）
  - 非技術領域 → 套用明顯線索的 cloze 模板（Econ R1 item_003）
- 選項長度控制不佳 — 正確選項往往最長，四輪反覆出現（Rust R1 item_001、Rust R2 item_001、Econ R2 item_001、item_003）

### Agent 4 — Reviewer（7 / 10）

**強項**：
- 構念效度的兩個思想實驗（「不懂 KU 但會讀題能答對嗎？」「懂 KU 但不熟情境會答錯嗎？」）真的在運作 — 抓到 Econ R1 item_004 的語義同義 bug
- Agent 4 在 Econ 比 Rust 更細緻（每題多條 concern 分層，用「輕微」標記次要問題並放行）

**弱項（兩個明確可補的洞）**：
1. **沒有「stem 素材是否逐字出現在 `user_input.material.content`」的檢查** → Rust R1 item_003 的自編程式碼由 designer 過關而非 reviewer 攔下
2. **沒有「選項之間長度最大差距」檢查** → 四輪反覆出現的 option-length bypass 都被放過（R1 Rust item_001、R2 Rust item_001、Econ R2 item_001 等）
3. **Verdict threshold 偶爾偏鬆** — Econ R1 item_005 已明確標註 bypass ✗ 仍 accept（quality 0.75）

這兩條補丁都是**領域無關的方法論強化**，不破壞鐵律。

---

## 鐵律違反觀察（四輪總計 24 items）

| 鐵律                       | 違反次數 | 事件 |
| -------------------------- | -------: | ---- |
| A（不假裝懂領域）          |    **0** | 四輪 24 items 全部乾淨。即使面對 Rust 和經濟學這兩個 Claude 訓練資料明顯很強的主題，agents 也沒有從訓練資料補教材沒提的內容 |
| B（內容只源自教材）        |    **1** | Rust R1 item_003 agent 3 在程式碼範例加入教材不存在的 `println!("{s}")` 行 |
| C（迷思要有教材證據）      |    **0** | 觀察到的 misconceptions 都帶 `evidence_from_material` 指向教材原句 |

**鐵律 A = 0 是這個 Spike 最強的發現。** 這反駁了「LLM 做 domain-agnostic 會不自覺補課」的常見擔心。Claude Haiku 配合這套 skill 的嚴格語言（"stop. 把它從輸出中刪除"）的確能自律不補。

---

## 失敗歸因（A 類 / B 類）

- **A 類（系統責任 — 方法論本身的問題）：主要**
  - 無 guidance 時的 designer 退化（Rust R1 item_003 鐵律 B、Econ R1 item_003 模板洩漏、item_004 構念效度）
  - Agent 4 的兩個方法論盲點（stem 素材檢查、選項長度）
  - Agent 2 health_warnings 觸發閾值偏寬
  - 占四輪所有問題件數的 **~90%**

- **B 類（使用者責任 — 輸入不足）：邊緣**
  - 可能：`item_types.ordering: 0.2` 對兩個領域都略勉強（Rust ordering 記號彆扭、Econ ordering 靠常識可排）— 但這不算失敗，只是題型配置略不合適
  - 沒觀察到「教材缺乏某個 KU 所需素材」這種純 B 類失敗

**含意**：v2 的方法論失敗幾乎都可以由**修 skill prompt 本身**解決，不需要使用者提供「更多輸入」。這對正式版的 action plan 是好消息 — 系統側有明確改進空間。

---

## 走過的死路

### 1. `node-pty` 包 `claude --print`（沿用自 v1 的教訓）

v2 規格允許我們沿用 v1 已驗證的 `child_process.spawn + stdin + stream-json` 路線。沒再嘗試 PTY。v1 的結論在 v2 仍有效：**PTY 對 `--print` workload 沒有好處，`isatty(stdin) == true` 反而讓 CLI 判斷為互動模式而卡住**。

### 2. 自然語言 skill 觸發 vs `/slash-command`

Step 0 對照實驗的直接結果：

| 觸發方式         | num_turns | cost      | duration | cache_read |
| ---------------- | --------: | --------: | -------: | ---------: |
| 自然語言 "invoke" |         3 |  $0.0171 |     4.2s |       75K |
| `/slash` 字面     |     **1** | **$0.0122** | **2.8s** |  **34K** |

**結論**：v2 prompt 一律用 `/<skill-name>` 字面 slash（透過 stdin 注入）。自然語言「please invoke」會讓 Claude 先「想」再觸發，多花 ~30% 成本、~50% 時間。

### 3. 把 prompt 當 positional 參數（首次嘗試）

執行時命中 `--add-dir <directories...>` 的 variadic arg 貪婪消耗 — positional prompt 被吃成目錄名。改回 stdin 注入（與 v1 一致）即解。

---

## 副發現

### 1. 「無 guidance 時 designer 退化」的表現型態是**領域依賴的**

- 技術領域（有程式碼可修改）→ 自編範例、違反鐵律 B
- 非技術領域（純文字）→ 套用線索式 cloze 模板、構念效度降低

**但根本原因相同**：designer 在素材不足時會「太努力幫忙」。修方法論只需一條通則（「沒 guidance 時禁止自編任何文字/程式碼/選項之外的內容」），不需要 per-domain 分支。

### 2. `cache_read_input_tokens` 在 v2 維持 75–120K 範圍

跟 v1 相似。沒隨 prompt 複雜度線性上漲 — 因為 skill 本身是按需 load（`/slash` 觸發才載入對應 SKILL.md），不是每次都全部進 system prompt。

Step 0 的對照發現：`cwd` 在 `/tmp/` 下 cache_read 降到 34K，因為避開了 `~/.claude/projects/.../memory/MEMORY.md` auto-load。正式版如果要極致省，可以考慮在**不需要 auto-memory 的 agent spawn 場景**用 `--bare` 或另設 `cwd`。

### 3. `rate_limit_event` 每個 agent 都出現（v1 同樣）

不阻塞執行，`subtype` 仍為 success。可能是 CLI 的軟配額提示。v2 沒踩到真的 block，維持觀察。

### 4. Dimension YAML 實際上是**領域專業的偷渡管道**

規格說「領域內容由使用者提供」，技術上沒破鐵律（系統不內建領域知識），但**定義出好維度本身就是領域專業工作**（例如 Rust 4 dims 的 `ownership_concept` / `memory_model` 就是地道 Rust 知識，只是從系統搬到使用者側）。

含意：ULMS 的「domain-agnostic」是**系統層級**的，不是**使用者層級**的。使用者仍需具備目標領域專業才能寫出好 dimensions 與 guidance。這不影響架構，但正式版的產品定位必須誠實說清楚 — 否則會誤導「不懂領域的人也能用」的使用者。

### 5. 鐵律 A 的「0 違反」是很強但可能被情境限制的證據

四輪都用 haiku-4.5 + 短教材（9–16K chars）+ 簡單維度。**尚未測試**更複雜場景下 agent 會不會開始鬆動：
- 更長教材（50K+ chars）
- 更模糊維度（使用者定義品質差）
- 更深領域（學術水準教材而非入門）
- 更強 model（sonnet/opus — 訓練資料印象更強，更可能「幫忙」）

正式版若要宣稱 A-class 為零，需在這些場景再驗證一輪。

---

## 帶進 ULMS 正式版的結論

### 架構層

1. **保留 domain-agnostic skill 架構** — 兩領域同一 skill 的成功是架構可行性的 definitive evidence
2. **`domain_guidance` 升級為強建議輸入（或到 skill 保守模式補）**：
   - 選 A：input UI 不設「選填」，而是引導使用者寫，若空則警告「品質可能下降 10–15%」
   - 選 B：Agent 3 skill 加一條：「若 `user_input.domain_guidance` 為 null 或空，禁止自編任何 stem 素材；嚴格只從 `material` 的 literal excerpt 提取」— 這條純方法論，不涉領域

### Agent 方法論加固（兩條新 Check 都不破鐵律）

3. **Agent 4 增加 Check 5: 素材真實性** — 每個 item 的 stem 中的程式碼區塊 / 引文字串，必須能在 `user_input.material.content` 做 substring 找到。找不到 → verdict 降一級
4. **Agent 4 增加 Check 6: 選項長度均衡** — 對選擇題，計算選項長度標準差 ÷ 平均長度。若 >0.3，標記 bypass_risk fail
5. **Agent 3 skill 明文禁止自編程式碼**：「若 slot 要求的 KU 在教材中沒有充分範例，必須在 `designer_notes` 聲明『教材素材不足』並產出最保守版本，或由 coordinator 換 slot 設計」

### 成本與工程

6. **cross-spawn cost 監控**（v1 已建議、v2 再確認） — `--max-budget-usd` 是 per-spawn，coordinator 需累加 `result.total_cost_usd` 並設 per-workflow 上限
7. **cache_read 優化先不做** — 實測 75–120K 可接受，除非未來開始跑長流程（10+ agents/run）

### 產品定位

8. **誠實宣稱 domain-agnostic 的邊界**：系統層級 domain-agnostic ≠ 使用者無需領域專業。正式版行銷文案若暗示後者是虛假宣稱。正確定位應是「幫領域專家加速建立測量工具」，不是「幫外行人做題庫」

---

## 後續行動建議

### 短期（正式版開發前）

- [ ] 照「Agent 方法論加固」1–3 條改寫 SKILL.md，再跑一輪 TC1 + TC2（各一輪即可，各 $1 內）驗證改善
- [ ] 補一個**鐵律 A 的邊界測試**：跑 Rust 教材 + 使用者故意寫得很差的 dimensions（例如只寫「難度」一個 dim），看 agent 會不會在 confusion 下開始補課
- [ ] 補一個**大教材測試**：50K chars 的真實完整章節，看 cache_read、Agent 1 的 KU 顆粒度、Agent 3 的素材使用是否仍穩定

### 中期（正式版 Phase 1 開發）

- [ ] 把 `domain_guidance` 升級為架構第一級輸入（input UI、validation、schema）
- [ ] Agent 4 的 Check 5/6 寫進正式版（同時在開發 test 裡加 regression case：一個已知 self-edit、一個已知 long-option）
- [ ] 重跑 Spike v2 的四輪驗證迴歸（確保加固沒破壞已有功能）

### 長期（看市場驗證）

- [ ] 若進入 Phase 2：**dimension YAML 的引導式撰寫工具**（使用者領域專業仍在他身上，但 UX 上引導他寫出好 dimensions — 這對產品 adoption 可能比 skill 優化更重要）
- [ ] 能力估計與作答後回饋機制（這個 Spike 完全沒碰到，留待 v2 之後）

---

## 附：Spike 階段的實際花費

| 項目 | 成本 |
| --- | --: |
| Step 0 skill 載入驗證（3 test runs） | $0.03 |
| v1 參考跑（不計入 v2）| — |
| Rust R1 no-guide | ~$1.10 |
| Rust R2 with-guide | ~$1.20 |
| Econ R1 no-guide | ~$1.20 |
| Econ R2 with-guide | ~$1.20 |
| Smoke test（agent-1 extractor）| $0.05 |
| **總計** | **~$3.78** |

遠低於 $20 預算。若要跑「加固後驗證」兩輪 + 邊界測試兩輪，再追加約 $5，整個 Spike v2 + v2.1 驗證仍可在 $10 內完成。
