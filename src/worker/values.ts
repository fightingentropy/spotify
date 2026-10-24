export { toNumberValue, toObject, toStringValue } from "@/lib/provider-http";

export function envString(env: CloudflareEnv, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

export function envStringList(env: CloudflareEnv, key: string): string[] {
  return envString(env, key)
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}
