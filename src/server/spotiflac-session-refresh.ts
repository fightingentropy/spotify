import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  SPOTIFLAC_SESSION_REFRESH_AHEAD_MS,
  SPOTIFLAC_PROTOCOL_VERSION,
  spotiflacCommunitySessionNeedsRefresh,
} from "../lib/spotiflac-community";

const DEFAULT_VERIFY_URL = "https://verify.spotbye.qzz.io";
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 32 * 1024;

export type DesktopSpotiflacSessionRecord = {
  install_id?: string;
  session_id?: string;
  session_secret?: string;
  expires_at?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function sameSecretText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function desktopSpotiflacSessionPath(): string {
  return process.env.SPOTIFLAC_SESSION_FILE?.trim() || join(homedir(), ".streamarena-music", "provider-session.json");
}

async function readSessionRecord(path: string): Promise<DesktopSpotiflacSessionRecord> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RESPONSE_BYTES) throw new Error("Invalid provider session file");
    const bytes = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes,0,bytes.length,0);
    if (bytesRead > MAX_RESPONSE_BYTES) throw new Error("Provider session file is too large");
    raw = bytes.toString("utf8",0,bytesRead);
  } finally { await handle.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid provider session JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid provider session record");
  const record = parsed as Record<string,unknown>;
  for (const field of ["install_id","session_id","session_secret","expires_at"]) {
    if (record[field] != null && (typeof record[field] !== "string" || (record[field] as string).length > 4096)) {
      throw new Error("Invalid provider session field");
    }
  }
  return record as DesktopSpotiflacSessionRecord;
}

export async function readDesktopSpotiflacSession(
  path = desktopSpotiflacSessionPath(),
): Promise<DesktopSpotiflacSessionRecord> {
  try {
    return await readSessionRecord(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (path === desktopSpotiflacSessionPath() && !process.env.SPOTIFLAC_SESSION_FILE?.trim()) {
        return migrateProviderSession(path);
      }
      return {};
    }
    throw new Error(`Could not read the SpotiFLAC session: ${error instanceof Error ? error.message : "invalid file"}`, {
      cause: error,
    });
  }
}

