// Event types and date formatting for the Worker's live /api/events feed.
// An unavailable or unconfigured provider produces an empty state.

export type LiveEvent = {
  id: string;
  artists: string;
  venue: string;
  date: string; // ISO yyyy-mm-dd
  imageUrl: string;
  url?: string;
  genre?: string;
};

export type LiveEventSection = {
  key: string;
  eyebrow: string;
  title: string;
  events: LiveEvent[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parse a yyyy-mm-dd directly (avoids Date timezone drift) into a calendar badge.
export function formatEventDate(iso: string): { month: string; day: string } {
  const [, month, day] = iso.split("-").map((n) => parseInt(n, 10));
  return { month: MONTHS[(month - 1) % 12] ?? "", day: Number.isFinite(day) ? String(day) : "" };
}
