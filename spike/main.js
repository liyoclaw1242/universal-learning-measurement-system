// ULMS Education Spike v2 + v3 — main process
// v2: four domain-agnostic methodology skills produce exam items
// v3: add Gemini as independent second-opinion reviewer (dual-reviewer
//     architecture, manual trigger via "Run Gemini Second Opinion")

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ===== Paths =====
const ROOT = __dirname;
const WORKSPACE = path.join(ROOT, 'workspace');
const BLACKBOARD = path.join(WORKSPACE, 'blackboard.json');
const INPUTS_DIR = path.join(WORKSPACE, 'inputs');

// ===== Resolve binaries =====
function resolveBinary(name, fallback) {
  try {
    const p = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
    if (p) return p;
  } catch {
    // fall through
  }
  return fallback;
}
const CLAUDE_BIN = resolveBinary('claude', `${process.env.HOME}/.local/bin/claude`);
const GEMINI_BIN = resolveBinary('gemini', '/opt/homebrew/bin/gemini');

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
const REVIEWER_SKILL_PATH = path.join(
  WORKSPACE, '.claude', 'skills', 'agent-4-reviewer', 'SKILL.md',
);

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
      review: null,              // Claude reviewer writes here, coordinator then
                                 // renames to review_claude
      review_claude: null,       // populated after agent_4 completes
      review_gemini: null,       // populated after Gemini second opinion
      review_merged: null,       // computed per D4 verdict-merge rules
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

    // v3: rename data.review (Claude's output) to data.review_claude so that
    // Gemini's second opinion can later write into data.review without
    // clobbering. Keeps agent-4-reviewer SKILL.md unchanged (D1).
    const postLoopBoard = await readBlackboard();
    if (postLoopBoard.data.review && !postLoopBoard.data.review_claude) {
      postLoopBoard.data.review_claude = postLoopBoard.data.review;
      postLoopBoard.data.review = null;
      await fs.writeFile(BLACKBOARD, JSON.stringify(postLoopBoard, null, 2));
      sendUI('board:updated', postLoopBoard);
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

// ====================================================================
// v3: Gemini as independent second-opinion reviewer
// ====================================================================

// D1: Claude and Gemini read the SAME reviewer SKILL.md. For Gemini we
// inline the skill content into the prompt (Gemini doesn't auto-discover
// .claude/skills/). Frontmatter stripped; body is the instructions.
function loadReviewerSkillForGemini() {
  const raw = fsSync.readFileSync(REVIEWER_SKILL_PATH, 'utf-8');
  const bodyOnly = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  return [
    '你現在要扮演的角色是 agent-4-reviewer。',
    '工作目錄下有 blackboard.json，你有讀寫檔工具可用。',
    '請嚴格按以下 skill 內容完成任務：',
    '',
    '---',
    bodyOnly,
    '---',
    '',
    '現在開始執行。完成後必須把結果寫回 blackboard.json。',
  ].join('\n');
}

let currentGeminiProc = null;

function spawnGeminiReviewer() {
  return new Promise((resolve, reject) => {
    const prompt = loadReviewerSkillForGemini();
    sendUI('gemini:started', {});

    // Non-interactive invocation. Gemini CLI does NOT have Claude's
    // `--print` flag; instead, piping stdin + using `-o stream-json`
    // together triggers headless mode. `-p "<prompt>"` is the
    // alternative (prompt as argv), but for long prompts we prefer
    // stdin. Verified in spike v3 Step 0 on CLI v0.37.0.
    const args = [
      '-y',                                // YOLO mode: auto-approve tools
      '-o', 'stream-json',
      '--include-directories', WORKSPACE,  // let file tools touch workspace
    ];

    const proc = spawn(GEMINI_BIN, args, {
      cwd: WORKSPACE,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    currentGeminiProc = proc;

    let lineBuf = '';
    let lastResult = null;
    let assistantText = '';

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`gemini reviewer timeout after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      const data = chunk.toString();
      sendUI('gemini:pty', { data });

      lineBuf += data;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '').trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          // Gemini stream-json shape:
          //   {type:'init', session_id, model}
          //   {type:'message', role:'user'|'assistant', content, delta?}
          //   {type:'result', status, stats:{total_tokens, duration_ms, ...}}
          if (msg.type === 'result') lastResult = msg;
          if (msg.type === 'message' && msg.role === 'assistant' && msg.content) {
            assistantText += msg.content;
          }
          sendUI('gemini:stream', { msg });
        } catch {
          sendUI('gemini:raw', { line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const data = chunk.toString();
      sendUI('gemini:pty', { data: `[stderr] ${data}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (currentGeminiProc === proc) currentGeminiProc = null;
      reject(new Error(`gemini spawn error: ${err.message}`));
    });

    proc.on('exit', (exitCode) => {
      clearTimeout(timer);
      if (currentGeminiProc === proc) currentGeminiProc = null;
      sendUI('gemini:completed', {
        exit_code: exitCode,
        result: lastResult,
        assistant_text_preview: assistantText.slice(0, 500),
      });
      if (exitCode === 0) resolve({ result: lastResult });
      else reject(new Error(`gemini exited with code ${exitCode}`));
    });
  });
}

// D4 verdict-merge rules: strictest → reject > needs_revision > accept
const VERDICT_RANK = { accept: 0, needs_revision: 1, reject: 2 };
const VERDICT_BY_RANK = ['accept', 'needs_revision', 'reject'];

function mergeVerdict(cv, gv) {
  const rCV = VERDICT_RANK[cv] ?? 1;
  const rGV = VERDICT_RANK[gv] ?? 1;
  return VERDICT_BY_RANK[Math.max(rCV, rGV)];
}

const CHECK_FIELDS = ['answer_uniqueness', 'construct_validity', 'ambiguity', 'bypass_risk'];

function mergeReviews(reviewClaude, reviewGemini) {
  const claudePerItem = reviewClaude?.per_item || [];
  const geminiPerItem = reviewGemini?.per_item || [];
  const geminiById = {};
  for (const g of geminiPerItem) geminiById[g.item_id] = g;

  const perItem = claudePerItem.map((c) => {
    const g = geminiById[c.item_id];
    const verdictClaude = c.verdict;
    const verdictGemini = g?.verdict;
    const verdict = mergeVerdict(verdictClaude, verdictGemini);

    const checksAgreement = {};
    for (const cf of CHECK_FIELDS) {
      const cp = c.checks?.[cf]?.pass;
      const gp = g?.checks?.[cf]?.pass;
      if (cp !== undefined && gp !== undefined) {
        checksAgreement[cf] = cp === gp;
      } else {
        checksAgreement[cf] = null; // at least one reviewer didn't report
      }
    }

    const claudeConcerns = CHECK_FIELDS
      .map((cf) => c.checks?.[cf]?.concern)
      .filter(Boolean);
    const geminiConcerns = CHECK_FIELDS
      .map((cf) => g?.checks?.[cf]?.concern)
      .filter(Boolean);

    return {
      item_id: c.item_id,
      verdict,
      verdict_claude: verdictClaude,
      verdict_gemini: verdictGemini,
      agreement: verdictClaude === verdictGemini,
      checks_agreement: checksAgreement,
      quality_score_claude: c.overall_quality_score,
      quality_score_gemini: g?.overall_quality_score,
      claude_concerns: claudeConcerns,
      gemini_concerns: geminiConcerns,
    };
  });

  const total = perItem.length;
  const verdictAgreements = perItem.filter((p) => p.agreement).length;
  const perCheckAgreement = {};
  for (const cf of CHECK_FIELDS) {
    const measurable = perItem.filter((p) => p.checks_agreement[cf] !== null);
    const agree = measurable.filter((p) => p.checks_agreement[cf]).length;
    perCheckAgreement[cf] = measurable.length
      ? { rate: agree / measurable.length, measured_on: measurable.length }
      : { rate: null, measured_on: 0 };
  }
  const mergedCounts = { accept: 0, needs_revision: 0, reject: 0 };
  for (const p of perItem) mergedCounts[p.verdict] = (mergedCounts[p.verdict] || 0) + 1;

  return {
    per_item: perItem,
    summary: {
      total_items: total,
      reviewers: ['claude', 'gemini'],
      verdict_agreement_rate: total ? verdictAgreements / total : 0,
      per_check_agreement: perCheckAgreement,
      merged_verdict_counts: mergedCounts,
      disagreement_item_ids: perItem.filter((p) => !p.agreement).map((p) => p.item_id),
    },
  };
}

async function runSecondOpinion() {
  try {
    const beforeBoard = await readBlackboard();
    if (!beforeBoard.data?.items || beforeBoard.data.items.length === 0) {
      throw new Error('no items to review (run the full workflow first)');
    }
    if (!beforeBoard.data.review_claude) {
      throw new Error('data.review_claude missing (did agent-4 complete?)');
    }
    if (beforeBoard.data.review_gemini) {
      // Allow re-run by clearing previous Gemini output + merged result
      beforeBoard.data.review_gemini = null;
      beforeBoard.data.review_merged = null;
    }
    // D2: Gemini must NOT see Claude's verdicts, so we clear data.review
    // before spawning. Skill will write its own output there.
    beforeBoard.data.review = null;
    await fs.writeFile(BLACKBOARD, JSON.stringify(beforeBoard, null, 2));
    sendUI('board:updated', beforeBoard);

    const { result } = await spawnGeminiReviewer();

    // Rename data.review (Gemini's output) → data.review_gemini
    const afterBoard = await readBlackboard();
    if (!afterBoard.data.review) {
      throw new Error('Gemini exited but data.review is empty (skill not followed)');
    }
    afterBoard.data.review_gemini = afterBoard.data.review;
    afterBoard.data.review = null;

    // Compute merged review per D4
    afterBoard.data.review_merged = mergeReviews(
      afterBoard.data.review_claude,
      afterBoard.data.review_gemini,
    );

    // Track Gemini token usage (no cost field, so we store tokens)
    afterBoard.costs = afterBoard.costs || { total_usd: 0, by_agent: {} };
    afterBoard.costs.by_agent.gemini_reviewer = {
      tokens: result?.stats?.total_tokens ?? 0,
      input_tokens: result?.stats?.input_tokens ?? 0,
      duration_ms: result?.stats?.duration_ms ?? 0,
      cost_usd_note: 'not reported by Gemini CLI; compute from token pricing if needed',
    };

    await fs.writeFile(BLACKBOARD, JSON.stringify(afterBoard, null, 2));
    sendUI('board:updated', afterBoard);
    sendUI('second-opinion:completed', {
      board: afterBoard,
      merged_summary: afterBoard.data.review_merged.summary,
    });
  } catch (err) {
    sendUI('second-opinion:error', { error: err.message });
  }
}

function stopSecondOpinion() {
  if (currentGeminiProc) {
    try { currentGeminiProc.kill('SIGKILL'); } catch { /* already dead */ }
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
      gemini_bin: GEMINI_BIN,
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
  ipcMain.handle('review:second-opinion', async () => {
    runSecondOpinion().catch((err) => console.error('runSecondOpinion error:', err));
  });
  ipcMain.handle('review:stop-second-opinion', async () => {
    stopSecondOpinion();
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
