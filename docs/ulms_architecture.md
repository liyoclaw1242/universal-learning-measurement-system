# ULMS 架構設計（正式版 v1 起點）

**Status:** Design document — grown from two spikes, subject to revision before Phase 1 code lands.
**Predecessors:** [Spike v1 feasibility](./spike_learnings.md) · [Spike v2 methodology validation](./spike_v2_learnings.md)
**Date:** 2026-04-22

---

## 1. 目的

Spike v1 證實了技術可行（短命 agent + blackboard + 狀態欄位協調 work），Spike v2 證實了 domain-agnostic 方法論可行（同一組 skill 跨 Rust / 經濟學產出 production-grade 題目）。

這份文件把那些經驗整理成**正式版 v1 的五層架構**，並專章處理 spike 過程中浮現、但尚未完全解決的**角色上下文獨立問題（context independence）**。

這份文件不描述 UI、不描述資料庫、不描述長期能力估計機制。這些是 Phase 2+ 的議題。v1 先把**題目生成管線**做對。

---

## 2. 五層模型（概覽）

```
┌─ L5  Inputs ─────────────────────────────────────┐  使用者合約
│   Material · Dimensions · Guidance · Params       │
├─ L4  Skills ─────────────────────────────────────┤  方法論實作
│   extractor · mapper · designer · reviewer        │
├─ L3  Workflow ───────────────────────────────────┤  協調與狀態
│   Coordinator · Blackboard · Handoff contract ·   │
│   Context isolation mechanisms                    │
├─ L2  Runtime ────────────────────────────────────┤  執行基底
│   claude --print · stream-json · spawn · tools ·  │
│   cost tracking                                   │
├─ L1  Constitution ───────────────────────────────┤  不可違反 invariant
│   Iron Laws · domain-agnostic 承諾                │
└───────────────────────────────────────────────────┘
```

依賴方向 **L1 → L5**：Constitution 約束所有上層；Runtime 提供執行環境；Workflow 用 Runtime 跑 Skills；Skills 消費 Inputs。

**一句話給每層：**

| 層 | 一句話 |
|---|---|
| L1 Constitution | 系統永遠不懂任何領域，也不假裝懂 |
| L2 Runtime | 怎麼把一個 agent spawn 起來跑完收工 |
| L3 Workflow | 怎麼讓 4 個 agent 依序做事而不互相污染 |
| L4 Skills | 每個 agent 的方法論是什麼 |
| L5 Inputs | 使用者要給系統什麼 |

---

## 3. L1 — Constitution（憲法 / 不可違反 invariant）

所有更高層的設計都必須服膺這幾條。違反任何一條 → 產出不可信、spike 結果失效（v2 規格明言）。

### 3.1 原始四條鐵律（v2 spike 既有）

- **I1**：系統不內建任何領域知識（no domain-specific content in system prompts / code / config / skills）
- **I2**：Agent 執行時不從訓練資料補教材沒提的內容
- **I3**：所有領域內容由使用者輸入（Material + Dimensions + optional Guidance）
- **I4**：人工評估時失敗必須分 A 類（系統責任）/ B 類（使用者責任）

### 3.2 從 spike 觀察補上的四條（新）

Spike 揭示的污染向量要求這些 invariant 寫進憲法：

- **I5**：Agent 之間的通訊只能是**結構化資料**（IDs、scores、flags、enums、schema 合法值），不得含**自由文字意見**（如 `rationale` / `designer_notes` / 主觀評語）暴露給下游 agent
- **I6**：每個 agent 在讀 upstream agent 輸出之前，必須先 anchor 在**使用者教材原文**（L5 Inputs 的 `material.content`），否則容易被上游的框架帶偏
- **I7**：每個 agent 只能寫入 blackboard 中**其專屬的 section**，不得修改 `user_input`、不得改其他 agent 的輸出。Coordinator 必須在每次 agent 完成後驗證此條
- **I8**：任何 per-host / per-user 的自動 context（CLAUDE.md auto-discovery、auto-memory、hooks）都**不得滲入 agent spawn**。Agent 的可見 context = 僅 skill 本身 + 明確傳入的 blackboard 片段

**I5–I8 是 Spike 過程中發現的污染向量對應的憲法條款** — 詳細的向量分析見 §8「上下文獨立」專章。

### 3.3 憲法的位置

憲法寫在**系統最底層**，不是某個 agent 的 prompt 裡的一段文字（那只是 enforcement 的一種形式）。憲法是**設計時的不可協商 axiom**，驗收時的檢查清單，失敗時的歸因標尺。

