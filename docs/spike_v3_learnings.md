# ULMS Education Spike v3 — Dual-Reviewer Learning Report

**Date:** 2026-04-23
**Spike location:** `spike/` (v2 code repurposed; v3 adds Gemini second-opinion path)
**Spike cost:** ~$1.85 actual / $4.80 budgeted
**Predecessors:** [v1](./spike_learnings.md) · [v2](./spike_v2_learnings.md) · [v3 spec](./spike_v3_spec.md)

---

## 摘要

**假設：用 Claude-reviewer + Gemini-reviewer 獨立雙審，能否以合理成本揭露單一 reviewer 看不到的品質訊號？**

**Spike 結果：成立 — 但 information gain 主要在 check 層級，不在 verdict 層級**

- 三個領域（星座 / 易經 / 台灣歷史）單輪夾雙審，**verdict 層級同意率 94.4%** — 純看 verdict 會誤以為 dual-reviewer 冗餘
- **Check 層級同意率卻是 domain-dependent**：星座 / 易經 check 全部 100%，**台灣歷史 bypass_risk 只 50%、ambiguity 83%**
- 反直覺的發現：**verdict 一致但 check 分歧**的情境，兩 reviewer 是從**完全不同的 check route** 得到同一結論 — 這正是 dual-reviewer 的 information gain
- Iron Law A 在**非 canonical 訓練資料強區**（星座占卜、易經、台灣本地歷史）依然 0 違反 — 加強 v2 的結論
- 對正式版的建議：**採用 dual-reviewer**，但 UI 要**暴露 check-level 分歧**給使用者（不只展示 merged verdict）

## 方法

三個與 v2 測試域（Rust / 經濟學）截然不同的領域，故意選在 Claude 與 Gemini **訓練資料強度或立場差異可能顯著**的區域：

| 領域 | 選擇理由 |
|---|---|
| 星座占卜 | 準科學 claim，兩 model hedge 態度可能不同 |
| 易經八卦 | 東亞傳統思想，Claude 可能加形上學 disclaimer |
| 國小台灣歷史（日治）| curriculum 本地化、政治語境敏感 |

**Material + Dimensions + Guidance 全由 Grok 獨立產出**（規格 §6），避開我自己寫材料會帶入的 Claude-family 偏見。每域三份 fixture 存檔於 `spike/fixtures/`。

**工作流程：**
1. 使用者載入三份輸入 → spike UI 按 Start → 跑完 Claude 的 4-agent workflow
2. 點「Run Gemini Second Opinion」→ 獨立跑 Gemini 審查（D2：spawn 前 coordinator 清掉 `data.review`，Gemini 看不到 Claude verdict）
3. Coordinator 依 D4 最嚴規則（reject > needs_revision > accept）合併 → `data.review_merged`

每域跑一輪後 blackboard 存檔於 `spike/runs/{domain}-round1.json`。

## 三域結果

| 指標 | astrology | iching | taiwan-history |
|---|---:|---:|---:|
| KU 數 | 8 | 10 | 15 |
| Items | 6 | 6 | 6 |
| **Verdict agreement** | 83% | 100% | 100% |
| accept / NR / reject（merged）| 5 / 0 / 1 | 6 / 0 / 0 | 5 / 1 / 0 |
| answer_uniqueness 一致率 | 100% | 100% | 100% |
| construct_validity 一致率 | 100% | 100% | 100% |
| ambiguity 一致率 | 100% | 100% | **83%** |
| bypass_risk 一致率 | 100% | 100% | **50%** |
| Claude avg quality | 0.78 | 0.89 | 0.74 |
| Gemini avg quality | 0.87 | 0.875 | 0.88 |
| Gemini bias vs Claude | **+0.09** | **−0.02** | **+0.14** |
| Claude workflow 成本 | $0.54 | $0.49 | $0.60 |
| Gemini 審查耗時 / tokens | 166s / 545K | 23s / 59K | 53s / 83K |

