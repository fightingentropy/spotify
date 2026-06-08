import { createHash } from "node:crypto";

// Shared GDStudio (music.gdstudio.xyz / .org) request-signing primitives.
//
// GDStudio signs `host|paddedVersion|timestamp|encodedValue`, MD5s it, and
// takes the last 8 hex chars (uppercased). The signed `encodedValue` MUST be
// the percent-encoded form of the parameter exactly as it appears in the POST
// body. The qobuz and tidal copies had DRIFTED: qobuz used
// `encodeURIComponent(v).replaceAll("+", "%20")` (a no-op after
// encodeURIComponent, which never emits "+") and did NOT escape ! ' ( ) * ,
// while tidal used the stricter `gdStudioUrlEncode` and put that same encoded
// value in the body. The tidal escaping is the correct one — it matches
// GDStudio's API expectation and keeps the body value and the signed value
// identical — so both providers now share `gdStudioUrlEncode` below.

export function gdStudioPaddedVersion(version: string): string {
  return version
    .split(".")
    .map((part) => (part.trim().length === 1 ? `0${part.trim()}` : part.trim()))
    .join("");
}

// Percent-encode a value the way GDStudio expects: encodeURIComponent plus the
// reserved characters it leaves untouched (! ' ( ) *).
export function gdStudioUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/!/g, "%21");
}

// Compute the 8-char GDStudio request signature for an already-encoded value.
export function gdStudioSignature(
  host: string,
  encodedValue: string,
  timestamp: string,
  version: string,
): string {
  const signatureBase = `${host}|${gdStudioPaddedVersion(version)}|${timestamp}|${encodedValue}`;
  return createHash("md5").update(signatureBase).digest("hex").toUpperCase().slice(-8);
}
