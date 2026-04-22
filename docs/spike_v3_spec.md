# ULMS Spike v3 — Dual-Reviewer Fairness Validation

**Date:** 2026-04-22
**Status:** Spec (code ready, awaiting Grok-generated fixtures to run)
**Predecessor:** [Spike v2](./spike_v2_learnings.md) — 揭示 Agent 4 作為自己評分裁判的循環風險

---

## 1. 核心問題

> **給同一批題目，Claude-reviewer 與 Gemini-reviewer 獨立各審一次：
> (a) 兩邊的 verdict 同意率有多高？
> (b) 不同意時哪一邊更貼近人工評估？
> (c) 雙 reviewer 機制是否能在 cost 合理範圍內顯著降低單 reviewer 的 false-accept 率？**

**決策 tree：**
- 同意率 >95% → 結論「單 reviewer 夠，別燒錢」
- 同意率 70–90% → 結論「dual-reviewer 有真實資訊量，正式版採用」
- 同意率 <70% → 結論「兩 model 對方法論理解差太遠，skill 要修」

## 2. 設計決策（對話定案）

| ID | 決定 |
|---|---|
| **D1** | Claude 與 Gemini 讀**同一份** reviewer SKILL.md — 差異純粹來自 model bias，不是 prompt 偏差 |
| **D2** | 兩 reviewer **獨立審**，互不知對方存在（Gemini spawn 前 coordinator 清空 `data.review` 以免洩漏 Claude 結果）|
| **D3** | Ground truth 只標**兩 reviewer 意見不一致**的那些題，節省人工 |
| **D4** | Verdict 合併**最嚴**策略：`reject > needs_revision > accept`，任一 reviewer 說 reject 即 final reject |
| **D5** | Spike v3 **只驗 dual-reviewer agreement**，retry 機制留給 v1 Phase 1 獨立實作 |

## 3. Step 0 技術驗證結果（已完成）

Gemini CLI (`/opt/homebrew/bin/gemini` v0.37.0) 與 Claude CLI 結構驚人對稱：

| 能力 | Claude | Gemini | 結論 |
|---|---|---|---|
| Non-interactive | `--print` | `-p/--prompt` | ✓ |
| stream-json 輸出 | `--output-format stream-json` | `-o stream-json` | ✓（內部結構不同但都是 NDJSON）|
| Read tool | `Read` | `read_file`（實測 success=1）| ✓ |
| Write tool | `Write` | `write_file`（實測 success=1）| ✓ |
| Auto-approval | `--permission-mode bypassPermissions` | `-y/--yolo` | ✓ |
| 成本回報 | `total_cost_usd` | 僅 token stats | 需自己算 |
| 自動發現 `.claude/skills/` | N/A | 否 | fallback：inline 注入 |

**Go/no-go**：**GO**。Q3（Read/Write）通過 = 架構可行。Q4/Q6 有乾淨 fallback。

Step 0 成本：~$0.08。

## 4. 架構（Option C — 手動觸發）

```
┌─ Workflow 正常跑完 ────────────────────────────────┐
│ extractor → mapper → designer → agent-4 (Claude) │
│ 產出：data.review → rename to data.review_claude  │
│ UI：enable "Run Gemini Second Opinion" 按鈕        │
└────────────────────────────────────────────────────┘
                        │
         (使用者手動按下) │
                        ↓
┌─ runSecondOpinion() ──────────────────────────────┐
│ 1. 清空 data.review（D2：Gemini 不得看到 Claude）  │
│ 2. 讀 agent-4-reviewer SKILL.md，inline 為 prompt │
│ 3. spawn gemini -y -o stream-json + stdin prompt  │
│ 4. Gemini 讀 blackboard（items / KUs / mapping）   │
│    → 執行四項檢查 → 寫 data.review                 │
│ 5. rename data.review → data.review_gemini        │
│ 6. mergeReviews() 依 D4 產 data.review_merged     │
│ 7. UI 顯示：                                      │
│    - 每題 dual verdict 徽章 + 合併 verdict        │
│    - 同意/分歧小圓點                               │
│    - 雙 reviewer concerns 列出                    │
│    - 整體 agreement summary                        │
└────────────────────────────────────────────────────┘
```

**檔案落點：**
- `spike/main.js`
  - `resolveBinary(name, fallback)`, `GEMINI_BIN`
  - `loadReviewerSkillForGemini()` 讀 SKILL.md body 當 prompt
  - `spawnGeminiReviewer()` stream-json 解析（Gemini 格式）
  - `mergeReviews()` 依 D4 rank 合併
  - `runSecondOpinion()` coordinator
  - 新 IPC handlers：`review:second-opinion` / `review:stop-second-opinion`
