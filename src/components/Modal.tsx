import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { scheduleDialogFocus } from "../lib/dialogFocus";
import { useWindowSize, WindowResizeGrip } from "./WindowResize";

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  tone?: "accent" | "danger" | "warn";
  wide?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  sizeKey?: string;
}

export function Modal({ title, subtitle, icon, tone = "accent", wide, children, footer, onClose, onSubmit, sizeKey }: ModalProps) {
  const ref = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const size = useWindowSize(sizeKey ?? (typeof title === "string" ? title : wide ? "Wide dialog" : "Dialog"));
  // Callers pass a new onClose on every render; keep the latest without re-running the effect,
  // which would re-focus and select the input after each keystroke (typing replaced the text).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const backdrop = ref.current!.parentElement!;
    const doc = backdrop.ownerDocument;
    const previous = doc.activeElement as HTMLElement | null;
    const reconcile = (closing?: Element) => {
      const layers = [...doc.querySelectorAll<HTMLElement>(".modal-backdrop")].filter(el => el !== closing);
      for (const layer of layers) { layer.inert = layer !== layers.at(-1); if(layer.inert)layer.setAttribute("aria-hidden","true");else layer.removeAttribute("aria-hidden"); }
    };
    reconcile();
    return () => { reconcile(backdrop); queueMicrotask(() => { if(previous?.isConnected&&!previous.closest("[inert]"))previous.focus({preventScroll:true}); }); };
  }, []);
  useEffect(() => {
    const doc = ref.current!.ownerDocument;
    const view = doc.defaultView!;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if ((e.target as HTMLElement)?.closest?.("[data-shortcut-capture]")) return;
        if(doc.querySelector(".ctx-menu"))return;
        // A confirmation can sit above an editor. Only the top dialog handles Escape.
        const dialogs = doc.querySelectorAll(".modal");
        if (dialogs[dialogs.length - 1] !== ref.current) return;
        e.preventDefault(); e.stopImmediatePropagation();
        closeRef.current();
      }
    };
    view.addEventListener("keydown", onKey, true);
    // Focus the first input once, when the dialog opens, for keyboard-first use.
    const cancelFocus = scheduleDialogFocus(() => ref.current);
    return () => {
      view.removeEventListener("keydown", onKey, true);
      cancelFocus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        style={size.style}
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        <div className="modal-head">
          {icon && <div className={`mi ${tone === "accent" ? "" : tone}`}>{icon}</div>}
          <div style={{ minWidth: 0 }}>
            <h3 id={titleId}>{title}</h3>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
        <WindowResizeGrip surface={ref} size={size}/>
      </form>
    </div>
  );
}
