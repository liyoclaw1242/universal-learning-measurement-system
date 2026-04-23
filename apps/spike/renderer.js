// ULMS Education Spike v2 + v3 — renderer (throwaway)
const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);
const AGENTS = ['agent_1', 'agent_2', 'agent_3', 'agent_4'];

const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const secondOpinionBtn = $('secondOpinionBtn');
const stopGeminiBtn = $('stopGeminiBtn');
const boardEl = $('board');
const logsEl = $('logs');
const envEl = $('envInfo');
const summaryEl = $('summary');
const agreementEl = $('agreementSummary');
const warningsEl = $('warnings');
const itemsGridEl = $('itemsGrid');

// ===== Tabs =====
const tabs = document.querySelectorAll('.tab');
const panes = document.querySelectorAll('.tab-pane');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.pane;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panes.forEach((p) => p.classList.toggle('active', p.id === `pane-${target}`));
  });
});

function setTabDot(agent, state) {
  const dot = $(`dot-${agent}`);
  if (!dot) return;
  dot.className = 'dot ' + (state || '');
}

// ===== Utilities =====
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function appendLog(text) {
  logsEl.textContent += text;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function appendTerm(agent, text) {
  const el = $(`term-${agent}`);
  if (!el) return;
  el.textContent += stripAnsi(text);
  if (el.textContent.length > 500_000) el.textContent = el.textContent.slice(-400_000);
  el.scrollTop = el.scrollHeight;
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resetStepBadges() {
  AGENTS.forEach((a, i) => {
    const el = $(`step-${a}`);
    el.className = 'step';
    el.innerHTML = `${['①', '②', '③', '④'][i]} ${a.replace('_', '-')} ${['extractor', 'mapper', 'designer', 'reviewer'][i]} — <em>pending</em>`;
    setTabDot(a, '');
    const term = $(`term-${a}`);
    if (term) term.textContent = '';
  });
  warningsEl.textContent = '';
  itemsGridEl.innerHTML = '<em style="color:#86868b;font-size:12px">(尚未產出)</em>';
}

// ===== Input slot management =====
async function refreshInputStatus() {
  const status = await ipcRenderer.invoke('inputs:status');

  const m = $('slot-material');
  const ms = $('status-material');
  if (status.material) {
    m.classList.add('loaded');
    ms.textContent = `${status.material.filename} (${status.material.char_count} 字)`;
  } else {
    m.classList.remove('loaded');
    ms.textContent = '未載入';
  }

  const d = $('slot-dimensions');
  const ds = $('status-dimensions');
  if (status.dimensions) {
    d.classList.add('loaded');
    ds.textContent = `${status.dimensions.count} 維度: ${status.dimensions.ids.join(', ')}`;
  } else {
    d.classList.remove('loaded');
    ds.textContent = '未載入';
  }

  const g = $('slot-guidance');
  const gs = $('status-guidance');
  if (status.guidance) {
    g.classList.add('loaded');
    gs.textContent = `已載入 (${status.guidance.char_count} 字)`;
  } else {
    g.classList.remove('loaded');
    gs.textContent = '未提供（可選）';
  }

  startBtn.disabled = !status.ready;
}

$('btnMaterial').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('inputs:pick-and-load-material');
  if (res.status === 'error') alert(`載入失敗: ${res.error}`);
  await refreshInputStatus();
});
$('btnDimensions').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('inputs:pick-and-load-dimensions');
  if (res.status === 'error') alert(`載入失敗: ${res.error}`);
  await refreshInputStatus();
});
$('btnGuidance').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('inputs:pick-and-load-guidance');
  if (res.status === 'error') alert(`載入失敗: ${res.error}`);
  await refreshInputStatus();
});
$('btnClearGuidance').addEventListener('click', async () => {
  await ipcRenderer.invoke('inputs:clear-guidance');
  await refreshInputStatus();
});