- `spike/renderer.html`
  - 「Run Gemini Second Opinion」+「Stop Gemini」按鈕
  - `gemini (2nd opinion)` tab
  - Dual-Reviewer Agreement 摺疊區塊
- `spike/renderer.js`
  - 新事件 `gemini:started` / `gemini:pty` / `gemini:stream` / `gemini:completed`
  - `second-opinion:completed` / `second-opinion:error`
  - `renderItems()` 擴充為 merged 模式（verdict 雙欄 + agreement dot + 雙方 concerns）

## 5. Verdict Merge Table（D4 實現）

| Claude | Gemini | Merged |
|---|---|---|
| accept | accept | accept |
| accept | needs_revision | needs_revision |
| accept | reject | **reject** |
| needs_revision | accept | needs_revision |
| needs_revision | needs_revision | needs_revision |
| needs_revision | reject | **reject** |
| reject | accept | **reject** |
| reject | needs_revision | **reject** |
| reject | reject | reject |

實作於 `spike/main.js` 的 `mergeVerdict(cv, gv)`：rank accept=0, needs_revision=1, reject=2，取 max。

## 6. 三個 Test Case（使用者正在由 Grok 產出）

| 主題 | 預期挑戰 | Iron Law A 檢驗點 |
|---|---|---|
| 星座占卜 | 準科學 claim，兩 model 的 hedge 態度可能顯著不同 | Claude 是否加免責聲明 > 教材內容？ |
| 易經八卦 | 東亞傳統思想，Claude 可能想用哲學框架補完 | 會不會超出教材引入「陰陽五行通論」類訓練記憶？|
| 國小台灣歷史（日治）| Curriculum 本地化、政治敏感 | Gemini/Claude 對敘事的立場是否偏頗？ |

三域都故意選在**Claude/Gemini 訓練資料強度或立場差異可能顯著**的區域，跟 spike v2 的 Rust/經濟學（canonical 訓練資料強區）形成對照。

由 **Grok 獨立產出** material + dimensions + guidance（使用者 prompt 已發出，等待回傳），避免 Claude/我自己寫 material 帶入家族偏見。

## 7. 預期預算

| 項目 | 估計 |
|---|---|
| Step 0 技術驗證 | **$0.08**（已完成）|
| 3 domain × 1 full workflow（extractor+mapper+designer+claude reviewer）| 3 × ~$1.20 = $3.60 |
| 3 domain × 1 Gemini second opinion | 3 × ~$0.02 = $0.06 |
| 若重跑 / iteration buffer | ~$1 |
| **總計** | **~$4.8** |

Gemini Flash Preview 每次 review 僅 ~20K tokens ≈ $0.01–0.02，**cost 不是瓶頸**。

## 8. 成功標準

- ✅ Gemini 能完成 6 題的獨立審查並寫回 blackboard（`data.review_gemini`）
- ✅ Coordinator 正確合併兩 reviewer verdicts 到 `data.review_merged`
- ✅ UI 呈現雙 verdict + agreement 標示 + 雙方 concerns
- ✅ 三個領域的 agreement rate 有明確數據
- ✅ 針對 disagreement items 使用者完成 blind ground truth 標記

**不要求**：quality 一定要提升（若發現 dual reviewer 沒有顯著好處，「單 reviewer 就夠」也是有價值的結論 — 跟 v2 spec §11 同精神）。

## 9. 後續

跑完三域後寫 `docs/spike_v3_learnings.md`，預期結構：
- 三域各自 agreement rate 表
- Disagreement 題目的人工判官結果
- Claude vs Gemini 的系統性偏差觀察（若有）
- 對 ULMS v1 Phase 1 的結論（dual reviewer 要不要上線、怎麼上）

## 10. 尚未解決 / 延後決定

- **Gemini 成本計算**：目前 CLI 不提供 USD，暫以 token 數記錄。正式版若採 dual-reviewer，需補 model pricing 表做即時累加
- **Gemini model 選擇**：Step 0 用 default（gemini-3-flash-preview）。正式版可能要 pin 模型版本避免 API 行為漂移
- **Gemini skill 系統整合**：目前用 inline 注入，將來若 Gemini 支援 `.claude/skills/` 式的 discovery 機制或反之，可簡化
- **Reviewer 校準 drift**：Spike v2 Limitations 指出 agent-4 同題多次評分會 drift，dual-reviewer 機制本身也沒解決這個 — 屬於獨立 Phase 2 議題

End of Spec.
