"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

// Spotify-style overflow marquee: single line, and when the text is wider than
// its container it slowly scrolls to the end, holds, and returns. Stays a
// plain truncated line when it fits, so surrounding layout never reflows.
export function MarqueeText({ text, className }: { text: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const span = textRef.current;
    if (!container || !span || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const overflow = span.scrollWidth - container.clientWidth;
      setDistance(overflow > 8 ? overflow : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(span);
    return () => observer.disconnect();
  }, [text]);

  const active = distance > 0;
  // Constant scroll speed so short and long overflows feel the same; the
  // hold percentages live in the keyframes.
  const durationSeconds = Math.max(7, distance / 28 + 4);

  return (
    <div ref={containerRef} className={cn("wf-marquee", active && "wf-marquee-active", className)}>
      <span
        ref={textRef}
        className="wf-marquee-inner"
        style={
          active
            ? ({
                "--wf-marquee-distance": `${distance}px`,
                "--wf-marquee-duration": `${durationSeconds}s`,
              } as CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </div>
  );
}
