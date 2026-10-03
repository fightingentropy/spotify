import { Children, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function HomeRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const rowId = useId();
  const count = Children.count(children);
  const [edges, setEdges] = useState({ overflow: false, start: true, end: false });
  const updateEdges = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const max = row.scrollWidth - row.clientWidth;
    const next = { overflow: max > 2, start: row.scrollLeft <= 2, end: row.scrollLeft >= max - 2 };
    setEdges((current) => current.overflow === next.overflow && current.start === next.start && current.end === next.end ? current : next);
  }, []);

  useEffect(() => {
    updateEdges();
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(row);
    return () => observer.disconnect();
  }, [count, updateEdges]);

  const move = (direction: number) => {
    const row = rowRef.current;
    if (!row) return;
    const tile = row.firstElementChild?.getBoundingClientRect().width ?? 190;
    const gap = Number.parseFloat(window.getComputedStyle(row).columnGap) || 12;
    const step = tile + gap;
    const page = Math.max(1, Math.floor(row.clientWidth / step)) * step;
    row.scrollBy({
      left: direction * page,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };

  return (
    <section aria-labelledby={`${rowId}-heading`} className="home-row">
      <div className="home-row-heading">
        <div className="min-w-0">
          <h2 id={`${rowId}-heading`} className="wf-section-title">{title}</h2>
          {description ? <p className="mt-1 text-[13px] leading-5 text-white/45">{description}</p> : null}
        </div>
        {edges.overflow ? (
          <div className="flex shrink-0 gap-1">
            {[-1, 1].map((direction) => (
              <button
                key={direction}
                type="button"
                aria-label={`${direction < 0 ? "Previous" : "Next"} ${title.toLowerCase()} items`}
                aria-controls={rowId}
                disabled={direction < 0 ? edges.start : edges.end}
                onClick={() => move(direction)}
                className="wf-icon-button disabled:opacity-25"
              >
                {direction < 0 ? <ChevronLeft size={19} /> : <ChevronRight size={19} />}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div
        ref={rowRef}
        id={rowId}
        onScroll={updateEdges}
        className="home-rail"
      >
        {children}
      </div>
    </section>
  );
}
