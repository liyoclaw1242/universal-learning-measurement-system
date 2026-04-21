// ULMS Education Spike v2 — main process
// Throwaway code. Verifies: can four domain-agnostic methodology skills,
// given only user-supplied material + dimensions, produce usable exam items
// for ANY domain?

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// ===== Paths =====
const ROOT = __dirname;
const WORKSPACE = path.join(ROOT, 'workspace');
const BLACKBOARD = path.join(WORKSPACE, 'blackboard.json');
const INPUTS_DIR = path.join(WORKSPACE, 'inputs');

// ===== Resolve `claude` binary =====
function resolveClaudeBinary() {
  try {
    const p = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (p) return p;
  } catch {
    // fall through
  }
  return `${process.env.HOME}/.local/bin/claude`;
}
const CLAUDE_BIN = resolveClaudeBinary();

// ===== Spawn config =====
const AGENT_TIMEOUT_MS = 300_000; // 5 min — v2 prompts do more work
const MAX_BUDGET_PER_CALL = '0.50'; // per-agent cap, looser than v1
const MODEL = process.env.ULMS_MODEL || 'haiku';
const AGENTS = ['agent_1', 'agent_2', 'agent_3', 'agent_4'];
const AGENT_SLUGS = {
  agent_1: 'agent-1-extractor',
  agent_2: 'agent-2-mapper',
  agent_3: 'agent-3-designer',
  agent_4: 'agent-4-reviewer',
};

// ===== Staged user inputs (held in memory until workflow starts) =====
const stagedInputs = {
  material: null,              // { filename, content, content_type }
  dimensions: null,            // array of { dim_id, name, description }
  assessment_params: null,     // { target_item_count, difficulty_distribution, item_types }
  domain_guidance: null,       // string | null
};

// ===== Blackboard helpers =====
function emptyBlackboard() {
  return {
    workflow: {
      current_step: 0,
      total_steps: 4,
      steps: AGENTS,
      status: 'pending',
    },
    user_input: {
      material: stagedInputs.material,
      competency_dimensions: stagedInputs.dimensions || [],
      domain_guidance: stagedInputs.domain_guidance || null,
      assessment_params: stagedInputs.assessment_params || {
        target_item_count: 6,
        difficulty_distribution: { easy: 0.34, medium: 0.5, hard: 0.16 },
        item_types: { mc_single: 0.5, fill: 0.3, ordering: 0.2 },
      },
    },
    data: {
      knowledge_units: null,
      mapping: null,
      items: null,
      review: null,
    },
    log: [],
    costs: {
      total_usd: 0,
      by_agent: {},
    },
  };
}

async function resetBlackboard() {
  await fs.mkdir(WORKSPACE, { recursive: true });
  await fs.writeFile(BLACKBOARD, JSON.stringify(emptyBlackboard(), null, 2));
}

async function readBlackboard() {
  const raw = await fs.readFile(BLACKBOARD, 'utf-8');
  return JSON.parse(raw);
}

// ===== Input loaders =====
// Copy into inputs/ so they're self-contained with the run snapshot.
async function ensureInputsDir() {
  await fs.mkdir(INPUTS_DIR, { recursive: true });
}

async function loadMaterial(srcPath) {
  await ensureInputsDir();
  const content = await fs.readFile(srcPath, 'utf-8');
  const filename = path.basename(srcPath);
  const destPath = path.join(INPUTS_DIR, filename);
  await fs.writeFile(destPath, content);
  const ext = path.extname(filename).toLowerCase();
  stagedInputs.material = {
    filename,
    content,
    content_type: ext === '.md' ? 'markdown' : 'text',
  };
  return { filename, char_count: content.length };
}

async function loadDimensions(srcPath) {
  await ensureInputsDir();
  const text = await fs.readFile(srcPath, 'utf-8');
  const parsed = yaml.load(text);
  if (!parsed || !Array.isArray(parsed.dimensions)) {
    throw new Error('dimensions YAML must have a top-level `dimensions` array');
  }
  stagedInputs.dimensions = parsed.dimensions;
  if (parsed.assessment_params) {
    stagedInputs.assessment_params = parsed.assessment_params;
  }
  const filename = path.basename(srcPath);
  await fs.writeFile(path.join(INPUTS_DIR, filename), text);
  return {
    filename,
    dimension_count: parsed.dimensions.length,
    has_assessment_params: !!parsed.assessment_params,
  };
}

