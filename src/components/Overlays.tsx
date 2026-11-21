import { menuFocusTarget } from "../lib/keyboardFocus";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, ChevronRight, Info, TriangleAlert, X } from "lucide-react";
import { copyText, toast, useUi, type MenuItem } from "../lib/ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { detailsNeedExpanding } from "../lib/toastDetails";
import { surfaceDocument } from "../lib/uiSurfaces";
import { bindingFor, prettyCombo } from "../lib/shortcuts";

export function ContextMenuHost() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  useEffect(() => {
    if (!menu) return;
    const view = menu.surface;
    // Keyboard users return to where they opened the menu (recorded before the menu took focus).
    const previous = menu.opener;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => { if(e.key === "Escape" && !(e.target as HTMLElement)?.closest?.(".ctx-sub")) {e.preventDefault();e.stopImmediatePropagation();close();} };
    view.addEventListener("mousedown", onDown, true);
    view.addEventListener("keydown", onKey);
    view.addEventListener("blur", close);
    view.addEventListener("resize", close);
    return () => {
      view.removeEventListener("mousedown", onDown, true);
      view.removeEventListener("keydown", onKey);
      view.removeEventListener("blur", close);
      view.removeEventListener("resize", close);
      // The menu is still in the DOM here; after it unmounts focus would fall to the body.
      queueMicrotask(() => {
        menuFocusTarget(previous, view.document.activeElement, view.document.body)?.focus({ preventScroll: true });
      });
    };
  }, [menu, close]);
  if (!menu) return null;
  const content = <Menu x={menu.x} y={menu.y} items={menu.items} onDone={close} />;
  const body = surfaceDocument(menu.surface)?.body;
  return menu.surface === window ? content : body ? createPortal(content, body) : null;
}

/** Menu items that can take focus (separators and disabled items are skipped). */
const focusableItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>(":scope > .ctx-item:not(.disabled)") ?? [])];

function Menu({ x, y, items, onDone, onBack, level = 0, autoFocus = true }: { x: number; y: number; items: MenuItem[]; onDone: () => void; onBack?: () => void; level?: number; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number; keyboard: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView!;
    setPos({ x: Math.max(6, Math.min(x, view.innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, view.innerHeight - r.height - 6)) });
  }, [x, y]);
  // The menu takes focus so arrows, Enter and Escape work right away.
  // A submenu opened by hovering leaves focus where the mouse user has it.
  useEffect(() => { if (autoFocus) (focusableItems(ref.current)[0] ?? ref.current)?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openSub = (i: number, el: HTMLElement, keyboard: boolean) => {
    const r = el.getBoundingClientRect();
    setSub({ i, x: r.right + 2, y: r.top - 5, keyboard });
  };
  const activate = (it: MenuItem, i: number, el: HTMLElement, keyboard: boolean) => {
    if (it.disabled) return;
    if (it.children) { openSub(i, el, keyboard); return; }
    onDone();
    it.onClick?.();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = focusableItems(ref.current);
    const at = list.indexOf(e.target as HTMLElement);
    const move = (index: number) => { e.preventDefault(); e.stopPropagation(); list[(index + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if ((e.key === "ArrowLeft" || e.key === "Escape") && onBack) { e.preventDefault(); e.stopPropagation(); onBack(); }
    else if (e.key === "Tab") { e.preventDefault(); onDone(); }
  };
  return (
    <>
      <div className={`ctx-menu ${level ? "ctx-sub" : ""}`} ref={ref} role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
        {items.map((it, i) => {
          const hint = it.hint ?? (it.shortcut ? prettyCombo(bindingFor(it.shortcut)) : "");
          return it.separator ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <div
              key={i}
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined}
              aria-label={it.label}
              aria-disabled={it.disabled || undefined}
              aria-haspopup={it.children ? "menu" : undefined}
              aria-expanded={it.children ? sub?.i === i : undefined}
              tabIndex={-1}
              className={`ctx-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""} ${sub?.i === i ? "open" : ""}`}
              onMouseEnter={(e) => {
                if (it.children) openSub(i, e.currentTarget as HTMLElement, false);
                else setSub(null);
              }}
              onClick={(e) => activate(it, i, e.currentTarget as HTMLElement, false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && it.children)) {
                  e.preventDefault();
                  e.stopPropagation();
                  activate(it, i, e.currentTarget as HTMLElement, true);
                }
              }}
            >
              <span className="ic">{it.checked ? <CheckCircle2 size={14} /> : it.icon}</span>
              <span className="ctx-label" title={it.label}>{it.label}</span>
              {it.children ? <ChevronRight size={14} className="hint" /> : hint && <span className="hint">{hint}</span>}
            </div>
          );
        })}
      </div>
      {sub && items[sub.i]?.children && <Menu key={sub.i} x={sub.x} y={sub.y} items={items[sub.i].children!} onDone={onDone} level={level + 1} autoFocus={sub.keyboard}
        onBack={() => { const index = sub.i; setSub(null); requestAnimationFrame(() => ref.current?.querySelectorAll<HTMLElement>(":scope > [role^=menuitem]")[items.slice(0, index).filter(item => !item.separator).length]?.focus()); }} />}
    </>
  );
}

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const hold = useUi((s) => s.holdToast);
  // Expanded toasts take the pointer (scroll, select) and stay until collapsed or dismissed.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) { next.delete(id); hold(id, false, "expanded"); } else { next.add(id); hold(id, true, "expanded"); }
    return next;
  });
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind} ${expanded.has(t.id) ? "expanded" : ""}`} role={t.kind === "error" ? "alert" : "status"} aria-live={t.kind === "error" ? "assertive" : "polite"} aria-atomic="true"
          onFocus={() => hold(t.id, true, "focus")} onBlur={() => hold(t.id, false, "focus")}>
          <span className="ti">
            {t.kind === "success" ? <CheckCircle2 size={17} /> : t.kind === "error" ? <AlertCircle size={17} /> : t.kind === "warning" ? <TriangleAlert size={17} /> : <Info size={17} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tt">{t.title}</div>
            {t.detail && <div className={`td ${detailsNeedExpanding(t.detail) && !expanded.has(t.id) ? "clamped" : ""}`}>{t.detail}</div>}
            {detailsNeedExpanding(t.detail) && (
              <div className="toast-detail-actions">
                <button type="button" className="btn sm ghost" aria-expanded={expanded.has(t.id)} onClick={() => toggle(t.id)}>{expanded.has(t.id) ? "Less" : "Details"}</button>
                <button type="button" className="btn sm ghost" onMouseEnter={() => hold(t.id, true)} onMouseLeave={() => hold(t.id, false)}
                  onClick={() => void copyText(`${t.title}