// ===== Controls =====
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  secondOpinionBtn.disabled = true;
  stopGeminiBtn.disabled = true;
  logsEl.textContent = '';
  boardEl.textContent = '(starting…)';
  summaryEl.textContent = '';
  agreementEl.textContent = '(尚未執行 second opinion)';
  const termG = $('term-gemini');
  if (termG) termG.textContent = '';
  setGeminiDot('');
  resetStepBadges();
  await ipcRenderer.invoke('workflow:start');
});

stopBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('workflow:stop');
  appendLog('\n=== STOP REQUESTED ===\n');
});

secondOpinionBtn.addEventListener('click', async () => {
  secondOpinionBtn.disabled = true;
  stopGeminiBtn.disabled = false;
  const termGemini = $('term-gemini');
  if (termGemini) termGemini.textContent = '';
  setGeminiDot('active');
  appendLog('\n── Gemini second opinion starting ──\n');
  await ipcRenderer.invoke('review:second-opinion');
});

stopGeminiBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('review:stop-second-opinion');
  appendLog('\n=== GEMINI STOP REQUESTED ===\n');
});

function setGeminiDot(state) {
  const dot = $('dot-gemini');
  if (!dot) return;
  dot.className = 'dot ' + (state || '');
}

// ===== Item cards =====
function renderItems(board) {
  const items = board?.data?.items;
  // Three sources of verdict, in priority order:
  // 1. review_merged (dual reviewer done)  → show both + merged
  // 2. review_claude (agent-4 done, gemini not yet) → show Claude only
  // 3. review (edge case: old v2 blackboard or mid-flight)
  const merged = board?.data?.review_merged;
  const review = board?.data?.review_claude ?? board?.data?.review;
  if (!Array.isArray(items) || items.length === 0) {
    itemsGridEl.innerHTML = '<em style="color:#86868b;font-size:12px">(尚未產出)</em>';
    return;
  }
  const reviewMap = {};
  if (review?.per_item) {
    for (const r of review.per_item) reviewMap[r.item_id] = r;
  }
  const mergedMap = {};
  if (merged?.per_item) {
    for (const m of merged.per_item) mergedMap[m.item_id] = m;
  }

  itemsGridEl.innerHTML = '';
  for (const item of items) {
    const mergedRev = mergedMap[item.item_id];
    const rev = reviewMap[item.item_id];
    const verdict = mergedRev?.verdict ?? rev?.verdict ?? 'pending';
    const score = rev?.overall_quality_score;

    const card = document.createElement('div');
    card.className = `item-card ${verdict}`;

    let verdictBlock;
    if (mergedRev) {
      // Dual-reviewer display
      const vc = mergedRev.verdict_claude ?? '?';
      const vg = mergedRev.verdict_gemini ?? '?';
      const agreeDot = mergedRev.agreement
        ? '<span class="agreement-dot agree" title="兩位 reviewer 一致"></span>'
        : '<span class="agreement-dot disagree" title="兩位 reviewer 分歧"></span>';
      verdictBlock = `
        <div class="verdict-row">
          <span class="label-mini">C:</span><span class="verdict ${vc}">${vc}</span>
          ${agreeDot}
          <span class="label-mini">G:</span><span class="verdict ${vg}">${vg}</span>
          <span class="label-mini" style="margin-left:6px">→</span>
          <span class="verdict ${verdict}" title="合併 verdict（最嚴）">${verdict}</span>
        </div>
      `;
    } else {
      verdictBlock = `
        ${score !== undefined ? `<span class="item-meta">quality ${score.toFixed(2)} </span>` : ''}
        <span class="verdict ${verdict}">${verdict}</span>
      `;
    }

    const head = `
      <div class="item-head">
        <div>
          <span class="item-id">${escapeHTML(item.item_id)}</span>
          <span class="item-meta"> · ${escapeHTML(item.core?.item_type ?? '?')}</span>
          <span class="item-meta"> · difficulty ${item.measurement?.difficulty_estimate ?? '?'}</span>
        </div>
        <div>${verdictBlock}</div>
      </div>
    `;

    const stem = `<div class="stem">${escapeHTML(item.core?.stem ?? '')}</div>`;

    let assets = '';
    if (Array.isArray(item.core?.stem_assets)) {
      for (const a of item.core.stem_assets) {
        assets += `<div class="code-block">${escapeHTML(a.content ?? '')}</div>`;
      }
    }

    let options = '';
    const answer = item.core?.answer;
    if (Array.isArray(item.core?.options)) {
      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
      options = '<ul class="options">';
      for (let i = 0; i < item.core.options.length; i++) {
        const letter = letters[i];
        const isCorrect = letter === answer || i === answer || item.core.options[i] === answer;
        options += `<li class="${isCorrect ? 'correct' : ''}">${escapeHTML(item.core.options[i])}</li>`;
      }
      options += '</ul>';
    } else if (answer !== undefined && answer !== null) {
      options = `<div class="options"><strong>Answer:</strong> ${escapeHTML(JSON.stringify(answer))}</div>`;
    }

    const explanation = item.core?.explanation
      ? `<div class="explanation"><strong>解析:</strong> ${escapeHTML(item.core.explanation)}</div>`
      : '';

    let checks = '';
    if (mergedRev) {
      // Dual-reviewer checks display: per-check agreement badge
      const checkMap = [
        ['唯一性', 'answer_uniqueness'],
        ['構念效度', 'construct_validity'],
        ['歧義', 'ambiguity'],
        ['繞題', 'bypass_risk'],
      ];
      checks = '<div class="checks">';
      for (const [label, key] of checkMap) {
        const agree = mergedRev.checks_agreement?.[key];
        const icon = agree === true ? '✓=' : agree === false ? '✗≠' : '?';
        const cls = agree === true ? 'pass' : agree === false ? 'fail' : '';
        checks += `<span class="check-badge ${cls}">${label} ${icon}</span>`;
      }
      checks += '</div>';

      if (mergedRev.claude_concerns?.length) {
        checks += `<div class="explanation" style="color:#0066cc"><strong>Claude 顧慮:</strong> ${mergedRev.claude_concerns.map(escapeHTML).join(' · ')}</div>`;
      }
      if (mergedRev.gemini_concerns?.length) {
        checks += `<div class="explanation" style="color:#cc5500"><strong>Gemini 顧慮:</strong> ${mergedRev.gemini_concerns.map(escapeHTML).join(' · ')}</div>`;
      }
    } else if (rev?.checks) {
      const entries = [
        ['唯一性', rev.checks.answer_uniqueness],
        ['構念效度', rev.checks.construct_validity],
        ['歧義', rev.checks.ambiguity],
        ['繞題', rev.checks.bypass_risk],
      ];
      checks = '<div class="checks">';
      for (const [label, c] of entries) {
        if (!c) continue;
        checks += `<span class="check-badge ${c.pass ? 'pass' : 'fail'}">${label}: ${c.pass ? '✓' : '✗'}${c.concern ? ' · ' + escapeHTML(c.concern.slice(0, 80)) : ''}</span>`;
      }
      checks += '</div>';
    }

    card.innerHTML = head + stem + assets + options + explanation + checks;
    itemsGridEl.appendChild(card);
  }
}