async function loadGuidance(srcPath) {
  if (!srcPath) {
    stagedInputs.domain_guidance = null;
    return { loaded: false };
  }
  await ensureInputsDir();
  const content = await fs.readFile(srcPath, 'utf-8');
  stagedInputs.domain_guidance = content;
  const filename = path.basename(srcPath);
  await fs.writeFile(path.join(INPUTS_DIR, filename), content);
  return { loaded: true, filename, char_count: content.length };
}

function clearGuidance() {
  stagedInputs.domain_guidance = null;
}

// ===== Prompts — single-line slash invocation (Step 0 verified) =====
function buildPromptForAgent(agentName) {
  const slug = AGENT_SLUGS[agentName];
  return `/${slug}`;
}

// ===== Schema sanity checks (warn-only) =====
// After each agent exits, verify the key shape is present. Doesn't retry.
function schemaCheck(agentName, board) {
  const warns = [];
  const data = board.data || {};
  if (agentName === 'agent_1') {
    if (!Array.isArray(data.knowledge_units) || data.knowledge_units.length === 0) {
      warns.push('data.knowledge_units missing or empty');
    } else {
      for (const [i, ku] of data.knowledge_units.entries()) {
        if (!ku.ku_id) warns.push(`ku[${i}] missing ku_id`);
        if (!ku.source_excerpt) warns.push(`ku[${i}] missing source_excerpt (Iron Law B risk)`);
      }
    }
  } else if (agentName === 'agent_2') {
    const m = data.mapping;
    if (!m) warns.push('data.mapping missing');
    else {
      if (!m.blueprint || !Array.isArray(m.blueprint.slot_specs)) {
        warns.push('mapping.blueprint.slot_specs missing');
      }
      if (!m.ku_to_dimensions) warns.push('mapping.ku_to_dimensions missing');
    }
  } else if (agentName === 'agent_3') {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      warns.push('data.items missing or empty');
    } else {
      for (const [i, item] of data.items.entries()) {
        if (!item.item_id) warns.push(`item[${i}] missing item_id`);
        if (!item.core || item.core.answer === undefined) {
          warns.push(`item[${i}] missing core.answer`);
        }
      }
    }
  } else if (agentName === 'agent_4') {
    const r = data.review;
    if (!r) warns.push('data.review missing');
    else {
      if (!Array.isArray(r.per_item)) warns.push('review.per_item missing');
      if (!r.summary) warns.push('review.summary missing');
    }
  }
  return warns;
}

// ===== UI bridge =====
let mainWindow;

function sendUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ===== Spawn one agent =====
function spawnAgent(agentName) {
  return new Promise((resolve, reject) => {
    const prompt = buildPromptForAgent(agentName);
    sendUI('agent:started', { agent: agentName });

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      '--max-budget-usd', MAX_BUDGET_PER_CALL,
      '--model', MODEL,
      '--add-dir', WORKSPACE,
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    currentProc = proc;

    let lineBuf = '';
    let lastResult = null;

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`${agentName} timeout after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      const data = chunk.toString();
      sendUI('agent:pty', { agent: agentName, data });

      lineBuf += data;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '').trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          if (msg.type === 'result') lastResult = msg;
          sendUI('agent:stream', { agent: agentName, msg });
        } catch {
          sendUI('agent:raw', { agent: agentName, line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const data = chunk.toString();
      sendUI('agent:pty', { agent: agentName, data: `[stderr] ${data}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (currentProc === proc) currentProc = null;
      reject(new Error(`${agentName} spawn error: ${err.message}`));
    });

    proc.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (currentProc === proc) currentProc = null;
      sendUI('agent:completed', {
        agent: agentName,
        exit_code: exitCode,
        result: lastResult,
      });
      if (exitCode === 0) {
        resolve({ result: lastResult });
      } else {
        reject(new Error(`${agentName} exited with code ${exitCode}`));
      }
    });
  });
}

// ===== Sequential workflow =====
let isRunning = false;
let currentProc = null;