---

## 4. L2 — Runtime（執行基底）

### 4.1 Agent runtime 選型

Spike 兩輪驗證後的定論：

| 選擇 | 採用 | 理由 |
|---|---|---|
| `claude --print` | ✓ | Non-interactive 一次性 spawn，適合短命 agent |
| `--output-format stream-json --verbose` | ✓ | 結構化訊息流，tool_use / result 可直接 parse |
| Prompt 經 stdin 注入 | ✓ | `isatty(stdin) == false` 讓 CLI 走 non-interactive 快路徑 |
| `/<skill-name>` 字面 slash 觸發 | ✓ | 比自然語言「please invoke the X skill」便宜 ~30%、turns 減半（Step 0 驗證） |
| `child_process.spawn` | ✓ | 不要 PTY（PTY 讓 `--print` 誤入互動模式） |
| `--permission-mode bypassPermissions` | ✓ | Agent 自動有 Read/Write/Bash，無互動拒絕 |
| `--no-session-persistence` | ✓ | 每個 spawn 獨立、無跨 session 狀態洩漏 |
| `--max-budget-usd` | ✓ | Per-spawn 成本硬停，coordinator 另做 per-workflow 累加上限 |

### 4.2 Runtime 的責任邊界

Runtime 負責：
- Spawn 一個 agent 並送 prompt 進去
- 接收 stream-json 訊息流並解析出 `result` 拿到 cost / duration
- 超時與失敗時殺掉 process
- 把 stderr 與異常非 JSON 輸出忠實回報（不吞掉）

Runtime 不負責：
- 決定要 spawn 哪個 agent（那是 L3 Workflow 的事）
- 決定 agent 能看到什麼 context（那是 L3 Context Isolation 的事）
- 驗證 agent 輸出結構（那是 L3 的 schema check）

### 4.3 Tool 生態

Agent 在 runtime 裡可用的 tool：

| Tool | 用途 | 污染風險 |
|---|---|---|
| Read | 讀 blackboard / 教材 | 若讀到超出 scope 的欄位 → I5/I6 風險 |
| Write | 寫回 blackboard | 若寫到不該寫的 section → I7 違反 |
| Bash | 執行 shell | 若存取外部資源 → I2 違反風險 |
| Glob / Grep | 檔案搜尋 | 一般不需要 |
| WebFetch / WebSearch | 外部網路 | **必須禁用** — I2 違反的直接管道 |

Agent 的 tool 允許清單應該是**per-skill** allowlist，不是 runtime 預設。v1 應該立刻做 `--allowedTools` 限制。

---

## 5. L3 — Workflow（協調與狀態）

### 5.1 Coordinator

Spike v1 已驗證最簡設計夠用：

```
for agent in [extractor, mapper, designer, reviewer]:
    spawn agent via L2 runtime
    await exit
    read blackboard
    verify: agent wrote expected section (I7)
    verify: schema valid (sanity check, warn-only)
    emit progress to UI
    accumulate cost
raise if any step fails or cost exceeds per-workflow cap
```

**不需要** file watcher、state machine、lock file、retry loop。Sequential coordinator + atomic Write 的組合就夠。

### 5.2 Blackboard

Blackboard 是**合約（contract）**，不是**儲存（storage）**。它的 schema 定義每個 agent 看見什麼、產出什麼。

```
Blackboard {
  workflow       // 進度 / 狀態（coordinator + agents 共同維護）
  user_input     // L5 Inputs 的落地（不可被 agent 修改，I7）
  data           // Agent 產出區
    knowledge_units     // agent-1 extractor 寫
    mapping             // agent-2 mapper 寫
    items               // agent-3 designer 寫
    review              // agent-4 reviewer 寫
  log            // 事件流（append-only）
  costs          // coordinator 維護
}
```

**Schema 同時是 handoff 合約**：agent-2 能看到 `data.knowledge_units`（agent-1 的輸出），其他 agent 欄位它看不到（因為還沒寫）。這是時間上的天然隔離，但不足以防污染 — 見 §8。

### 5.3 Handoff 契約

每個 agent 的契約：