async function writePrivateFile(path: string, contents: string, replace = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid provider session directory");
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomHex(4)}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag:"wx" });
    await chmod(temporaryPath, 0o600);
    if (replace) await rename(temporaryPath, path);
    else {
      // link is an atomic create-if-absent; a racing renewal must never lose its newer session.
      await link(temporaryPath,path);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function migrateProviderSession(
  destination: string,
  legacyPath = join(homedir(), ".spotiflac", "community_session.json"),
): Promise<DesktopSpotiflacSessionRecord> {
  // Migrate once, keeping the old record intact until the replacement is verified.
  try {
    return await readSessionRecord(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let record: DesktopSpotiflacSessionRecord;
  try {
    record = await readSessionRecord(legacyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not migrate the provider session", { cause:error });
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid provider session");
  try {
    await writePrivateFile(destination, `${JSON.stringify(record, null, 2)}\n`,false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readSessionRecord(destination);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("SpotiFLAC verification returned an oversized response");
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error("SpotiFLAC verification returned invalid JSON");
  }
}

function verificationBaseUrl(): URL {
  const base = new URL(process.env.SPOTIFLAC_VERIFY_URL?.trim() || DEFAULT_VERIFY_URL);
  if (base.protocol !== "https:") throw new Error("SpotiFLAC verification must use HTTPS");
  return base;
}

async function openVerificationPage(url: URL): Promise<void> {
  const processHandle = Bun.spawn(["/usr/bin/open", url.toString()], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) throw new Error("Could not open the SpotiFLAC verification page");
}

const VERIFIED_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verified</title></head><body style="font:16px system-ui;background:#000;color:#fff;display:grid;place-items:center;min-height:100vh"><main><h1>Verified</h1><p>You can close this tab.</p></main><script>setTimeout(()=>window.close(),700)</script></body></html>`;

async function requestVerificationGrant(record: DesktopSpotiflacSessionRecord, appVersion: string): Promise<string> {
  const installId = text(record.install_id);
  if (!installId) throw new Error("SpotiFLAC install ID is missing");
  const callbackState = randomHex(16);
  let resolveGrant!: (grant: string) => void;
  const grantPromise = new Promise<string>((resolve) => {
    resolveGrant = resolve;
  });
  const callbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.pathname !== "/session-grant") {
        return new Response("Not found", { status: 404 });
      }
      if (!sameSecretText(url.searchParams.get("state") || "", callbackState)) {
        return new Response("Invalid verification callback state", { status: 400 });
      }
      const grant = text(url.searchParams.get("grant"));
      if (!grant) return new Response("Missing verification grant", { status: 400 });
      resolveGrant(grant);
      return new Response(VERIFIED_HTML, {
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const callbackUrl = `http://127.0.0.1:${callbackServer.port}/session-grant?state=${callbackState}`;
    const bootstrapUrl = new URL("/bootstrap", verificationBaseUrl());
    bootstrapUrl.searchParams.set("install_id", installId);
    bootstrapUrl.searchParams.set("app_version", appVersion);
    bootstrapUrl.searchParams.set("platform", "desktop");
    const bootstrapResponse = await fetch(bootstrapUrl, { signal: AbortSignal.timeout(15_000) });
    if (!bootstrapResponse.ok) {
      throw new Error(`SpotiFLAC verification bootstrap returned HTTP ${bootstrapResponse.status}`);
    }
    const bootstrap = await boundedJson(bootstrapResponse);
    const challengeUrl = new URL(text(bootstrap.challenge_url));
    if (challengeUrl.protocol !== "https:") throw new Error("SpotiFLAC returned an invalid challenge URL");
    challengeUrl.searchParams.set("cb", callbackUrl);
    await openVerificationPage(challengeUrl);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("SpotiFLAC verification timed out")), VERIFICATION_TIMEOUT_MS);
    });
    return await Promise.race([grantPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    callbackServer.stop(true);
  }
}

async function exchangeGrant(
  record: DesktopSpotiflacSessionRecord,
  appVersion: string,
  grant: string,
): Promise<DesktopSpotiflacSessionRecord> {
  const response = await fetch(new URL("/session/exchange", verificationBaseUrl()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant,
      install_id: text(record.install_id),
      app_version: appVersion,
      platform: "desktop",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SpotiFLAC session exchange returned HTTP ${response.status}`);
  const exchanged = await boundedJson(response);
  const sessionId = text(exchanged.session_id);
  const sessionSecret = text(exchanged.session_secret);
  const expiresAt = text(exchanged.expires_at);
  if (!sessionId || !sessionSecret || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("SpotiFLAC session exchange response is incomplete");
  }
  return {
    install_id: text(record.install_id),
    session_id: sessionId,
    session_secret: sessionSecret,
    expires_at: expiresAt,
  };
}

export async function refreshDesktopSpotiflacSession(options: { force?: boolean } = {}): Promise<{
  expiresAt: string;
  refreshed: boolean;
}> {
  const path = desktopSpotiflacSessionPath();
  const record = await readDesktopSpotiflacSession(path);
  if (!record.install_id) {
    record.install_id = randomHex(16);
    await writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (
    !options.force &&
    !spotiflacCommunitySessionNeedsRefresh(record, { refreshAheadMs: SPOTIFLAC_SESSION_REFRESH_AHEAD_MS })
  ) {
    return { expiresAt: text(record.expires_at), refreshed: false };
  }

  const appVersion = SPOTIFLAC_PROTOCOL_VERSION;
  const grant = await requestVerificationGrant(record, appVersion);
  const refreshed = await exchangeGrant(record, appVersion, grant);
  await writePrivateFile(path, `${JSON.stringify(refreshed, null, 2)}\n`);
  return { expiresAt: text(refreshed.expires_at), refreshed: true };
}