function stopWorkflow() {
  if (currentProc) {
    try { currentProc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

function inputsReady() {
  return !!(stagedInputs.material && stagedInputs.dimensions && stagedInputs.dimensions.length > 0);
}

async function runWorkflow() {
  if (isRunning) return;
  if (!inputsReady()) {
    sendUI('workflow:error', { error: 'material and dimensions must be loaded first' });
    return;
  }
  isRunning = true;

  try {
    await resetBlackboard();
    sendUI('workflow:started', {});
    sendUI('board:updated', await readBlackboard());

    const results = [];
    for (let i = 0; i < AGENTS.length; i++) {
      const agentName = AGENTS[i];
      const { result } = await spawnAgent(agentName);
      results.push(result);

      // Update costs in blackboard + emit warnings
      const board = await readBlackboard();
      board.costs = board.costs || { total_usd: 0, by_agent: {} };
      board.costs.by_agent[agentName] = result?.total_cost_usd || 0;
      board.costs.total_usd = Object.values(board.costs.by_agent).reduce((s, v) => s + v, 0);
      await fs.writeFile(BLACKBOARD, JSON.stringify(board, null, 2));

      sendUI('board:updated', board);

      const warns = schemaCheck(agentName, board);
      if (warns.length) {
        sendUI('schema:warn', { agent: agentName, warnings: warns });
      }

      const expectedStep = i + 1;
      if (board.workflow.current_step < expectedStep) {
        throw new Error(
          `${agentName} exited but workflow.current_step is ${board.workflow.current_step}, expected >= ${expectedStep}`,
        );
      }
    }

    const totalCost = results.reduce((sum, r) => sum + (r?.total_cost_usd || 0), 0);
    const totalDuration = results.reduce((sum, r) => sum + (r?.duration_ms || 0), 0);
    sendUI('workflow:completed', {
      board: await readBlackboard(),
      total_cost_usd: totalCost,
      total_duration_ms: totalDuration,
      per_agent: results.map((r, i) => ({
        agent: AGENTS[i],
        cost_usd: r?.total_cost_usd ?? 0,
        duration_ms: r?.duration_ms ?? 0,
        subtype: r?.subtype ?? 'unknown',
      })),
    });
  } catch (err) {
    sendUI('workflow:error', { error: err.message });
  } finally {
    isRunning = false;
  }
}

// ===== Electron lifecycle =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.loadFile('renderer.html');
  mainWindow.webContents.once('did-finish-load', () => {
    sendUI('env:info', {
      claude_bin: CLAUDE_BIN,
      model: MODEL,
      max_budget: MAX_BUDGET_PER_CALL,
      workspace: WORKSPACE,
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  // Workflow control
  ipcMain.handle('workflow:start', async () => {
    runWorkflow().catch((err) => console.error('runWorkflow error:', err));
  });
  ipcMain.handle('workflow:stop', async () => {
    stopWorkflow();
  });
  ipcMain.handle('board:read', async () => {
    try { return await readBlackboard(); } catch { return null; }
  });

  // Input loaders — return a status snapshot the renderer uses to gate the
  // Start button.
  ipcMain.handle('inputs:pick-and-load-material', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Material', extensions: ['md', 'txt', 'markdown'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
    try {
      const info = await loadMaterial(res.filePaths[0]);
      return { status: 'ok', ...info };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  });

  ipcMain.handle('inputs:pick-and-load-dimensions', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Dimensions YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
    try {
      const info = await loadDimensions(res.filePaths[0]);
      return { status: 'ok', ...info };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  });

  ipcMain.handle('inputs:pick-and-load-guidance', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Guidance', extensions: ['md', 'markdown', 'txt'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
    try {
      const info = await loadGuidance(res.filePaths[0]);
      return { status: 'ok', ...info };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  });

  ipcMain.handle('inputs:clear-guidance', async () => {
    clearGuidance();
    return { status: 'ok' };
  });

  ipcMain.handle('inputs:status', async () => ({
    material: stagedInputs.material
      ? { filename: stagedInputs.material.filename, char_count: stagedInputs.material.content.length }
      : null,
    dimensions: stagedInputs.dimensions
      ? { count: stagedInputs.dimensions.length, ids: stagedInputs.dimensions.map((d) => d.dim_id) }
      : null,
    guidance: stagedInputs.domain_guidance
      ? { char_count: stagedInputs.domain_guidance.length }
      : null,
    assessment_params: stagedInputs.assessment_params,
    ready: inputsReady(),
  }));
});

app.on('window-all-closed', () => {
  app.quit();
});
