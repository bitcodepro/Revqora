import { useEffect, useRef, type ReactNode } from "react";

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
}

export function Modal({ title, subtitle, icon, tone = "accent", wide, children, footer, onClose, onSubmit }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; keep the latest without re-running the effect,
  // which would re-focus and select the input after each keystroke (typing replaced the text).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A confirmation can sit above an editor. Only the top dialog handles Escape.
        const dialogs = document.querySelectorAll(".modal");
        if (dialogs[dialogs.length - 1] !== ref.current) return;
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Focus the first input once, when the dialog opens, for keyboard-first use.
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]), textarea, select, button.primary");
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(t);
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref as never}
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
            <h3>{title}</h3>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </form>
    </div>
  );
}
