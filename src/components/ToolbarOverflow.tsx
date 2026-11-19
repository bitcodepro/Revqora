import { useLayoutEffect, useRef, type ReactNode } from "react";

/** The repository toolbar. When its buttons do not fit, their text labels collapse to icons
 *  (names stay as tooltips and accessible names), so the actions stay visible instead of
 *  scrolling out of sight; horizontal scrolling remains only for very narrow windows. */
export function OverflowToolbar({ children, className = "toolbar" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const measure = () => {
      bar.classList.remove("compact");
      const overflowing = bar.scrollWidth > bar.clientWidth + 1;
      bar.classList.toggle("compact", overflowing);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (bar.parentElement) observer.observe(bar.parentElement);
    // Buttons and labels that change without a resize (a count, a new action).
    const content = new MutationObserver(measure);
    content.observe(bar, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); content.disconnect(); };
    // Set up once: measuring after every render forced a synchronous layout on each
    // toolbar update, also when nothing in it changed.
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}
