// ULMS spike — renderer (throwaway)
const { ipcRenderer } = require('electron');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const boardEl = document.getElementById('board');
const logsEl = document.getElementById('logs');
const envEl = document.getElementById('envInfo');
const summaryEl = document.getElementById('summary');
const AGENTS = ['agent_1', 'agent_2', 'agent_3', 'agent_4'];

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
  const dot = document.getElementById(`dot-${agent}`);
  if (!dot) return;
  dot.className = 'dot ' + (state || '');
}

// ===== Utilities =====
function stripAnsi(s) {
  // Strip ANSI escape sequences (colour codes, cursor moves, OSC, etc.)
  return s
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '') // CSI
    .replace(/\x1b[=>]/g, '') // mode switches
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // other control chars
}

function appendLog(text) {
  logsEl.textContent += text;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function appendTerm(agent, text) {
  const el = document.getElementById(`term-${agent}`);
  if (!el) return;
  el.textContent += stripAnsi(text);
  // Cap at ~500KB per tab so a chatty agent doesn't OOM the renderer.
  if (el.textContent.length > 500_000) {
    el.textContent = el.textContent.slice(-400_000);
  }
  el.scrollTop = el.scrollHeight;
}

function resetStepBadges() {
  AGENTS.forEach((a, i) => {
    const el = document.getElementById(`step-${a}`);
    el.className = 'step';
    el.innerHTML = `Step ${i + 1} / 4 — ${a} — <em>pending</em>`;
    setTabDot(a, '');
    const term = document.getElementById(`term-${a}`);
    if (term) term.textContent = '';
  });
}

// ===== Controls =====
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  logsEl.textContent = '';
  boardEl.textContent = '(starting…)';
  summaryEl.textContent = '';
  resetStepBadges();
  await ipcRenderer.invoke('workflow:start');
});

stopBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('workflow:stop');
  appendLog('\n=== STOP REQUESTED ===\n');
});

// ===== IPC handlers =====
ipcRenderer.on('env:info', (_, info) => {
  envEl.textContent = `claude: ${info.claude_bin}  •  model: ${info.model}  •  max budget/call: $${info.max_budget}  •  workspace: ${info.workspace}`;
});

ipcRenderer.on('agent:started', (_, { agent }) => {
  const el = document.getElementById(`step-${agent}`);
  if (!el) return;
  el.className = 'step active';
  const i = AGENTS.indexOf(agent) + 1;
  el.innerHTML = `Step ${i} / 4 — ${agent} — <em>running…</em>`;
  setTabDot(agent, 'active');
  appendLog(`\n── ${agent} starting ──\n`);
  appendTerm(agent, `── PTY spawned for ${agent} ──\n`);
});

ipcRenderer.on('agent:completed', (_, { agent, exit_code, result }) => {
  const el = document.getElementById(`step-${agent}`);
  if (!el) return;
  const i = AGENTS.indexOf(agent) + 1;
  if (exit_code === 0) {
    const cost = result?.total_cost_usd ?? 0;
    const dur = result?.duration_ms ?? 0;
    el.className = 'step done';
    el.innerHTML = `Step ${i} / 4 — ${agent} — <em>done · $${cost.toFixed(4)} · ${(dur / 1000).toFixed(1)}s</em>`;
    setTabDot(agent, 'done');
  } else {
    el.className = 'step error';
    el.innerHTML = `Step ${i} / 4 — ${agent} — <em>FAILED (exit=${exit_code})</em>`;
    setTabDot(agent, 'error');
  }
  appendTerm(agent, `\n── PTY exited (code ${exit_code}) ──\n`);
});

// Raw PTY byte stream — goes to the per-agent terminal tab.
ipcRenderer.on('agent:pty', (_, { agent, data }) => {
  appendTerm(agent, data);
});

// Parsed stream-json messages — go to the Overview log.
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
        appendLog(`${tag} 💬 ${block.text}\n`);
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
        const out =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c.text ?? '').join('')
              : JSON.stringify(block.content);
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

ipcRenderer.on('board:updated', (_, board) => {
  boardEl.textContent = JSON.stringify(board, null, 2);
});

ipcRenderer.on('workflow:completed', (_, payload) => {
  startBtn.disabled = false;
  stopBtn.disabled = true;
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
});

ipcRenderer.on('workflow:error', (_, { error, agent }) => {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  const msg = `\n=== ERROR${agent ? ' in ' + agent : ''}: ${error} ===\n`;
  appendLog(msg);
  summaryEl.textContent = msg.trim();
});
