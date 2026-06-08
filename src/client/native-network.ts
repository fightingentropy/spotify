"use client";

import { Capacitor } from "@capacitor/core";
import { rewriteNativeApiUrl } from "@/lib/native-api";

let installed = false;

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function rewriteApiUrl(value: string): string {
  return isNative() ? rewriteNativeApiUrl(value) : value;
}

function rewriteFetchInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string") return rewriteApiUrl(input);
  if (input instanceof URL) return new URL(rewriteApiUrl(input.toString()));
  if (input instanceof Request) {
    const rewritten = rewriteApiUrl(input.url);
    return rewritten === input.url ? input : new Request(rewritten, input);
  }
  return input;
}

export function installNativeNetworkBridge(): void {
  if (installed || typeof window === "undefined" || !isNative()) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return originalFetch(rewriteFetchInput(input), init);
  }) as typeof window.fetch;
}
