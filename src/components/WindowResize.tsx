import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { MoveDiagonal2 } from "lucide-react";
import { Splitter } from "./Overlays";

interface Size { width: number; height: number }
const SIZE_STORAGE = "revqora:window-sizes";

function savedSizes(): Record<string, Size> {
  try { return JSON.parse(localStorage.getItem(SIZE_STORAGE) ?? "{}") ?? {}; } catch { return {}; }
}

function saveSize(key: string, size: Size | undefined) {
  try {
    const values = Object.entries(savedSizes()).filter(([id]) => id !== key).slice(-79);
    localStorage.setItem(SIZE_STORAGE, JSON.stringify(Object.fromEntries(size ? [...values, [key, size]] : values)));
  } catch { /* The current size is still applied if storage is unavailable. */ }
}

export function useWindowSize(key: string) {
  const [size, setSize] = useState(() => {
    const value = savedSizes()[key];
    return value && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0 ? value : undefined;
  });
  const style = { "--saved-window-width": size ? `${size.width}px` : undefined, "--saved-window-height": size ? `${size.height}px` : undefined } as CSSProperties;
  return { value: size, style, resize: setSize, remember: (next: Size | undefined) => { setSize(next); saveSize(key, next); } };
}

export function useToolDetailSize(key: string, breakpoint: number) {
  const body = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const size = useWindowSize(key);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth <= breakpoint));
    observer.observe(el);
    return () => observer.disconnect();
  }, [breakpoint]);
  return {
    body, detail, style: size.style, narrow,
    divider: <Splitter dir={narrow ? "h" : "v"} label="Resize details pane" style={narrow ? undefined : { right: 0 }}
      onDrag={delta => {
        const panel = detail.current, container = body.current;
        if (!panel || !container) return;
        size.resize(previous => {
          const width = previous?.width ?? (narrow ? Math.max(240, container.clientWidth * 0.28) : panel.offsetWidth);
          const height = previous?.height ?? (narrow ? panel.offsetHeight : Math.max(90, container.clientHeight * 0.42));
          return narrow
            ? { width, height: Math.max(90, Math.min(container.clientHeight * 0.65, height - delta)) }
            : { height, width: Math.max(210, Math.min(container.clientWidth * 0.65, width - delta)) };
        });
      }} onEnd={() => size.remember(size.value)}/>,
  };
}

export function WindowResizeGrip({ surface, size, embedded = false }: {
  surface: RefObject<HTMLElement | null>;
  size: ReturnType<typeof useWindowSize>;
  embedded?: boolean;
}) {
  const drag = useRef<{ x: number; y: number; bounds: Size; current: Size } | null>(null);
  const clamp = (width: number, height: number): Size => {
    const el = surface.current!;
    const view = el.ownerDocument.defaultView!;
    const parent = embedded ? el.parentElement : null;
    const margin = embedded ? 24 : 48;
    const maxWidth = (parent?.clientWidth ?? view.innerWidth) - margin;
    const maxHeight = (parent?.clientHeight ?? view.innerHeight) - margin;
    return { width: Math.max(1, Math.round(Math.min(maxWidth, Math.max(300, width)))), height: Math.max(1, Math.round(Math.min(maxHeight, Math.max(220, height)))) };
  };
  const finish = () => {
    if (!drag.current) return;
    size.remember(drag.current.current);
    drag.current = null;
  };
  return <button type="button" className="window-resize-grip" aria-label="Resize window" title="Resize window · Double-click to reset"
    onPointerDown={e => {
      if (e.button !== 0 || !surface.current) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const { width, height } = surface.current.getBoundingClientRect();
      const bounds = { width, height };
      drag.current = { x: e.clientX, y: e.clientY, bounds, current: bounds };
    }}
    onPointerMove={e => {
      const state = drag.current;
      if (!state) return;
      state.current = clamp(state.bounds.width + (e.clientX - state.x) * 2, state.bounds.height + (e.clientY - state.y) * 2);
      size.resize(state.current);
    }}
    onLostPointerCapture={finish}
    onDoubleClick={() => size.remember(undefined)}
    onKeyDown={e => {
      if (!surface.current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "Home") { size.remember(undefined); return; }
      const { width, height } = surface.current.getBoundingClientRect();
      size.remember(clamp(width + (e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0), height + (e.key === "ArrowUp" ? -20 : e.key === "ArrowDown" ? 20 : 0)));
    }}><MoveDiagonal2 size={14}/></button>;
}
