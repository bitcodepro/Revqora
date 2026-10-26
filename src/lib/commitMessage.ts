export interface CommitTrailer {
  key: string;
  value: string;
}

/** Only separate a terminal trailer paragraph; prose and code must stay intact. */
export function splitCommitMessage(body: string): { description: string; trailers: CommitTrailer[] } {
  const text = body.replace(/\r\n?/g, "\n").trim();
  const separator = [...text.matchAll(/\n[\t ]*\n/g)].at(-1);
  const tail = separator ? text.slice(separator.index! + separator[0].length) : text;
  const description = separator ? text.slice(0, separator.index).trimEnd() : "";
  // A footer-looking line inside an unclosed code fence is still code.
  let fence = "";
  for (const line of description.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker && !fence) fence = marker[1];
    else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
  }
  const unchanged = { description: text, trailers: [] };
  if (fence) return unchanged;
  const trailers: CommitTrailer[] = [];
  for (const line of tail.split("\n")) {
    const entry = line.match(/^([A-Za-z][A-Za-z0-9-]*):[\t ]*(.*)$/);
    if (entry) trailers.push({ key: entry[1], value: entry[2] });
    else if (/^[\t ]+\S/.test(line) && trailers.length) trailers[trailers.length - 1].value += "\n" + line.trimStart();
    else return unchanged;
  }
  const contributor = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by)$/i;
  return trailers.some((t) => contributor.test(t.key)) ? { description, trailers } : unchanged;
}