跨域總花費：Claude $1.63 + Gemini ~$0.07 + v2 dev 累計 = **~$1.85**。

## 關鍵發現

### 1. Iron Law A 在非 canonical 領域依然 0 違反

v2 spike 質疑過「鐵律 A 零違反」可能只是因為選在 Claude 訓練強區（Rust、經濟學）沒露餡。v3 三域是 Claude / Gemini 訓練覆蓋**相對薄的**主題（星座占卜、易經、台灣國小日治史），**仍然 0 違反 across 18 items × 2 reviewers = 36 審查次**。

這是鐵律 A 目前為止的**最強證據**。但注意：
- 仍是 1 輪 / 1 model 配置（haiku + flash-preview），未測更強 model
- 「沒觀察到違反」不等於「違反率真為 0」，N=36 容錯區間仍大
- 真實邊緣案例（鐵律 A 該出錯的情境）尚未建構

### 2. Check-level 與 verdict-level 是**兩種獨立的 signal**

三域 verdict 一致率 83–100% 的同時，**check 一致率在 taiwan-history 驟降**（bypass 50% / ambiguity 83%）。

具體情境：taiwan-history 有 3 題（item_001, 002, 006）**Claude 打 bypass_risk=fail**、**Gemini 打 pass**，但 overall_quality_score 仍 ≥0.7，最終兩邊都 accept。分歧 pattern **只有一類**：

- **Claude**：「懂一點歷史常識的學生可以透過『甲午戰爭在何時』推理出答案 → bypass」
- **Gemini**：「歷史常識就是這題的預期 context → pass」

這不是 noise，是**兩 model 對「背景知識算不算 domain 內部」的系統性認知差異**。

**含意：**
- 純看 verdict 會說「dual-reviewer 冗餘」
- 看 check 層級會說「dual-reviewer 揭露了單 reviewer 的盲區」
- **正式版 UI 不能只展示 merged verdict，必須展示 check 分歧**

### 3. Gemini 校準偏差是**領域依賴的**

若 Gemini 相對 Claude 是固定 offset（例如一律 +0.10），就能在正式版做 calibration normalization。但實測：

| | Gemini 校準偏差 vs Claude |
|---|---:|
| astrology | +0.09 |
| iching | **−0.02** |
| taiwan-history | +0.14 |

**Gemini 對星座與歷史偏寬、對易經幾乎對齊**。沒有恆定 offset。

推測原因：Gemini 對「文化權威性 domain」（有清楚傳統正典如易經）更謹慎；對「流行文化 domain」（星座）或「敘事型 domain」（歷史）更信任內容。這是模型氣質差，不能簡單校正。

**含意：** 正式版若要顯示「信心分數」，不能直接平均兩個 model 的 quality_score；應各自顯示、標明來源。

### 4. item_005 (taiwan-history) 是 dual-reviewer 的教科書勝出

唯一的 needs_revision — fill-in-blank 題「他們積極興建 ___ 等基礎設施」。教材列 6–7 種基礎設施類型，題目沒限定填哪組。

**兩 reviewer 獨立都抓到 answer_uniqueness 問題**、concerns 寫的也是同一件事。這種 convergent finding 是 dual-reviewer 最有價值的 signal：單邊可能過寬漏看，雙邊同 frame 抓到 = 高信度。

### 5. Gemini 耗時跨域變異 7 倍

| | Gemini 審查耗時 |
|---|---:|
| astrology | 166s（545K tokens）|
| iching | **23s** |
| taiwan-history | 53s |

差 7 倍不合理，**這是架構風險信號**。推測是 Gemini 在複雜 context 下做了更多 tool_call round-trip（每次讀 blackboard 都 ~10K tokens × 多次 = 放大）。

