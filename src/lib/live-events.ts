// Live Events (concerts) for the "Live Events" page.
//
// Live data comes from the worker's /api/events route (a Ticketmaster Discovery
// proxy, key kept server-side). When that key is unset the route returns no
// sections and the page shows its empty state.
// This mirrors mobile/src/lib/live-events.ts — keep the two in sync.

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
