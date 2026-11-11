const controls = ".icon-btn, .library-drag-handle, button[data-tooltip], button[aria-label]:has(> svg)";

/** One tooltip per window. Delegate so dynamically mounted icons behave the same as the toolbar. */
export function installIconHints(doc: Document): () => void {
  const view = doc.defaultView!;
  const tip = doc.createElement("div");
  tip.className = "revqora-tooltip";
  tip.setAttribute("role", "tooltip");
  let current: HTMLElement | null = null;
  let nativeTitle: string | null = null;
  let blocked: HTMLElement | null = null;
  const hide = () => {
    if (current && nativeTitle !== null && !current.hasAttribute("title")) current.setAttribute("title", nativeTitle);
    nativeTitle = null;
    current = null;
    tip.remove();
  };
  const control = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>(controls) ?? null;
  const show = (next: HTMLElement | null) => {
    if (next === current || next !== null && next === blocked) return;
    hide();
    if (!next?.isConnected) return;
    const title = next.getAttribute("title");
    const label = next.dataset.tooltip || title || next.getAttribute("aria-label");
    if (!label?.trim()) return;
    current = next;
    nativeTitle = title;
    next.removeAttribute("title");
    tip.textContent = label;
    doc.body.append(tip);
    const rect = next.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.left + (rect.width - tip.offsetWidth) / 2, view.innerWidth - tip.offsetWidth - 8));
    const below = rect.bottom + 6;
    tip.style.left = `${x}px`;
    tip.style.top = `${below + tip.offsetHeight + 8 <= view.innerHeight ? below : Math.max(8, rect.top - tip.offsetHeight - 6)}px`;
  };
  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const next = control(e.target);
    if (next !== blocked) blocked = null;
    show(next);
  };
  const out = (e: PointerEvent) => {
    const next = control(e.relatedTarget);
    if (control(e.target) !== next) {
      blocked = null;
      hide();
    }
  };
  const dismiss = () => { blocked = current; hide(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
  doc.addEventListener("pointerover", over, true);
  doc.addEventListener("pointermove", over, true);
  doc.addEventListener("pointerout", out, true);
  doc.addEventListener("pointerdown", dismiss, true);
  doc.addEventListener("keydown", key, true);
  doc.addEventListener("scroll", hide, true);
  view.addEventListener("blur", hide);
  view.addEventListener("resize", hide);
  const changes = new MutationObserver(() => { if (current && !current.isConnected) hide(); });
  changes.observe(doc.body, { childList: true, subtree: true });
  return () => {
    hide();
    changes.disconnect();
    doc.removeEventListener("pointerover", over, true);
    doc.removeEventListener("pointermove", over, true);
    doc.removeEventListener("pointerout", out, true);
    doc.removeEventListener("pointerdown", dismiss, true);
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("scroll", hide, true);
    view.removeEventListener("blur", hide);
    view.removeEventListener("resize", hide);
  };
}
