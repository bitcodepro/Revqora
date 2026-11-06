const instruction = "Paste a repository URL or git clone <URL>. Choose the destination folder below; command options and extra arguments are not supported.";

/** Extract one literal source; never interpret shell escapes, flags or commands. */
export function parseCloneInput(value: string): { url: string; error: string } {
  const input = value.trim();
  if (!input) return { url: "", error: "" };
  const command = /^git\s+clone(?=\s|$)/i.exec(input);
  let source = command ? input.slice(command[0].length).trim() : input;
  if (!source || /[\r\n\0]/.test(source)) return { url: "", error: instruction };
  if (source[0] === '"' || source[0] === "'") {
    const end = source.indexOf(source[0], 1);
    if (end < 0 || source.slice(end + 1).trim()) return { url: "", error: instruction };
    source = source.slice(1, end);
  } else if (command && /\s/.test(source)) return { url: "", error: instruction };
  if (!source || source.startsWith("-")) return { url: "", error: instruction };
  return { url: source, error: "" };
}

export function repoNameFromUrl(url: string): string {
  const match = url.trim().replace(/\/+$/, "").match(/([^/:\\]+?)(\.git)?$/);
  return match ? match[1] : "";
}
