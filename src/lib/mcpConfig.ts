export type McpClient = "codex" | "vscode" | "claude";

function tomlString(value: string) {
  // JSON and TOML basic strings share these escapes. TOML also requires DEL to be escaped.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

export function mcpConfig(executable: string, client: McpClient) {
  const server = { type: "stdio", command: executable, args: ["--mcp"] };
  if (client === "codex") return `[mcp_servers.revqora]\ncommand = ${tomlString(executable)}\nargs = ["--mcp"]\n`;
  return JSON.stringify({ [client === "vscode" ? "servers" : "mcpServers"]: { revqora: server } }, null, 2);
}
