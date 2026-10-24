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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Focus the first input for keyboard-first use.
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]), textarea, select, button.primary");
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(t);
    };
  }, [onClose]);
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
