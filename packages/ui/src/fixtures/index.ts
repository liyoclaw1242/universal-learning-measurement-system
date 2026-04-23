// TS port of design_handoff_ulms_shell/hi-fi/fixtures.js — sample data
// for component prototyping and Storybook. Shape mirrors domain types
// in @/types; the hi-fi verdict shorthand ("accept"/"needs_revision"/
// "reject") is kept verbatim.

import type { Agent, StreamLog } from '../types/agent';
import type { Dimension, Item, ItemChecks, ItemOption } from '../types/item';
import { agreementOf } from '../types/item';
import type { Session } from '../types/session';

export const session: Session = {
  id: '7f3a8c2d',
  material: 'rust-book-ch04-ownership.md',
  project: 'rust-book-ch04',
  elapsed_s: 47.2,
  cost_usd: 0.42,
  cost_cap: 1.0,
  status: 'review',
};

export const agents: Agent[] = [
  {
    id: 'agent-1',
    name: 'extractor',
    model: 'claude-haiku-4-5',
    status: 'done',
    cost: 0.028,
    duration_s: 14.5,
    emit: '32 KU',
    tools: [
      { glyph: '🔧', text: 'Read material.md' },
      { glyph: '💬', text: '識別 32 KU' },
      { glyph: '🔧', text: 'Write blackboard.json' },
      { glyph: '✔', text: 'done · 14.5s · $0.028' },
    ],
  },
  {
    id: 'agent-2',
    name: 'mapper',
    model: 'claude-haiku-4-5',
    status: 'done',
    cost: 0.015,
    duration_s: 9.1,
    emit: '10 slots',
    tools: [
      { glyph: '🔧', text: 'Read blackboard.json' },
      { glyph: '💬', text: '依維度分配 10 題' },
      { glyph: '🔧', text: 'Write slot_plan' },
      { glyph: '✔', text: 'done · 9.1s · $0.015' },
    ],
  },
  {
    id: 'agent-3',
    name: 'designer',
    model: 'claude-sonnet-4-5',
    status: 'done',
    cost: 0.31,
    duration_s: 18.4,
    emit: '10 items',
    tools: [
      { glyph: '🔧', text: 'Read slot_plan' },
      { glyph: '💬', text: '生成 10 題 (parallel × 3)' },
      { glyph: '🔧', text: 'Write items.json' },
      { glyph: '✔', text: 'done · 18.4s · $0.31' },
    ],
  },
  {
    id: 'agent-4',
    name: 'reviewer',
    model: 'claude-sonnet-4-5',
    status: 'done',
    cost: 0.067,
    duration_s: 5.2,
    emit: 'verdicts',
    tools: [
      { glyph: '🔧', text: 'Read items.json' },
      { glyph: '💬', text: '對每題跑 4 個 check' },
      { glyph: '🔧', text: 'Write verdicts.json' },
      { glyph: '✔', text: 'done · 5.2s · $0.067' },
    ],
  },
];

const rawItems: Omit<Item, 'agreement'>[] = [
  { id: 'item_001', stem: 'String vs &str：哪一個持有 heap 資料？',
    dim: '①記憶', difficulty: 'low', construct: 'ownership_rule', bloom: 'recall',
    type: 'mc_single', source: '§4.1 ¶2',
    claude: 'accept', gemini: 'accept', user: null },
  { id: 'item_002', stem: 'move 語意：閱讀程式碼後選擇正確的執行結果。',
    dim: '②概念', difficulty: 'med', construct: 'move_semantics', bloom: 'understand',
    type: 'mc_single', source: '§4.1 ¶5',
    claude: 'accept', gemini: 'accept', user: null },
  { id: 'item_003', stem: '以下 Rust 程式碼執行後，println! 這一行會發生什麼？',
    dim: '③應用', difficulty: 'med', construct: 'move_semantics', bloom: 'apply',
    type: 'mc_single', source: '§4.1 ¶5',
    claude: 'accept', gemini: 'accept', user: 'flag' },
  { id: 'item_004', stem: '借用規則：同時擁有 &mut 與 & 會發生什麼？',
    dim: '②概念', difficulty: 'high', construct: 'borrow_checker', bloom: 'analyze',
    type: 'mc_single', source: '§4.2 ¶1',
    claude: 'accept', gemini: 'reject', user: null },
  { id: 'item_005', stem: "lifetime 標註：哪個 fn 簽名需要 'a 註記？",
    dim: '③應用', difficulty: 'high', construct: 'lifetimes', bloom: 'apply',
    type: 'mc_single', source: '§10.3',
    claude: 'needs_revision', gemini: 'needs_revision', user: 'reject' },
  { id: 'item_006', stem: 'Box<T> 與 Rc<T> 的差別 — 在什麼情境該用？',
    dim: '④除錯', difficulty: 'high', construct: 'smart_pointers', bloom: 'evaluate',
    type: 'mc_single', source: '§15.1',
    claude: 'reject', gemini: 'reject', user: 'promote' },
  { id: 'item_007', stem: 'Clone 與 Copy trait 有什麼差異？',
    dim: '①記憶', difficulty: 'low', construct: 'traits', bloom: 'recall',
    type: 'mc_single', source: '§4.1 ¶9',
    claude: 'accept', gemini: 'accept', user: null },
  { id: 'item_008', stem: 'Drop trait 何時執行？scope 結束順序為何？',
    dim: '①記憶', difficulty: 'med', construct: 'drop_order', bloom: 'understand',
    type: 'mc_single', source: '§15.3',
    claude: 'accept', gemini: 'accept', user: null },
  { id: 'item_009', stem: 'slice 的 borrow 會不會延長原 Vec 的生命週期？',
    dim: '②概念', difficulty: 'med', construct: 'slice_borrow', bloom: 'understand',
    type: 'mc_single', source: '§4.3',
    claude: 'accept', gemini: 'accept', user: null },
  { id: 'item_010', stem: 'dangling reference：下列哪一個 fn 會編譯失敗？',
    dim: '④除錯', difficulty: 'med', construct: 'dangling_ref', bloom: 'analyze',
    type: 'mc_single', source: '§4.2 ¶3',
    claude: 'accept', gemini: 'accept', user: null },
];

