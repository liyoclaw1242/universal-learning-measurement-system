# ULMS Feasibility Spike

**Status:** Throwaway. This code will be deleted after learnings are extracted.
**Do not build on top of this.** It exists to answer yes/no questions, nothing more.

## Purpose

Validate that on macOS we can:

1. Spawn `claude` CLI from Electron main process
2. Pass a multi-line prompt via stdin
3. Let `claude` read and write a shared blackboard file via its Read/Write tools
4. Detect file changes with chokidar and trigger the next spawn

If the four fake agents complete end-to-end, the core technical assumptions hold.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 20+ (`node --version`)
- `claude` CLI installed and authenticated:
  - `which claude` — should return a path
  - `claude auth status` — must show `loggedIn: true`
  - If not logged in: run `claude auth login` first

## Run

From **this** directory (`spike/`):

```bash
npm install
npm start
```

Click **Start Workflow**. The four fake agents (`agent_1` … `agent_4`) will
run sequentially. Each reads `workspace/blackboard.json`, fills in its
section, and writes it back. Chokidar picks up the change and triggers the
next one.

Re-run from scratch: click **Start Workflow** again (it resets the blackboard),
or `npm run reset` to wipe the `workspace/` directory entirely.

## Spawn configuration

`main.js` spawns `claude` with these flags (chosen from reading `claude --help`):

```
--print                          non-interactive
--output-format json             single JSON result to stdout
--permission-mode bypassPermissions   auto-approve Read/Write tool calls
--no-session-persistence         each spawn is a fresh session
--max-budget-usd 0.10            per-spawn USD cap (safety net)
--model haiku                    cheapest model (override via ULMS_MODEL env)
--add-dir <workspace path>       allow tool access to the workspace dir
```

Override model: `ULMS_MODEL=sonnet npm start`

## What to watch for and report back

### Success case — please note:

1. **Total time per agent** (wall-clock). Haiku should be 5–20 s.
2. **Total USD cost** for one full run. The `--output-format json` payload
   in the log pane contains `total_cost_usd` — sum the four.
3. **Any double-fires** — look at the log for two `[agent:started]` events
   for the same agent without an intervening completion. That means
   chokidar's `awaitWriteFinish` (500 ms) isn't enough on your machine.
4. **Final state** — `workflow.status` should be `"completed"` and all four
   `agent_N_output` fields populated.

### Failure modes — if it breaks, capture:

| Symptom | Likely cause | Action |
|---|---|---|
| `spawn ENOENT` | Electron can't find `claude` on PATH | Run `which claude` in Terminal, paste into `main.js` `CLAUDE_BIN` manually |
| `Not logged in` in agent output | `claude auth login` not done | Log in first; re-run |
| Agent appears to write but file unchanged | `--permission-mode bypassPermissions` not honoured | Try `--dangerously-skip-permissions` instead |
| Agent hangs, then times out at 180 s | Prompt interpretation issue or infinite tool loop | Check the log — paste the full agent stdout to me |
| Chokidar never fires after agent completes | macOS fsevents quirk | Check log for whether Read/Write tool calls happened; if yes, tell me and we switch to polling |
| Two agents fire at once | Race in `spawning` flag | Shouldn't happen but if it does, capture the log |

### Unexpected findings

Anything that surprised you — report it. Even things that "look unimportant".
The whole point of a spike is that the weird stuff is the valuable signal.

## Intentionally NOT done

- No TypeScript, no tests
- No state machine (hard-coded 4-step sequence)
- No gatekeeper / validator
- No lock file
- No cost accumulator (each agent has its own `--max-budget-usd` cap)
- No crash recovery
- No SQLite
- No polished UI

This is intentional. The spike answers a yes/no question. Once answered,
this code is discarded and the real ULMS v1 is written fresh.

## File map

```
spike/
├── package.json       deps: electron + chokidar
├── main.js            Electron main + spawn orchestration (~230 lines)
├── renderer.html      minimal UI
├── renderer.js        IPC listeners (~55 lines)
├── .gitignore
├── README.md          this file
└── workspace/         generated at runtime, holds blackboard.json
```

## After the spike

Once you've run it (successfully or not), paste the terminal output and
a few sentences on what happened. Based on that, we'll:

1. Write a short learning report (`docs/spike_learnings.md` in the real project)
2. Revise the Phase 1 plan with anything the spike overturned
3. Delete `spike/` and start the real v1 at the workspace root
