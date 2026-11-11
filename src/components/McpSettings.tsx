import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { copyText } from "../lib/ui";
import { mcpConfig, type McpClient } from "../lib/mcpConfig";
import type { McpApprovalMode } from "../lib/types";

const approvalHelp: Record<McpApprovalMode, string> = {
  ask: "Review every Git or pull request action in Revqora before it runs.",
  full: "Local MCP clients can execute Git and pull request actions, including deletions, without prompting you.",
  delete_only: "Ask before deleting, discarding, pruning, overwriting history, or running workflow steps that may delete data. Other actions run automatically.",
};

export function McpSettings() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.mcpInfo>>>();
  const [client, setClient] = useState<McpClient>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.mcpInfo().then(value => { if (current) setInfo(value); }, reason => { if (current) setError(errorMessage(reason)); });
    return () => { current = false; };
  }, []);
  const update = async (save: () => ReturnType<typeof api.mcpInfo>) => {
    setBusy(true);
    setError("");
    try { setInfo(await save()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const config = info ? mcpConfig(info.executable, client) : "";
  const approvalMode = info?.approvalMode ?? "ask";
  return <section aria-label="MCP">
    <div className="section-title">MCP</div>
    <div className="settings-grid">
      <span className="muted">Local access</span>
      <div className="vstack">
        <label className="check"><input type="checkbox" aria-describedby="mcp-access-help" checked={info?.enabled ?? false} disabled={!info || busy}
          onChange={e => { const enabled = e.target.checked; void update(() => api.mcpEnable(enabled)); }} /> Enable MCP</label>
        <small id="mcp-access-help" className="muted">Revqora remembers this setting and starts MCP when it opens. While Revqora is running, local MCP clients can read open repositories, including code and PR discussions.</small>
      </div>
      <label htmlFor="mcp-approval">Approval mode</label>
      <div className="vstack">
        <select id="mcp-approval" className="select" value={approvalMode} disabled={!info || busy} aria-describedby="mcp-approval-help"
          onChange={e => { const mode = e.target.value as McpApprovalMode; void update(() => api.mcpSetApprovalMode(mode)); }}>
          <option value="ask">Ask my approval</option>
          <option value="full">Full approve</option>
          <option value="delete_only">Ask before deleting</option>
        </select>
        <small id="mcp-approval-help" className="muted">{approvalHelp[approvalMode]}</small>
      </div>
      <label htmlFor="mcp-client">Client</label>
      <select id="mcp-client" className="select" value={client} onChange={e => setClient(e.target.value as McpClient)}>
        <option value="codex">Codex (config.toml)</option>
        <option value="vscode">VS Code (mcp.json)</option>
        <option value="claude">Claude Code (.mcp.json)</option>
      </select>
      <label htmlFor="mcp-config">Configuration</label>
      <div className="vstack">
        <textarea id="mcp-config" className="textarea mono" rows={client === "codex" ? 3 : 11} value={config} readOnly spellCheck={false} />
        <button type="button" className="btn sm" disabled={!config} onClick={() => void copyText(config, "MCP configuration copied")}><Copy size={14} /> Copy MCP configuration</button>
        <small className="muted">{client === "claude" ? "Add this entry to the project's .mcp.json." : "Add this entry to your client's user configuration."} Restart the client after configuring it.</small>
      </div>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