| Agent | 讀 | 寫 | 不得讀 | 不得寫 |
|---|---|---|---|---|
| extractor | `user_input.material` · `user_input.domain_guidance`（參考） | `data.knowledge_units` · `log` append | — | `user_input` · 其他 `data.*` |
| mapper | `data.knowledge_units` · `user_input.competency_dimensions` · `user_input.assessment_params` | `data.mapping` · `log` append | `user_input.material.content`（**鼓勵但非強制** — 見 I6） | 同上 |
| designer | `data.mapping.blueprint.slot_specs` · `data.knowledge_units` · `user_input.material.content` | `data.items` · `log` append | `data.mapping.ku_to_dimensions.*.rationale`（**應遮蔽** — 見 I5） | 同上 |
| reviewer | `data.items` · `data.knowledge_units` · `data.mapping.blueprint.slot_specs` · `user_input.material.content` · `user_input.competency_dimensions` | `data.review` · `log` append · `workflow.status = "completed"` | `data.items[*].designer_notes`（**應遮蔽** — 見 I5） | 同上 |

上表中 **"不得讀"** 不只是 skill 文字提醒，而是 coordinator 在送 blackboard 給 agent 前**事先過濾**（見 §8 scoped reads）。

### 5.4 Schema sanity check

每個 agent 結束後 coordinator 跑一次輕量檢查（warn-only，不 retry）：

- extractor 後：`data.knowledge_units` 非空陣列、每個 KU 有 `ku_id` + `source_excerpt`
- mapper 後：`data.mapping.blueprint.slot_specs` 存在、slot 數量符合 `assessment_params.target_item_count`
- designer 後：`data.items` 長度 = slot 數量、每個 item 有 `core.answer` + `diagnostics`
- reviewer 後：`data.review.per_item` 長度 = items 數量、`summary` 存在

發現異常 → 記 log warning、送到 UI、**繼續跑**（v2 spike 確認不要 retry）。異常是人工分析的信號，不是自動修復的觸發點。

### 5.5 Status 欄位

`workflow.current_step` 是**協調原語**，不是展示資訊：
- 每個 agent 必須把它推進（0→1→2→3→4）
- Coordinator 驗證推進（若沒推進 → abort）
- Agent 4 在完成時設 `workflow.status = "completed"`

Write tool 的 atomic rename 行為是此設計的前提（v1 spike 驗證）— 如果 Claude CLI 未來改成 streaming partial write，此設計會壞。作為 invariant 在 regression test 裡寫檢查。

---

## 6. L4 — Skills（方法論實作）

### 6.1 Skill 檔案結構

每個 skill 是一份 `.claude/skills/<name>/SKILL.md`，內容結構：

1. **角色宣告**：「你是 XXX 專家」
2. **鐵律區**：具體到這個角色的鐵律（通常 3 條）
3. **任務**：要讀什麼、要寫什麼
4. **判準 / 方法**：做這件事的方法論步驟
5. **輸出格式**：JSON schema + 範例
6. **自我檢查清單**：輸出前 agent 自己走一遍

Spike v2 的 `spike/workspace/.claude/skills/agent-{1..4}-*/SKILL.md` 是 v1 的起點。

### 6.2 Skill 的兩條硬約束

1. **零領域內容**：skill 裡不出現 "Rust"、"經濟"、"所有權"、"稀缺性" 等任何具體領域詞彙。舉例時用「程式語言 / 自然科學 / 歷史 / 文學」這種**類別標籤**講「任意領域」
2. **方法論可驗證**：每個判準要能被 coordinator 或使用者**外部驗證**，不是「agent 自己判斷」的黑盒子

### 6.3 Spike 揭示的 skill 加固項（v1 必做）

三條改動都是純方法論，不破壞鐵律：

**A. Agent 3 designer 的保守模式**
無 `domain_guidance` 時，**禁止自編任何 stem 素材**，只允許 `material.content` 中的 literal excerpt（v2 Rust R1 item_003 的自編 println 違反鐵律 B，加此條可擋）

**B. Agent 4 reviewer 新增 Check 5 — 素材真實性**
每題 stem 中的程式碼區塊 / 引文字串，必須能在 `user_input.material.content` 做 substring 找到。找不到 → verdict 降一級

**C. Agent 4 reviewer 新增 Check 6 — 選項長度均衡**
選擇題：計算選項長度的標準差 ÷ 平均長度。若 >0.3，標記 `bypass_risk.pass = false`（v2 四輪反覆出現 option-length bypass，Agent 4 都沒抓到）

---

## 7. L5 — Inputs（使用者合約）

### 7.1 四類輸入

