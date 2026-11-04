/** Display hints only; the backend independently validates the native prompt. */
export function bitbucketPromptKind(prompt: string): "username" | "secret" | null {
  const match = /^(Username|Password) for '([^'\r\n\\]+)': $/.exec(prompt);
  if (!match) return null;
  try {
    const url = new URL(match[2]);
    if (url.protocol !== "https:" || url.hostname !== "bitbucket.org" || url.port || url.password || url.search || url.hash) return null;
    return match[1] === "Username" ? "username" : "secret";
  } catch { return null; }
}