${t.detail}`, "Details copied")}>Copy</button>
              </div>
            )}
            {t.action && (
              <button
                className="btn sm"
                style={{ marginTop: 8 }}
                onMouseEnter={() => hold(t.id, true)}
                onMouseLeave={() => hold(t.id, false)}
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn sm" onClick={() => { setExpanded((c) => { const n = new Set(c); n.delete(t.id); return n; }); dismiss(t.id); }} aria-label="Dismiss" onMouseEnter={() => hold(t.id, true)} onMouseLeave={() => hold(t.id, false)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

type ShownDialog = ReturnType<typeof useUi.getState>["dialogs"][number];

function DialogBody({ dialog }: { dialog: ShownDialog }) {
  return <>{dialog.render(dialog.resolve)}</>;
}

/** A dialog that fails to draw is closed with no answer (what Cancel gives), on its own: the
 *  dialogs behind it stay, and it does not fail again and again. */
function GuardedDialog({ dialog }: { dialog: ShownDialog }) {
  const failed = () => {
    dialog.resolve(null);
    toast.warning("A dialog could not be shown", "It was closed without an answer. The error is in the error log.");
  };
  return <ErrorBoundary area="Dialog" quiet onError={failed}><DialogBody dialog={dialog} /></ErrorBoundary>;
}

export function DialogHost() {
  const dialogs = useUi((s) => s.dialogs);
  return (
    <>
      {dialogs.map(d => {
        if (d.surface === window) return <div key={d.id}><GuardedDialog dialog={d} /></div>;
        const body = surfaceDocument(d.surface)?.body;
        return body ? createPortal(<div><GuardedDialog dialog={d} /></div>, body, d.id) : null;
      })}
    </>
  );
}

export function Splitter({ dir, onDrag, onStart, onCommit, onEnd, style, label }: {
  dir: "v" | "h"; onDrag: (delta: number) => void; onStart?: () => void; onCommit?: () => void; onEnd?: () => void;
  style?: React.CSSProperties; label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const position = useRef<number | null>(null);
  const moved = useRef(false);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  // Pointer moves arrive faster than frames: apply their sum once per frame, so a drag
  // re-renders the panes at most at the display rate.
  const dragRef = useRef(onDrag);
  dragRef.current = onDrag;
  const pending = useRef(0);
  const frame = useRef<{ view: Window; id: number } | null>(null);
  const flush = () => {
    if (frame.current) frame.current.view.cancelAnimationFrame(frame.current.id);
    frame.current = null;
    const delta = pending.current;
    pending.current = 0;
    if (delta) dragRef.current(delta);
  };
  const finish = (view: Window | null) => {
    // Ref-backed sizes can persist immediately. State-backed callers read after React renders.
    onCommit?.();
    if (endRef.current) view?.requestAnimationFrame(() => endRef.current?.());
  };
  return (
    <div
      className={`splitter-${dir} ${dragging ? "dragging" : ""}`}
      style={style}
      role="separator"
      aria-orientation={dir === "v" ? "vertical" : "horizontal"}
      aria-label={label ?? (dir === "v" ? "Resize pane width" : "Resize pane height")}
      tabIndex={0}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        position.current = dir === "v" ? e.clientX : e.clientY;
        moved.current = false;
        onStart?.();
        setDragging(true);
      }}
      onPointerMove={e => {
        if (position.current === null) return;
        const current = dir === "v" ? e.clientX : e.clientY;
        if (current !== position.current) {
          moved.current = true;
          pending.current += current - position.current;
          const view = e.currentTarget.ownerDocument.defaultView;
          if (!frame.current && view) frame.current = { view, id: view.requestAnimationFrame(() => { frame.current = null; flush(); }) };
          else if (!view) flush();
        }
        position.current = current;
      }}
      onLostPointerCapture={e => {
        if (position.current === null) return;
        position.current = null;
        flush();
        setDragging(false);
        if (moved.current) finish(e.currentTarget.ownerDocument.defaultView);
      }}
      onKeyDown={e => {
        const [before, after] = dir === "v" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (e.key !== before && e.key !== after) return;
        e.preventDefault();
        onStart?.();
        onDrag(e.key === before ? -16 : 16);
        finish(e.currentTarget.ownerDocument.defaultView);
      }}
    />
  );
}