**含意：** 若正式版要把 Gemini 審查整合進互動 UX，**166 秒的延遲會破壞 user perception**。三種 mitigation：
- **Scoped blackboard**（architecture doc §8 V1 已提）：Gemini 只讀 `items` + `material.content`，不讀 extractor/mapper 的中間產出 → context 小 → tool_call 少 → 快
- **Async notification**：Gemini 審查後台跑，UI 通知「Gemini 意見到了」，不阻塞
- **Pin Gemini model**：flash-preview 可能被 model 版本差異影響，明確 pin `gemini-2.5-flash` 減少變因

## 走過的死路（工程坑 — 不影響結論但值得記錄）

### 1. Agent-4 metadata 污染 `data.review_claude`

**現象（iching 運行時發現）：** v3 initial blackboard schema 把 `review_claude`/`review_gemini`/`review_merged` 先設為 null。Agent 4 看到空欄**「順手」**把 reviewer 身份元資料（completed_at / reviewer / methodology）寫進 `review_claude`，**把真正的 per_item + summary 寫到 `data.review`**。Coordinator 的 rename 邏輯 `if review && !review_claude` 看到 review_claude 非空，**跳過搬移**，結果真資料卡在 `data.review`。

**修正（commit `21602d5`）：**
- 初始 schema 只暴露 `data.review`，其他三個欄位由 coordinator 後置加入 — agent 看不到就不會亂填
- Rename 邏輯改成 `if review` 無條件覆寫 — 任何情況下 data.review 都移到 data.review_claude

### 2. Gemini 的 `replace` tool 造成 duplicate JSON keys

**現象（iching Gemini second opinion 時發現）：** Gemini CLI 的 file editing tool 是**表面字串替換**（不是 Claude 的 Write atomic rewrite）。Coordinator 原本在 spawn Gemini 前設 `data.review = null`（置 null 佔位）。Gemini 的 `replace` 找到 `"data": {\n    "knowledge_units": [` 當 anchor，**在前面插入**新的 `"review": {...}, "knowledge_units": [`，**沒動到原本的 `"review": null,` 那行**。結果 blackboard 裡有**兩個 `"review"` key**。JSON.parse last-wins → 回 null → coordinator 以為 Gemini 沒寫東西。

**修正（commit `11cce02`）：**
- `beforeBoard.data.review = null` → `delete beforeBoard.data.review`
- 同理 `review_gemini` / `review_merged` 的 re-run cleanup 也改用 `delete`
- 這樣 Gemini 的 `replace` 插入的 review 是唯一一個，無 duplicate

**兩坑合體的教訓：** 當 coordinator 和 agent **修改共享檔案**時，要預期兩邊用的編輯工具語意不同（Claude atomic write / Gemini surgical replace）。正式版要麼把 blackboard 編輯**只收到 coordinator side**（agent 產出走 stdout → coordinator 解析 → coordinator 寫檔），要麼明確禁用 Gemini 的 `replace` tool、只留 `write_file`。前者更徹底。

## 副發現

### 1. Gemini CLI 的 help 文字誤導

Gemini CLI help 說「Defaults to interactive mode. Use `-p/--prompt` for non-interactive」。實測：**stdin pipe + `-o stream-json` 也能觸發 headless 模式**，不需 `-p`。這個行為沒寫在 help 裡，是隱式 dispatch。記入 `main.js` comment 避免未來踩坑。

### 2. Claude vs Gemini cost/latency profile 差異巨大

每審 6 題：
- Claude reviewer：~$0.13–0.19、~15 秒
- Gemini reviewer：~$0.01（token base）、23–166 秒

Gemini **便宜 10 倍以上**但**延遲變異大**。若正式版要 dual-reviewer，其中 Gemini 的資金成本不是瓶頸，wall-clock 才是。

### 3. Gemini 不回報 USD cost，只給 token stats

Spike v3 目前 blackboard 把 Gemini 的 cost 寫成 token 數 + 字串註記。正式版必須做 token → USD 的前端轉換（Gemini Flash Preview 約 $0.10/1M input、$0.40/1M output），才能 per-workflow 預算監控。

## 對 ULMS 正式版 Phase 1 的結論

### 架構層