export const items: Item[] = rawItems.map((it) => ({ ...it, agreement: agreementOf(it) }));

export const dimensions: Dimension[] = [
  { id: '①', name: '記憶', weight: 0.2, target: 0.2 },
  { id: '②', name: '概念', weight: 0.3, target: 0.3 },
  { id: '③', name: '應用', weight: 0.3, target: 0.3 },
  { id: '④', name: '除錯', weight: 0.2, target: 0.2 },
];

export const streamLog: StreamLog = {
  'agent-2': [
    { ts: '14:03:18', kind: 'thought', text: '讀取 blackboard.json · 32 KU from agent-1' },
    { ts: '14:03:19', kind: 'tool', text: 'Read: ./workspace/blackboard.json' },
    { ts: '14:03:19', kind: 'result', text: '{ "knowledge_units": 32, "cost_so_far": 0.028 }' },
    { ts: '14:03:22', kind: 'thought', text: '依維度權重分配 32 KU → 10 題槽位' },
    { ts: '14:03:22', kind: 'thought', text: 'target: 記憶 2 / 概念 3 / 應用 3 / 除錯 2' },
    { ts: '14:03:24', kind: 'tool', text: 'Write: ./workspace/blackboard.json · slot_plan' },
    { ts: '14:03:24', kind: 'result', text: '{ "slots": 10, "by_dim": {"記憶":2,"概念":3,"應用":3,"除錯":2} }' },
    { ts: '14:03:25', kind: 'summary', text: 'slot plan ready · 10 / 10' },
    { ts: '14:03:26', kind: 'done', text: 'agent-2 · done · 9.1s · $0.015' },
  ],
  'agent-1': [
    { ts: '14:02:30', kind: 'thought', text: 'Read material.md (18,400 tokens)' },
    { ts: '14:02:31', kind: 'tool', text: 'Read: ./workspace/material.md' },
    { ts: '14:02:31', kind: 'result', text: '62 KB loaded' },
    { ts: '14:02:33', kind: 'thought', text: 'scan §4.1–§4.3 for atomic knowledge units' },
    { ts: '14:02:40', kind: 'thought', text: '識別 32 KU · 平均 3.2 KU 每段' },
    { ts: '14:02:43', kind: 'tool', text: 'Write: ./workspace/blackboard.json' },
    { ts: '14:02:43', kind: 'result', text: '{ "knowledge_units": 32, "dims_covered": 4 }' },
    { ts: '14:02:44', kind: 'summary', text: 'extraction ready · 32 KU' },
    { ts: '14:02:44', kind: 'done', text: 'agent-1 · done · 14.5s · $0.028' },
  ],
  'agent-3': [],
  'agent-4': [],
  unified: 'merge',
};

export const itemChecks: Record<string, ItemChecks> = {
  item_003: {
    uniqueness: { claude: 'pass', gemini: 'pass', claude_note: '', gemini_note: '' },
    construct: { claude: 'pass', gemini: 'pass', claude_note: 'tests move_semantics · apply level', gemini_note: '' },
    workaround: { claude: 'pass', gemini: 'pass', claude_note: '', gemini_note: '' },
    ambiguity: {
      claude: 'pass', gemini: 'pass', claude_note: '',
      gemini_note: "No ambiguity. Option D ('runtime panic') plausible to learners who haven't internalized compile-time checks — intentional distractor, acceptable.",
    },
  },
  item_004: {
    uniqueness: { claude: 'pass', gemini: 'pass', claude_note: '', gemini_note: '' },
    construct: { claude: 'pass', gemini: 'pass', claude_note: '', gemini_note: '' },
    workaround: {
      claude: 'pass', gemini: 'fail', claude_note: '',
      gemini_note: 'Learners can pick A by elimination without actually understanding the borrow rule — options B and C overlap semantically.',
    },
    ambiguity: { claude: 'pass', gemini: 'pass', claude_note: '', gemini_note: '' },
  },
};

export const itemCode: Record<string, string> = {
  item_003: `fn main() {
  let s = String::from("hello");
  takes_ownership(s);
  println!("{}", s);
}`,
};

export const itemOptions: Record<string, ItemOption[]> = {
  item_003: [
    { key: 'A', text: '印出 "hello"', correct: false },
    { key: 'B', text: '編譯失敗：s 的值已被 move', correct: true },
    { key: 'C', text: '印出空字串', correct: false },
    { key: 'D', text: 'runtime panic', correct: false },
  ],
};

export const sourceExcerpt: Record<string, string> = {
  item_003: '當我們將 s 傳入函式，它的值便被 move。呼叫後 s 在原作用域不再有效；繼續使用會在編譯期失敗。',
};