| 輸入 | 必填 | 格式 | 作用 |
|---|---|---|---|
| Material | ✓ | `.md` / `.txt`（將來：`.pdf` / `.html`？） | 題目素材的唯一來源（I3） |
| Competency Dimensions | ✓ | YAML | 測量空間的座標軸（要測什麼能力） |
| Domain Guidance | **強建議** | `.md` | 出題品味（學習者層級、偏好題型、避免的錯誤） |
| Assessment Params | ✓ | YAML（可與 Dimensions 同檔） | 題數、難度分布、題型分布 |

**`domain_guidance` 從 spike 規格的「可選」升級為「強建議」**，理由見 Spike v2 Learning Report §「帶進正式版的結論」— 缺 guidance 時技術領域會踩鐵律 B。

### 7.2 Input 的 schema 要求（v1 必做）

- 使用者上傳後做 **parse 驗證**：YAML 合法、`dim_id` 唯一、`target_item_count` 與 `item_types` 比例相容等
- 若 `domain_guidance` 為空：**跳出 warning**「品質可能下降 ~10–15%，確定要繼續？」
- 不做**內容驗證**（例如「你的維度定義得好不好」） — 那是使用者領域專業的責任（I3），系統不假裝懂（I1）

### 7.3 Dimension YAML 其實夾帶領域專業 — 誠實標記

Spike v2 揭示：**維度定義本身就是領域專業工作**。系統層級 domain-agnostic ≠ 使用者層級 no-expertise-needed。

這不是技術缺陷，是產品定位問題：
- **正式版行銷文案必須誠實說明**「ULMS 幫領域專家加速，不幫外行人建題庫」
- UI 上可以做 **dimension 撰寫引導工具**（範例、常見模式）但不能做**領域特定範本**（那會破 I1）

---

## 8. 上下文獨立與污染向量（專章 — 本次 design doc 重點）

Spike v2 證實鐵律 A 在所觀察樣本裡違反次數 0，但那建立在很多**隱含條件**上。這節把污染向量列清楚，每條配對應的緩解設計。

### 8.1 污染向量分類

按嚴重度排序：

#### V1: Blackboard 共享讀寫範圍（嚴重：必解）

**現象**：Spike v2 每個 agent 都 Read 整個 blackboard.json，拿到所有 upstream agent 的輸出 + 其自由文字 rationale / designer_notes。

**症狀觀察**：Spike v2 沒直接觀察到 agent 4 被 agent 3 的 `designer_notes` 帶偏（因為 reviewer 抓到了多個 agent 3 沒自覺的問題），但這是樣本 N=24 的 anecdotal。高風險未爆發 ≠ 低風險。

**緩解（L3 機制）**：
- **Scoped reads**：coordinator 在傳 blackboard 給每個 agent 前，**過濾掉該 agent 不該看的欄位**（見 §5.3 表格的「不得讀」欄）
- 實作方式：寫一份 `scoped_blackboard_for(agent_name)` 函式，回傳該 agent 的 view
- Agent 的 skill 裡的 Read tool call 可指定 `./agent_view.json` 而非 `./blackboard.json`

#### V2: CLAUDE.md auto-discovery（嚴重：必解）

**現象**：Claude CLI 在 cwd 及上層自動尋找 `CLAUDE.md`（及 user global `~/.claude/CLAUDE.md`）並注入 system prompt。Spike v1 的 117K cache_read 有很大一部分是這個。

**風險**：如果 `spike/workspace/CLAUDE.md` 或上層有任何領域 hint（即使是善意的），所有 agent 都會吸到，直接破 I1/I2。

**緩解（L2 機制）**：
- **所有 agent spawn 用 `--bare` flag**：明文跳過 CLAUDE.md auto-discovery、auto-memory、hooks、plugin sync
- 然後用 `--append-system-prompt-file` 明確注入**唯一應該出現的系統 context**（若有，但目前沒有 — skill 本身已經是完整指令）
- Spike v2 沒用 `--bare`，是沒爆發的遺漏；v1 必做

#### V3: Auto-memory 載入（嚴重：必解）

**現象**：`~/.claude/projects/<project-slug>/memory/MEMORY.md` 會自動 load 進每個 claude spawn。Spike Step 0 實驗觀察到：cwd 在 `/tmp/` 下 cache_read 34K，cwd 在 `Projects/` 下 cache_read 117K — 差的就是 memory。

**風險**：使用者自己的 memory 裡可能有領域偏見（例如「我偏好 Rust 教學著重應用題」），每次 spawn 都會進去。

**緩解**：同 V2，`--bare` 也跳過 auto-memory。

#### V4: Dimension 描述文字 embedded opinion（中度）