1. **採用 dual-reviewer**，但 coordinator 側責任更重：
   - 預算監控跨 Claude + Gemini 累加（後者要 token-to-USD 自行換算）
   - 對 disagreement 必須顯著暴露在 UI，不能只給 merged 結果

2. **Blackboard 編輯收歸 coordinator**：正式版 agent 的產出應**走 stdout 回傳**（stream-json 裡的結構化訊息），coordinator 解析後**代寫**到 blackboard。不再讓 agent 直接 Write/replace 共享狀態 — 可以一次消除 metadata 污染與 duplicate key 兩個坑。

3. **Scoped blackboard view** 優先級上調（architecture doc §8 V1）：Gemini 延遲變異 7× 的最佳緩解就是縮 context。正式版必做，不是 optional。

### UI 層（給你做 design 時的參考）

4. **每題顯示 Claude + Gemini 雙 verdict**（當前 spike UI 已實現）再加一層：**點開可看 check-by-check 對照**
   - 四個 check 用圖示呈現（兩邊都 pass 綠色、兩邊都 fail 紅色、**分歧黃色**）
   - 分歧 check 展開時要看到雙方 concern 原文（spike 已實現這部分）

5. **Agreement dashboard** 當成評估報告的首頁：
   - Verdict agreement rate
   - Per-check agreement rate
   - 「Where the reviewers saw differently」— 高於 check 分歧閾值的題目列清單
   - 這些數字對使用者（領域專家）來說是「這批題能信多少」的 proxy

### 模型管理

6. **Pin Gemini model 版本**：flash-preview 是 moving target，行為可能季度級漂移。明確指定 `gemini-2.5-flash` 或類似穩定版。

7. **Reviewer 校準監控**：跨領域的 Gemini bias drift（+0.09 / −0.02 / +0.14）顯示 quality_score 不可跨域平均。UI 顯示兩者，**不要**做 normalize 平均。

## D3 Ground Truth（2026-04-23 補）

對 spike 中兩邊意見不一致的題目 + 兩邊 verdict 一致但有疑慮的題目，使用者做了 blind 人工判官：

| Item | Claude | Gemini | Merged | User Ground Truth | 誰最貼近 |
|---|---|---|---|---|---|
| astrology item_006 | needs_revision | reject | reject | **reject** | **Gemini** |
| taiwan-history item_005 | needs_revision | needs_revision | needs_revision | **reject** | **兩邊都太寬** |
| taiwan-history item_001（bypass check）| fail | pass | (merged accept) | **challenging** | **Claude 的 concern 合理** |
| taiwan-history item_002（bypass check）| fail | pass | (merged accept) | **challenging** | **Claude 的 concern 合理** |
| taiwan-history item_006（bypass check）| fail | pass | (merged accept) | **challenging** | **Claude 的 concern 合理** |

**解讀：**

1. **沒有哪個 reviewer 系統性更準** — 兩邊各自在不同 domain 更貼近 user：
   - 星座：Gemini 更準（C 低估了 reject 嚴重度）
   - 台灣歷史 bypass：Claude 更準（Gemini 把 domain-adjacent knowledge 誤認為 expected context）
   - taiwan-history item_005：**兩邊都過寬** — 這是 dual-reviewer 的 blind spot

2. **使用者本身的 verdict 閾值比兩個 model 都嚴**：
   - Model 傾向 accept → needs_revision
   - User 傾向 needs_revision → reject
   - 這是預期的：LLM reviewer 偏保守地給 benefit-of-doubt、user 對「放進真實考卷」的後果更在意

3. **Convergent errors 是 dual-reviewer 的結構性盲點**：item_005 兩邊 same concern、same verdict，但都太寬。dual-reviewer 對「單邊漏看」有效，對「兩邊同方向偏差」無效。

4. **taiwan-history 3 題 bypass 分歧的 final read**：user 不全盤接受 Claude 的「背景知識 = bypass」，也不全盤接受 Gemini 的「domain-adjacent = expected context」，而是標 **challenging**。含意：這些題**目前可以 accept 但出正式考卷時要注意**。這支持 v1 正式版的設計：**系統不該自動決定這類邊緣，該暴露給使用者**。

