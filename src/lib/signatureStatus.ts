import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";

/** Signature results per `${root}\n${oid}`, asked for in batches as History rows appear. */
const known = new Map<string, string>();
const pending = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const MAX_KNOWN = 20_000;

const keyOf = (root: string, oid: string) => `${root}\n${oid}`;

function flush() {
  timer = null;
  for (const [root, oids] of pending) {
    pending.delete(root);
    const list = [...oids];
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      void api.signatureStatus(root, batch).then((result) => {
        if (known.size > MAX_KNOWN) known.clear();
        for (const oid of batch) known.set(keyOf(root, oid), result[oid] ?? "N");
        listeners.forEach((l) => l());
      }, () => {
        for (const oid of batch) known.set(keyOf(root, oid), "E");
        listeners.forEach((l) => l());
      });
    }
  }
}

/** Queues a commit for checking (once); results arrive for every row shown at the same time. */
export function requestSignature(root: string, oid: string) {
  const k = keyOf(root, oid);
  if (known.has(k)) return;
  known.set(k, "");
  let set = pending.get(root);
  if (!set) pending.set(root, (set = new Set()));
  set.add(oid);
  if (!timer) timer = setTimeout(flush, 120);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The status letter (`%G?`) for a commit, "" while being checked. */
export function useSignature(root: string, oid: string, enabled: boolean): string {
  const value = useSyncExternalStore(
    subscribe,
    () => (enabled ? known.get(keyOf(root, oid)) ?? "" : ""),
  );
  useEffect(() => { if (enabled) requestSignature(root, oid); }, [root, oid, enabled]);
  return value;
}

/** How a status letter is shown: null = no badge (unsigned or still unknown). */
export function signatureBadge(status: string): { label: string; tone: "good" | "warn" | "bad" } | null {
  switch (status) {
    case "G": return { label: "Signed and verified", tone: "good" };
    case "U": return { label: "Signed; the key is not trusted", tone: "warn" };
    case "X": return { label: "Signed; the signature has expired", tone: "warn" };
    case "Y": return { label: "Signed with an expired key", tone: "warn" };
    case "R": return { label: "Signed with a revoked key", tone: "bad" };
    case "B": return { label: "Bad signature", tone: "bad" };
    case "E": return { label: "Signed, but the signature cannot be checked here", tone: "warn" };
    default: return null;
  }
}