// ===== IPC handlers =====
ipcRenderer.on('env:info', (_, info) => {
  envEl.textContent =
    `claude: ${info.claude_bin}  •  gemini: ${info.gemini_bin ?? '(not set)'}  •  ` +
    `model: ${info.model}  •  max budget/agent: $${info.max_budget}  •  workspace: ${info.workspace}`;
});

ipcRenderer.on('agent:started', (_, { agent }) => {
  const el = $(`step-${agent}`);
  if (!el) return;
  el.className = 'step active';
  const i = AGENTS.indexOf(agent);
  const roles = ['extractor', 'mapper', 'designer', 'reviewer'];
  const marks = ['①', '②', '③', '④'];
  el.innerHTML = `${marks[i]} ${agent.replace('_', '-')} ${roles[i]} — <em>running…</em>`;
  setTabDot(agent, 'active');
  appendLog(`\n── ${agent} starting ──\n`);
  appendTerm(agent, `── spawn ${agent} ──\n`);
});

ipcRenderer.on('agent:completed', (_, { agent, exit_code, result }) => {
  const el = $(`step-${agent}`);
  if (!el) return;
  const i = AGENTS.indexOf(agent);
  const roles = ['extractor', 'mapper', 'designer', 'reviewer'];
  const marks = ['①', '②', '③', '④'];
  if (exit_code === 0) {
    const cost = result?.total_cost_usd ?? 0;
    const dur = result?.duration_ms ?? 0;
    el.className = 'step done';
    el.innerHTML = `${marks[i]} ${agent.replace('_', '-')} ${roles[i]} — <em>done · $${cost.toFixed(4)} · ${(dur / 1000).toFixed(1)}s</em>`;
    setTabDot(agent, 'done');
  } else {
    el.className = 'step error';
    el.innerHTML = `${marks[i]} ${agent.replace('_', '-')} ${roles[i]} — <em>FAILED (exit=${exit_code})</em>`;
    setTabDot(agent, 'error');
  }
  appendTerm(agent, `\n── exit code ${exit_code} ──\n`);
});