**對正式版的新增結論（從 ground truth 推出的）：**

- **User-as-final-judge 是架構必需，不是 fallback**：無論 dual-reviewer 多強，convergent errors 這類盲點還在。UI 的 verdict 展示必須明示「這是建議，不是判決」。
- **新增 UI 元素：**「flag as challenging」按鈕 — 讓使用者把邊緣案例標記出來，既不 accept 也不 reject，產出時附註警示。對應 taiwan-history 那 3 題的處理。
- **Quality score 的絕對值比相對差異更危險**：user 對 item_005（C=0.62 / G=0.65）判 reject，但對 item_006（C=0.9 / G=0.9）沒有改判 accept。這說明**0.7 accept 閾值是 model-specific calibration**，正式版不應該暴露 0–1 數字給使用者（看了反而誤判），應改為 verdict 三分類 + concern 說明。

## Limitations（誠實記錄）

- **N = 18 items × 2 reviewers = 36 審查次**。結論仍是小樣本觀察，不是量化證據。
- **單輪 per domain**。沒跑過同域多次，**run-to-run variance 未測**（spike v2 Limitations 點出的同個缺口仍在）。
- **單一 guidance 版本**。沒跑「無 guidance 版本 × dual reviewer」對照 — 無法分離「guidance 貢獻」與「dual reviewer 貢獻」。
- **Gemini 就一個 model**（2.5-flash-lite + 3-flash-preview 依據 Gemini CLI 自動分配）。Opus / Claude Sonnet 版本沒驗。
- **Ground truth 已在 2026-04-23 補齊**（見上方 §D3 Ground Truth）— 但樣本僅 5 題，僅足以揭示 convergent-error blind spot 與「誰在哪域更準」的方向性差異，不足以做統計量化。
- **Disagreement 樣本少**：三域 18 題，verdict 層級只 1 題實質分歧（astrology item_006）。check 層級有 3 題分歧（全在 taiwan-history bypass）。dual-reviewer 真正大量發揮的情境（分歧率 >15%）仍未在此 spike 中觀察到。
- **Ground truth 判官就一個（使用者）**：若要更可信的 ground truth 應由多位領域專家獨立打標再 inter-rater agreement 評估。spike 不是做這規模的場景。

## 後續行動

### 立即（下一兩天）

- [x] ~~Ground truth（D3）~~ 已完成於 2026-04-23，結果見 §D3 Ground Truth 段落
- [ ] Architecture doc §5.3 與 §6.3 的 Agent 4 Check 5/6 補丁落地（spike v2 已提）
- [ ] 寫 `ulms_v1_plan.md` — 把 v2 / v3 結論合成為 Phase 1 開發 roadmap

### 中期（Phase 1 開發前）

- [ ] Blackboard 編輯收歸 coordinator（第 2 條結論）
- [ ] Scoped blackboard view（第 3 條結論）
- [ ] Gemini cost-in-USD 前端換算表
- [ ] Gemini model version pin

### 長期（Phase 2）

- [ ] Reviewer calibration spike：同 reviewer 對同題重審 N 次、看 score variance（v2 limitation 指出的 agent-4 drift 議題）
- [ ] 三域以外領域的魯棒性驗證（尤其 claim-forward 的社會科學、高度 localize 的台灣本土知識）

## 附：Spike v1→v2→v3 累計成本

| Spike | 花費 |
|---|---:|
| v1（feasibility）| ~$0.11 |
| v2（domain-agnostic methodology）| ~$3.78 |
| v3 Step 0（Gemini CLI 驗證）| ~$0.08 |
| v3 三域 full run | ~$1.77 |
| **累計** | **~$5.74** |

從最初 $20 預算來看，三輪 spike 總花費不到 30%。剩餘預算足以再跑 v3.1（D3 ground truth 補測試）與獨立 reviewer calibration spike。
