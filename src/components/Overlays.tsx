import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, ChevronRight, Info, TriangleAlert, X } from "lucide-react";
import { useUi, type MenuItem } from "../lib/ui";
import { surfaceDocument } from "../lib/uiSurfaces";

export function ContextMenuHost() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  useEffect(() => {
    if (!menu) return;
    const view = menu.surface;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => { if(e.key === "Escape") {e.preventDefault();e.stopImmediatePropagation();close();} };
    view.addEventListener("mousedown", onDown, true);
    view.addEventListener("keydown", onKey);
    view.addEventListener("blur", close);
    view.addEventListener("resize", close);
    return () => {
      view.removeEventListener("mousedown", onDown, true);
      view.removeEventListener("keydown", onKey);
      view.removeEventListener("blur", close);
      view.removeEventListener("resize", close);
    };
  }, [menu, close]);
  if (!menu) return null;
  const content = <Menu x={menu.x} y={menu.y} items={menu.items} onDone={close} />;
  const body = surfaceDocument(menu.surface)?.body;
  return menu.surface === window ? content : body ? createPortal(content, body) : null;
}

function Menu({ x, y, items, onDone }: { x: number; y: number; items: MenuItem[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView!;
    setPos({ x: Math.max(6, Math.min(x, view.innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, view.innerHeight - r.height - 6)) });
  }, [x, y]);
  return (
    <>
      <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <div
              key={i}
              className={`ctx-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""} ${sub?.i === i ? "open" : ""}`}
              onMouseEnter={(e) => {
                if (it.children) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ i, x: r.right + 2, y: r.top - 5 });
                } else setSub(null);
              }}
              onClick={() => {
                if (it.disabled || it.children) return;
                onDone();
                it.onClick?.();
              }}
            >
              <span className="ic">{it.checked ? <CheckCircle2 size={14} /> : it.icon}</span>
              <span>{it.label}</span>
              {it.children ? <ChevronRight size={14} className="hint" /> : it.hint ? <span className="hint">{it.hint}</span> : null}
            </div>
          ),
        )}
      </div>
      {sub && items[sub.i]?.children && <Menu x={sub.x} y={sub.y} items={items[sub.i].children!} onDone={onDone} />}
    </>
  );
}

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="ti">
            {t.kind === "success" ? <CheckCircle2 size={17} /> : t.kind === "error" ? <AlertCircle size={17} /> : t.kind === "warning" ? <TriangleAlert size={17} /> : <Info size={17} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tt">{t.title}</div>
            {t.detail && <div className="td">{t.detail}</div>}
            {t.action && (
              <button
                className="btn sm"
                style={{ marginTop: 8 }}
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DialogHost() {
  const dialogs = useUi((s) => s.dialogs);
  return (
    <>
      {dialogs.map(d => {
        if (d.surface === window) return <div key={d.id}>{d.render(d.resolve)}</div>;
        const body = surfaceDocument(d.surface)?.body;
        return body ? createPortal(<div>{d.render(d.resolve)}</div>, body, d.id) : null;
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
          onDrag(current - position.current);
        }
        position.current = current;
      }}
      onLostPointerCapture={e => {
        if (position.current === null) return;
        position.current = null;
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