ipcRenderer.on('agent:pty', (_, { agent, data }) => {
  appendTerm(agent, data);
});

ipcRenderer.on('agent:stream', (_, { agent, msg }) => {
  const tag = `[${agent}]`;
  if (msg.type === 'system' && msg.subtype === 'init') {
    appendLog(`${tag} session ${msg.session_id?.slice(0, 8) ?? '?'}\n`);
    return;
  }
  if (msg.type === 'assistant') {
    const content = msg.message?.content ?? [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        appendLog(`${tag} 💬 ${block.text.slice(0, 300)}${block.text.length > 300 ? '…' : ''}\n`);
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        let brief;
        if (block.name === 'Read') brief = input.file_path || '';
        else if (block.name === 'Write') brief = input.file_path || '';
        else if (block.name === 'Bash') brief = input.command || '';
        else brief = JSON.stringify(input).slice(0, 120);
        appendLog(`${tag} 🔧 ${block.name}: ${brief}\n`);
      }
    }
    return;
  }
  if (msg.type === 'user') {
    const content = msg.message?.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        const out = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join('') : JSON.stringify(block.content);
        const truncated = out.length > 200 ? out.slice(0, 200) + ` ...(${out.length} chars)` : out;
        appendLog(`${tag} ⤷ ${truncated}\n`);
      }
    }
    return;
  }
  if (msg.type === 'result') {
    appendLog(
      `${tag} ✔ ${msg.subtype} · $${(msg.total_cost_usd ?? 0).toFixed(4)} · ${msg.duration_ms}ms · cache_read=${msg.usage?.cache_read_input_tokens ?? 0}\n`,
    );
    return;
  }
  appendLog(`${tag} · ${msg.type}\n`);
});

ipcRenderer.on('agent:raw', (_, { agent, line }) => {
  appendLog(`[${agent}] ⚠ raw: ${line.slice(0, 200)}\n`);
});

ipcRenderer.on('schema:warn', (_, { agent, warnings }) => {
  const text = `[${agent}] schema warnings:\n${warnings.map((w) => '  - ' + w).join('\n')}\n`;
  warningsEl.textContent += text;
  appendLog(text);
});

ipcRenderer.on('board:updated', (_, board) => {
  boardEl.textContent = JSON.stringify(board, null, 2);
  renderItems(board);
});

ipcRenderer.on('workflow:completed', (_, payload) => {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  secondOpinionBtn.disabled = false; // workflow done → second opinion available
  const lines = [
    `=== WORKFLOW COMPLETED ===`,
    `Total cost: $${payload.total_cost_usd.toFixed(4)}`,
    `Total duration: ${(payload.total_duration_ms / 1000).toFixed(1)}s`,
    ``,
    ...payload.per_agent.map(
      (a) => `  ${a.agent}: $${a.cost_usd.toFixed(4)} · ${(a.duration_ms / 1000).toFixed(1)}s · ${a.subtype}`,
    ),
  ];
  summaryEl.textContent = lines.join('\n');
  appendLog(`\n${lines.join('\n')}\n`);
  renderItems(payload.board);
  refreshInputStatus();
});

