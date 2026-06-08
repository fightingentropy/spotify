// Shared helpers for the licensed-source download providers (qobuz/tidal/amazon).
// These were copy-pasted across providers; extracted here verbatim so the four
// providers stay byte-for-byte identical in behavior.

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function normalizeSearchValue(value: string): string {
  const replacer = new Map([
    ["&", " and "],
    ["feat.", " "],
    ["ft.", " "],
    ["/", " "],
    ["-", " "],
    ["_", " "],
  ]);
  let normalized = value.toLowerCase().trim();
  for (const [from, to] of replacer) {
    normalized = normalized.replaceAll(from, to);
  }
  return normalized.split(/\s+/).filter(Boolean).join(" ");
}

export type FetchWithTimeoutOptions = {
  method?: string;
  body?: BodyInit;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  timeoutMs?: number;
};

// Wrap fetch with an AbortController-backed timeout and default UA/Accept
// headers. The provider supplies its own timeout default and the error to throw
// when the request times out, so each provider keeps its existing behavior.
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions | undefined,
  config: { defaultTimeoutMs: number; onTimeout: () => Error },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? config.defaultTimeoutMs,
  );
  const headers = new Headers(options?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_USER_AGENT);
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/plain, */*");
  }

  try {
    return await fetch(url, {
      method: options?.method ?? "GET",
      body: options?.body,
      redirect: options?.redirect ?? "follow",
      signal: controller.signal,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw config.onTimeout();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