**現象**：使用者寫 `dimensions[*].description` 時，可能寫「理解 Rust 中每個值有唯一擁有者的核心規則 — **應該用程式碼預測題測，不要用記憶題**」。後半段是命題偏好意見，但寫在 dimension description 裡，所有 agent（extractor / mapper / designer / reviewer）都會看到、都被 prime。

**風險**：描述該是**測什麼**，不該是**怎麼測**（後者是 Guidance 的責任）。

**緩解（L5 機制）**：
- Input schema validation：dimension description 若包含題型 / 難度 / 命題方法相關詞彙（關鍵字檢查），warn「建議移到 `domain_guidance`」
- Skill prompt 加一條：「若 dimension description 含命題建議，mapper / designer 應視為 guidance 的一部分，不應讓它影響 ku_to_dimensions 的客觀對應」

此條只能半機械化處理，最終得靠**使用者教育**。

#### V5: Inter-agent rationale text（中度）

**現象**：Mapper 在 `data.mapping.ku_to_dimensions[*].rationale` 寫「此 KU 體現 dim_a 因為...」。Designer 讀時會看到。Designer 看到「mapper 認為這個 KU 體現 X」後，命題時可能**defer to mapper's frame**，不再獨立判斷。

**Spike v2 沒直接觀察到，但風險存在**。

**緩解**：同 V1 的 scoped reads — 把 `rationale` 從 downstream agent 的 view 裡過濾掉。只保留結構化部分（`dim_id` + `weight`）。

Rationale 欄位本身**不應該移除**（它是給使用者 / 審查人看的價值來源），只是**不讓下游 agent 看**。

#### V6: Skill 之間的存在感（低度）

**現象**：`/skill` 機制讓每個 spawn 都知道有哪些 skill 可用（從 session init 的 `slash_commands` array）。`agent-1-extractor` 跑的時候知道 `agent-2-mapper` 存在。

**理論風險**：agent-3-designer 可能心想「等等 agent-4-reviewer 會檢查，我不用太嚴格」— 責任擴散。

**實際觀察**：Spike 沒觀察到這種鬆懈，agent 3 的 self-check list 運作正常。低風險。

**緩解（若將來觀察到）**：
- `--disable-slash-commands` + 只手動注入當前 agent 的 skill content — 等於讓每個 agent 以為自己是唯一 agent
- 代價：失去 skill discovery 的便利 — 需秤重

不急做。v1 先保留原設計，Phase 2 若觀察到責任擴散再動。

#### V7: 順序依賴性 / Frame 效應（低度但結構性）

**現象**：Agents 1→2→3→4 順序跑，每個下游 agent 繼承上游的框架。若 agent 1 對某 KU 的 `description` 寫得偏重某個面向（例如「Ownership 主要是編譯期檢查的規則系統」），agent 3 命題時會繞著這個角度設計，即使「記憶體安全」其實是更值得測的面向。

**為什麼叫「結構性」**：這不是 bug，是 pipeline 架構的**必然**。要完全消除需把 pipeline 變成 DAG 並 parallelize，失去 sequential 的簡潔。

**緩解（v1 + 實驗）**：
- I6 要求：每個下游 agent 在讀 upstream 之前先讀 `material.content`，強制 **material-first anchoring**
- 實驗（Phase 2 spike 候選）：跑一輪**打亂順序**的 workflow（例如 reviewer 先於 designer 跑獨立 review，然後 designer 看 blinded review），比較差異。若發現品質上升顯著 → 考慮架構改動

### 8.2 緩解機制總表（v1 實作清單）

按層歸類：

**L1 Constitution（invariants 新增）**：
- I5 inter-agent 通訊只能是結構化資料
- I6 agent 必須 material-first anchoring
- I7 agent 只寫其 section
- I8 no auto-context leakage（CLAUDE.md / memory）

**L2 Runtime（必改）**：
- 所有 agent spawn 加 `--bare`
- Per-skill `--allowedTools` allowlist（禁 WebFetch / WebSearch）
- Coordinator 對 I7 做 section-diff validation（比較 spawn 前後 blackboard，只允許指定 section 改變）

**L3 Workflow（必做）**：
- `scoped_blackboard_for(agent)` 函式 — per-agent view filtering
- 特別遮蔽：mapper 的 `rationale` 不給 designer、designer 的 `designer_notes` 不給 reviewer
- Agent 的 Read 目標改為 `./agent_view.json`（coordinator 寫入）而非 `./blackboard.json`
- Coordinator 在 agent 結束後 merge agent 的輸出回 full blackboard

