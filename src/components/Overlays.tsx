import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Info, TriangleAlert, X } from "lucide-react";
import { useUi, type MenuItem } from "../lib/ui";

export function ContextMenuHost() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);
  if (!menu) return null;
  return <Menu x={menu.x} y={menu.y} items={menu.items} onDone={close} />;
}

function Menu({ x, y, items, onDone }: { x: number; y: number; items: MenuItem[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) });
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
      {dialogs.map((d) => (
        <div key={d.id}>{d.render(d.resolve)}</div>
      ))}
    </>
  );
}

export function Splitter({ dir, onDrag, onEnd, style }: { dir: "v" | "h"; onDrag: (delta: number) => void; onEnd?: () => void; style?: React.CSSProperties }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`splitter-${dir} ${dragging ? "dragging" : ""}`}
      style={style}
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
        let last = dir === "v" ? e.clientX : e.clientY;
        const move = (ev: MouseEvent) => {
          const cur = dir === "v" ? ev.clientX : ev.clientY;
          onDrag(cur - last);
          last = cur;
        };
        const up = () => {
          setDragging(false);
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          onEnd?.();
        };
        document.body.style.cursor = dir === "v" ? "col-resize" : "row-resize";
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    />
  );
}
