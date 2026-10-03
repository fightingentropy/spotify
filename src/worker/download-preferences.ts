import { isBlockedRemoteHostname } from "@/lib/safe-fetch";
import { ApiError } from "./http";
import type { SongPayload } from "./payloads";

export type DownloadPreferences = {
  resolver: "auto" | "song_link" | "songstats";
  resolverFallback: boolean;
  providerFallback: boolean;
  providerOrder: Array<"tidal" | "qobuz" | "amazon" | "deezer" | "apple">;
  atmosFallback: boolean;
  atmosFallbackQuality: "cd" | "hires48" | "max";
  customTidalUrl: string;
  customQobuzUrl: string;
};

export function instanceUrl(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > 2048) throw new ApiError("Invalid provider instance URL", 400);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ApiError("Invalid provider instance URL", 400); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || isBlockedRemoteHostname(url.hostname)) {
    throw new ApiError("Provider instances must use public HTTPS URLs without credentials or query strings", 400);
  }
  return url.toString().replace(/\/+$/, "");
}

export function downloadPreferences(payload: Pick<SongPayload, "downloadPreferences">): DownloadPreferences | undefined {
  const value = payload.downloadPreferences;
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError("Invalid download preferences",400);
  const raw = value as Record<string,unknown>;
  const resolver = raw.resolver ?? "auto";
  if (!["auto","song_link","songstats"].includes(String(resolver))) throw new ApiError("Invalid link resolver",400);
  const order = raw.providerOrder ?? ["tidal","qobuz","amazon"];
  if (!Array.isArray(order) || !order.length || order.length > 5 || new Set(order).size !== order.length ||
      order.some(p => !["tidal","qobuz","amazon","deezer","apple"].includes(p))) {
    throw new ApiError("Invalid provider order",400);
  }
  for (const key of ["resolverFallback","providerFallback","atmosFallback"]) {
    if (raw[key] != null && typeof raw[key] !== "boolean") throw new ApiError("Invalid fallback preference",400);
  }
  if (raw.atmosFallbackQuality != null && !["cd","hires48","max"].includes(String(raw.atmosFallbackQuality))) throw new ApiError("Invalid Atmos fallback quality",400);
  return {
    atmosFallback: raw.atmosFallback !== false,
    atmosFallbackQuality: (raw.atmosFallbackQuality ?? "max") as DownloadPreferences["atmosFallbackQuality"],
    resolver: resolver as DownloadPreferences["resolver"],
    resolverFallback: raw.resolverFallback !== false,
    providerFallback: raw.providerFallback !== false,
    providerOrder: order as DownloadPreferences["providerOrder"],
    customTidalUrl: instanceUrl(raw.customTidalUrl),
    customQobuzUrl: instanceUrl(raw.customQobuzUrl),
  };
}

export function resolverOrder(preferences: DownloadPreferences): Array<"song_link" | "songstats"> {
  const first = preferences.resolver === "songstats" ? "songstats" : "song_link";
  return preferences.resolverFallback ? [first, first === "songstats" ? "song_link" : "songstats"] : [first];
}