**L4 Skills（新增條文）**：
- 每個 skill 開頭新增「你看到的 input 已由 coordinator 過濾，不得嘗試讀取 `./blackboard.json` 或其他未授權路徑」
- 每個 skill 加 material-first anchoring 步驟

**L5 Inputs（validation 加強）**：
- Dimension description 的命題偏好詞彙檢測 → warn 移到 guidance
- Guidance 為空時 warn 使用者

### 8.3 上下文獨立的驗證實驗（Phase 2 spike 候選）

v1 做了上述緩解後，Phase 2 應該跑**對抗性測試**驗證緩解真的有效：

1. **CLAUDE.md 毒化測試**：故意在 `spike/workspace/CLAUDE.md` 加「agent 3 偏好做選擇題」等 prior，確認 `--bare` 下 agent 輸出不受影響
2. **Rationale 遮蔽測試**：跑兩組 workflow，一組 designer 看得到 mapper rationale，一組看不到，比較題目 construct validity 分數
3. **打亂順序測試**：如 §V7 所述，看 DAG-parallel 架構是否值得 Phase 3 重構

這三個實驗各 ~$1，總 ~$3。

---

## 9. Open questions / 尚未決定

以下是這份設計**故意留白**的地方，需要 Phase 1 動手後才能定：

1. **Per-agent cost budget 怎麼分配？**
   - Spike 四個 agent 的 cost 接近（各 ~$0.25）但 designer 最複雜
   - v1 給一律 `--max-budget-usd 0.50` 還是差別化？
   - 建議：先一律 0.50，跑 5 個 real case 看分布再調

2. **Item 編輯 / 重跑機制？**
   - 使用者看到 reviewer reject 的 item 時，能不能要求 designer 重做這題？
   - v1 暫不做，v2 spike 證明「就看最終結果」已有足夠價值
   - Phase 2 候選

3. **Material 拆章節？**
   - 若使用者上傳整本書（200K+ chars），怎麼做 chunk？
   - v1 先限制「一次一章節」，大教材請使用者自己切
   - Chunk 策略是 Phase 2 的獨立 spike 主題

4. **多 user / 多 session 並發？**
   - v1 單 user、單機、單 workflow at a time
   - 並發是 Phase 3 server-side 問題

5. **能力估計 / IRT / variant_family？**
   - v2 spike 規格明文不做
   - v1 也不做
   - 進 Phase 2 後再看產品驗證情況

---

## 10. 從這份設計到第一個可執行 milestone

建議的 v1 Phase 1 開發順序：

1. **把 Spike v2 的程式碼當 v1 起點**，做這些收斂：
   - Skill prompts 套入 §6.3 的 A/B/C 加固
   - Main.js 的 agent spawn 加 `--bare` + `--allowedTools` allowlist
   - Coordinator 加 scoped blackboard view（§8.2 L3 清單）
2. **Section diff validation**（I7）— 寫 `validateAgentWrite(agent, before, after)` util
3. **跑一輪回歸驗證**：Rust TC1 R2 + Econ TC2 R2（應各 $1.2 內），確認加固沒破壞品質
4. **跑上下文獨立性對抗測試**（§8.3 三條，各 ~$1）
5. 有這些 evidence 後才寫使用者向的 marketing / pricing / UI 設計

**估計時間**：v1 Phase 1 到能跑對抗測試，約 **1–2 週工作日**。

---

## 附：與 Spike v2 設計的 Delta 一覽

| 項目 | Spike v2 | 正式版 v1 |
|---|---|---|
| Constitution | 4 條鐵律 | 8 條（新增 I5–I8） |
| `domain_guidance` | 可選 | 強建議 + schema warning |
| Agent spawn flags | `bypassPermissions` | + `--bare` + `--allowedTools` allowlist |
| Agent blackboard 讀取 | 整份 | Coordinator-filtered scoped view |
| Inter-agent rationale | 明文共享 | 寫入 blackboard 但對下游遮蔽 |
| Agent 4 checks | 4 條 | 6 條（新增 stem 素材真實性、選項長度均衡） |
| Agent 3 designer | 允許自編範例 | 無 guidance 時禁止自編 |
| Section-diff validation | 無 | Coordinator 強制檢查 |
| Cost budget | per-spawn only | + per-workflow cap |

所有 delta 都是 Spike v2 的觀察直接驅動的，沒有憑空加條款。
