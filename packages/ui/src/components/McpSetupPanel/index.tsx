// McpSetupPanel — collapsible disclosure that walks the user through
// configuring Claude Desktop to call the ulms-mcp binary. Pure
// presentational: caller controls open state, copy state, and provides
// the McpSetup payload from backend.

import { Plug, Copy, Check } from 'lucide-react';
import type { McpSetup } from '../../types/home';

interface McpSetupPanelProps {
  setup: McpSetup | null;
  isOpen: boolean;
  isCopied: boolean;
  onToggleOpen: (open: boolean) => void;
  onCopy: (snippet: string) => void;
}

export default function McpSetupPanel({
  setup,
  isOpen,
  isCopied,
  onToggleOpen,
  onCopy,
}: McpSetupPanelProps) {
  return (
    <details
      className="mcp-setup"
      open={isOpen}
      onToggle={(e) => onToggleOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <Plug size={13} strokeWidth={1.75} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        MCP setup — let any LLM client query this knowledge base
      </summary>
      {setup ? (
        <div className="mcp-body">
          <p>
            Once configured, Claude Desktop / claude-code can call{' '}
            <code>list_concepts</code>, <code>read_concept</code>,{' '}
            <code>search_wiki</code>, <code>list_runs</code>,{' '}
            <code>get_run</code> directly during chat.
          </p>
          <ol>
            <li>
              Build the MCP binary (one-time):
              <pre className="mcp-code">cd apps/mcp && cargo build --release</pre>
              {setup.binaryExists ? (
                <span className="mcp-ok">
                  <Check size={12} /> binary present at <code>{setup.mcpBinaryPath}</code>
                </span>
              ) : (
                <span className="mcp-warn">
                  binary not found yet at <code>{setup.mcpBinaryPath}</code> — run the
                  command above
                </span>
              )}
            </li>
            <li>
              Add this to <code>{setup.claudeDesktopConfigPath}</code>:
              <div className="mcp-snippet-wrap">
                <button
                  type="button"
                  className="mcp-copy-btn"
                  onClick={() => onCopy(setup.configSnippet)}
                >
                  {isCopied ? <Check size={12} /> : <Copy size={12} />}
                  {isCopied ? ' Copied' : ' Copy'}
                </button>
                <pre className="mcp-code">{setup.configSnippet}</pre>
              </div>
            </li>
            <li>
              Restart Claude Desktop. The <code>ulms</code> MCP server should appear.
            </li>
          </ol>
        </div>
      ) : (
        <p className="ulms-meta">loading…</p>
      )}
    </details>
  );
}
