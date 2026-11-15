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
  expandForResults?: boolean;
  /** "dialog" focuses the dialog itself instead of its first field or primary button, for
   *  prompts that open on their own (an agent's request) while the user may be typing. */
  initialFocus?: "auto" | "dialog";
}

export function Modal({ title, subtitle, icon, tone = "accent", wide, children, footer, onClose, onSubmit, sizeKey, expandForResults, initialFocus = "auto" }: ModalProps) {
  const ref = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const size = useWindowSize(sizeKey ?? (typeof title === "string" ? title : wide ? "Wide dialog" : "Dialog"));
  const expandedForResults = useRef(false);
  useLayoutEffect(() => {
    if (!expandForResults || expandedForResults.current || !ref.current || !size.value) return;
    expandedForResults.current = true;
    const dialog = ref.current;
    const minHeight = Math.min(360, dialog.ownerDocument.defaultView!.innerHeight - 48);
    if (dialog.offsetHeight < minHeight) size.resize({ ...size.value, height: minHeight });
  }, [expandForResults, size.value, size.resize]);
  // Callers pass a new onClose on every render; keep the latest without re-running the effect,
  // which would re-focus and select the input after each keystroke (typing replaced the text).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Typed input is never thrown away by a stray click beside the dialog.
  const dirty = useRef(false);
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
    // Keep keyboard focus inside the top dialog: the app behind it must not take Enter/Space.
    const isTop = () => { const dialogs = doc.querySelectorAll(".modal"); return dialogs[dialogs.length - 1] === ref.current; };
    const onFocusIn = (e: FocusEvent) => {
      const dialog = ref.current;
      const target = e.target as HTMLElement | null;
      if (!dialog || !target || !isTop() || dialog.contains(target)) return;
      // Menus, pickers and toasts opened from the dialog live outside it.
      if (target.closest(".ctx-menu, .palette, .toasts, [data-dialog-companion]")) return;
      (focusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };
    doc.addEventListener("focusin", onFocusIn);
    // Focus the first input once, when the dialog opens, for keyboard-first use.
    const cancelFocus = scheduleDialogFocus(() => ref.current, initialFocus);
    return () => {
      view.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("focusin", onFocusIn);
      cancelFocus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !dirty.current && onClose()}>
      <form
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        style={size.style}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
        onInput={() => { dirty.current = true; }}
        onKeyDown={(e) => {
          if (e.key === "Tab" && ref.current) {
            // Wrap Tab and Shift+Tab inside the dialog.
            const items = focusables(ref.current);
            if (items.length) {
              const first = items[0], last = items[items.length - 1];
              const active = ref.current.ownerDocument.activeElement;
              if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); return; }
              if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return; }
            }
          }
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

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable=true]";

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest("[inert]") && el.getClientRects().length > 0);
}
