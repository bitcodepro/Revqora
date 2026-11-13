import { shortcutTitle } from "./shortcuts";

const controls = "button, [role=button], [role=tab], select, [data-tooltip], [data-shortcut], svg[aria-label], span[aria-label]";
const targets = `${controls}, [title]`;
const hoverDelay = 3000;

/** One tooltip per window. Delegate so dynamically mounted icons behave the same as the toolbar. */
export function installIconHints(doc: Document): () => void {
  const view = doc.defaultView!;
  const tip = doc.createElement("div");
  tip.className = "revqora-tooltip";
  tip.setAttribute("role", "tooltip");
  let current: HTMLElement | null = null;
  let nativeTitle: string | null = null;
  let temporaryLabel: string | null = null;
  let timer: number | undefined;
  const dismiss = () => {
    view.clearTimeout(timer);
    timer = undefined;
    tip.remove();
  };
  const leave = () => {
    dismiss();
    if (current?.getAttribute("title") === "") {
      if (nativeTitle === null) current.removeAttribute("title");
      else current.setAttribute("title", nativeTitle);
    }
    if (temporaryLabel !== null && current?.getAttribute("aria-label") === temporaryLabel) current.removeAttribute("aria-label");
    nativeTitle = null;
    temporaryLabel = null;
    current = null;
  };
  const control = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>(targets) ?? null;
  const enter = (next: HTMLElement | null) => {
    if (next === current) return;
    leave();
    if (!next?.isConnected) return;
    const labelledBy = next.getAttribute("aria-labelledby")?.split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? "").join(" ").trim();
    const text = next.matches("button, [role=button], [role=tab]") ? next.textContent?.trim() : "";
    current = next;
    nativeTitle = next.getAttribute("title");
    if (nativeTitle && !text && !labelledBy && !next.hasAttribute("aria-label") && next.matches(controls)) {
      temporaryLabel = nativeTitle;
      next.setAttribute("aria-label", nativeTitle);
    }
    // An empty title also suppresses titles inherited from ancestors during the delay.
    next.setAttribute("title", "");
    if (doc.body.classList.contains("explorer-dragging")) return;
    timer = view.setTimeout(() => {
      timer = undefined;
      if (!next.isConnected || current !== next || doc.body.classList.contains("explorer-dragging")) return;
      const description = (next.dataset.tooltip || nativeTitle || next.getAttribute("aria-label") || labelledBy || text || "").trim();
      if (!description) return;
      tip.textContent = next.dataset.shortcut ? shortcutTitle(description, next.dataset.shortcut) : description;
      doc.body.append(tip);
      const rect = next.getBoundingClientRect();
      const x = Math.max(8, Math.min(rect.left + (rect.width - tip.offsetWidth) / 2, view.innerWidth - tip.offsetWidth - 8));
      const below = rect.bottom + 6;
      tip.style.left = `${x}px`;
      tip.style.top = `${below + tip.offsetHeight + 8 <= view.innerHeight ? below : Math.max(8, rect.top - tip.offsetHeight - 6)}px`;
    }, hoverDelay);
  };
  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    enter(control(e.target));
  };
  const out = (e: PointerEvent) => {
    if (e.pointerType !== "touch" && control(e.target) !== control(e.relatedTarget)) leave();
  };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
  doc.addEventListener("pointerover", over, true);
  doc.addEventListener("pointermove", over, true);
  doc.addEventListener("pointerout", out, true);
  doc.addEventListener("pointerdown", dismiss, true);
  doc.addEventListener("keydown", key, true);
  doc.addEventListener("scroll", dismiss, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);
  const changes = new MutationObserver(() => {
    if (!current) return;
    if (!current.isConnected) { leave(); return; }
    const title = current.getAttribute("title");
    if (title !== "") {
      nativeTitle = title;
      current.setAttribute("title", "");
    }
  });
  changes.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  return () => {
    leave();
    changes.disconnect();
    doc.removeEventListener("pointerover", over, true);
    doc.removeEventListener("pointermove", over, true);
    doc.removeEventListener("pointerout", out, true);
    doc.removeEventListener("pointerdown", dismiss, true);
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("scroll", dismiss, true);
    view.removeEventListener("blur", dismiss);
    view.removeEventListener("resize", dismiss);
  };
}