ipcRenderer.on('workflow:error', (_, { error, agent }) => {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  const msg = `\n=== ERROR${agent ? ' in ' + agent : ''}: ${error} ===\n`;
  appendLog(msg);
  summaryEl.textContent = msg.trim();
  refreshInputStatus();
});

// ===== Gemini second opinion handlers =====
ipcRenderer.on('gemini:started', () => {
  appendTerm('gemini', '── spawn gemini second opinion ──\n');
});

ipcRenderer.on('gemini:pty', (_, { data }) => {
  appendTerm('gemini', data);
});

ipcRenderer.on('gemini:stream', (_, { msg }) => {
  const tag = '[gemini]';
  if (msg.type === 'init') {
    appendLog(`${tag} session ${msg.session_id?.slice(0, 8) ?? '?'} · model ${msg.model}\n`);
    return;
  }
  if (msg.type === 'message' && msg.role === 'assistant') {
    if (msg.content) {
      const preview = msg.content.slice(0, 200);
      appendLog(`${tag} 💬 ${preview}${msg.content.length > 200 ? '…' : ''}\n`);
    }
    return;
  }
  if (msg.type === 'result') {
    const tot = msg.stats?.total_tokens ?? 0;
    const dur = msg.stats?.duration_ms ?? 0;
    const tools = msg.stats?.tool_calls ?? 0;
    appendLog(`${tag} ✔ ${msg.status} · ${tot} tokens · ${tools} tool calls · ${dur}ms\n`);
    return;
  }
  appendLog(`${tag} · ${msg.type}\n`);
});

ipcRenderer.on('gemini:raw', (_, { line }) => {
  appendLog(`[gemini] ⚠ raw: ${line.slice(0, 200)}\n`);
});

ipcRenderer.on('gemini:completed', (_, { exit_code, result }) => {
  setGeminiDot(exit_code === 0 ? 'done' : 'error');
  appendTerm('gemini', `\n── gemini exit code ${exit_code} ──\n`);
  if (exit_code !== 0) {
    stopGeminiBtn.disabled = true;
    secondOpinionBtn.disabled = false;
  }
});

ipcRenderer.on('second-opinion:completed', (_, payload) => {
  stopGeminiBtn.disabled = true;
  secondOpinionBtn.disabled = true; // already done; user can clear to re-run
  const s = payload.merged_summary;
  const checkLines = Object.entries(s.per_check_agreement).map(([k, v]) =>
    `    ${k}: ${v.rate !== null ? (v.rate * 100).toFixed(0) + '%' : 'n/a'} (on ${v.measured_on} items)`,
  );
  const lines = [
    `=== DUAL-REVIEWER DONE ===`,
    `Total items: ${s.total_items}`,
    `Verdict agreement: ${(s.verdict_agreement_rate * 100).toFixed(0)}% (${Math.round(s.verdict_agreement_rate * s.total_items)}/${s.total_items})`,
    ``,
    `Per-check agreement:`,
    ...checkLines,
    ``,
    `Merged verdict counts (strictest):`,
    `    accept:         ${s.merged_verdict_counts.accept}`,
    `    needs_revision: ${s.merged_verdict_counts.needs_revision}`,
    `    reject:         ${s.merged_verdict_counts.reject}`,
    ``,
    s.disagreement_item_ids.length
      ? `Disagreement items: ${s.disagreement_item_ids.join(', ')}`
      : `No disagreements — both reviewers aligned on every item.`,
  ];
  agreementEl.textContent = lines.join('\n');
  appendLog(`\n${lines.join('\n')}\n`);
  renderItems(payload.board);
});

ipcRenderer.on('second-opinion:error', (_, { error }) => {
  stopGeminiBtn.disabled = true;
  secondOpinionBtn.disabled = false;
  setGeminiDot('error');
  const msg = `\n=== GEMINI ERROR: ${error} ===\n`;
  appendLog(msg);
  agreementEl.textContent = msg.trim();
});

// Initial load
refreshInputStatus();
