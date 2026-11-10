import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { copyText } from "../lib/ui";
import { mcpConfig, type McpClient } from "../lib/mcpConfig";

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
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try { setInfo(await api.mcpEnable(enabled)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const config = info ? mcpConfig(info.executable, client) : "";
  return <section aria-label="MCP">
    <div className="section-title">MCP</div>
    <div className="settings-grid">
      <span className="muted">Local access</span>
      <div className="vstack">
        <label className="check"><input type="checkbox" aria-describedby="mcp-access-help" checked={info?.enabled ?? false} disabled={!info || busy}
          onChange={e => void toggle(e.target.checked)} /> Enable MCP for this session</label>
        <small id="mcp-access-help" className="muted">Local MCP clients can read open repositories, including code and PR discussions. Git and PR actions ask for confirmation in Revqora. Keep this window's app running while connected.</small>
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
        <small className="muted">{client === "claude" ? "Add this entry to the project's .mcp.json." : "Add this entry to your client's user configuration."} Restart the client after configuring it. Enable access again when you reopen Revqora.</small>
      </div>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
