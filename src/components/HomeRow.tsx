import { Children, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function HomeRow({ title, children }: { title: string; children: ReactNode }) {
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
    const step = tile + 12;
    const page = Math.max(1, Math.floor(row.clientWidth / step)) * step;
    row.scrollBy({
      left: direction * page,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };

  return (
    <section aria-label={title} className="mb-[34px]">
      <div className="mb-3.5 flex min-h-10 items-center justify-between gap-3">
        <h2 className="text-[22px] font-bold tracking-[-0.35px]">{title}</h2>
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
                className="wf-control-button grid h-9 w-9 place-items-center rounded-full border border-white/10 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent"
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
        className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
      >
        {children}
      </div>
    </section>
  );
}
