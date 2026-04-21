// ULMS Feasibility Spike — main process
// Throwaway code. No tests, no types, no polish. Answers one question:
// "Can a sequential pipeline of AI agents coordinate via a status field in
//  a shared blackboard file, each running in its own long-lived PTY?"

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// ===== Paths =====
const ROOT = __dirname;
const WORKSPACE = path.join(ROOT, 'workspace');
const BLACKBOARD = path.join(WORKSPACE, 'blackboard.json');

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
const AGENT_TIMEOUT_MS = 180_000;
const MAX_BUDGET_PER_CALL = '0.10';
const MODEL = process.env.ULMS_MODEL || 'haiku';
const AGENTS = ['agent_1', 'agent_2', 'agent_3', 'agent_4'];

// ===== Blackboard helpers =====
async function resetBlackboard() {
  await fs.mkdir(WORKSPACE, { recursive: true });
  await fs.writeFile(
    BLACKBOARD,
    JSON.stringify(
      {
        workflow: {
          current_step: 0,
          total_steps: 4,
          steps: AGENTS,
          status: 'pending',
        },
        data: {
          agent_1_output: null,
          agent_2_output: null,
          agent_3_output: null,
          agent_4_output: null,
        },
        log: [],
      },
      null,
      2,
    ),
  );
}

async function readBlackboard() {
  const raw = await fs.readFile(BLACKBOARD, 'utf-8');
  return JSON.parse(raw);
}

// ===== Prompts (intentionally boring) =====
function buildPromptForAgent(agentName) {
  const prompts = {
    agent_1: `You are Agent 1. Follow these steps exactly:

1. Use the Read tool on "blackboard.json" in the current directory.
2. Set data.agent_1_output = {"message": "Hello, I am Agent 1", "timestamp": "<current ISO-8601 UTC time>"}.
3. Change workflow.current_step from 0 to 1.
4. Append to log: {"agent": "agent_1", "action": "completed", "at": "<same timestamp>"}.
5. Use the Write tool to save the full updated JSON back to "blackboard.json".
6. Reply with one short sentence confirming done, then stop.

Preserve all other fields exactly. Do NOT add extra fields.`,

    agent_2: `You are Agent 2. Follow these steps exactly:

1. Use the Read tool on "blackboard.json".
2. If data.agent_1_output is null, reply "ERROR: agent_1_output missing" and stop.
3. Compute N = character count of data.agent_1_output.message.
4. Set data.agent_2_output = {"message": "Agent 2 saw Agent 1's message", "received_length": N}.
5. Change workflow.current_step from 1 to 2.
6. Append to log: {"agent": "agent_2", "action": "completed", "at": "<current ISO-8601 UTC time>"}.
7. Use the Write tool to save the full updated JSON.
8. Reply with one short confirmation sentence, then stop.`,

    agent_3: `You are Agent 3. Follow these steps exactly:

1. Use the Read tool on "blackboard.json".
2. Set data.agent_3_output = {"character_count": <len(data.agent_1_output.message)>, "computed_by": "agent_3"}.
3. Change workflow.current_step from 2 to 3.
4. Append to log: {"agent": "agent_3", "action": "completed", "at": "<current ISO-8601 UTC time>"}.
5. Use the Write tool to save the full updated JSON.
6. Reply with one short confirmation sentence, then stop.`,

    agent_4: `You are Agent 4. Follow these steps exactly:

1. Use the Read tool on "blackboard.json".
2. Verify data.agent_1_output, agent_2_output, agent_3_output are all non-null.
3. Set data.agent_4_output = {"summary": "All three agents finished", "checks_passed": true, "agent_1_message_length": <data.agent_2_output.received_length>, "agent_3_count": <data.agent_3_output.character_count>}.
4. Change workflow.current_step from 3 to 4.
5. Change workflow.status from "pending" to "completed".
6. Append to log: {"agent": "agent_4", "action": "completed", "at": "<current ISO-8601 UTC time>"}.
7. Use the Write tool to save the full updated JSON.
8. Reply with one short confirmation sentence, then stop.`,
  };
  return prompts[agentName];
}

// ===== UI bridge =====
let mainWindow;

function sendUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ===== Spawn one agent =====
// Runs `claude --print --output-format stream-json --verbose <...>` with the
// prompt piped on stdin. Uses child_process.spawn (no PTY) so claude's
// isatty(stdin) returns false and --print takes the non-interactive fast
// path. Stdout is both parsed as newline-delimited JSON (for the Overview
// tab) and forwarded raw (for the per-agent terminal tab).
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

      // Forward raw stdout to the per-agent terminal tab.
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

async function runWorkflow() {
  if (isRunning) return;
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

      const board = await readBlackboard();
      sendUI('board:updated', board);

      // Status-based sanity check: blackboard must reflect this agent's turn.
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
    width: 1100,
    height: 820,
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
  ipcMain.handle('workflow:start', async () => {
    runWorkflow().catch((err) => console.error('runWorkflow error:', err));
  });
  ipcMain.handle('workflow:stop', async () => {
    stopWorkflow();
  });
  ipcMain.handle('board:read', async () => {
    try {
      return await readBlackboard();
    } catch {
      return null;
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
