import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUEST_TIMEOUT_MS = 20_000;

class CoverError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function toSafeFileName(input: string): string {
  const sanitized = input.trim().replace(/[\\/:*?"<>|]/g, "_");
  return sanitized || "cover";
}

function parseRemoteUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CoverError("Invalid cover URL", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CoverError("Only http(s) URLs are allowed", 400);
  }
  return parsed;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "waveform/1.0 (+https://local.waveform.app)",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CoverError("Cover request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const remoteUrlRaw = url.searchParams.get("url") || "";
  const fileNameRaw = url.searchParams.get("filename") || "cover";
  const fileName = toSafeFileName(fileNameRaw);

  try {
    const remoteUrl = parseRemoteUrl(remoteUrlRaw);
    const upstream = await fetchWithTimeout(
      remoteUrl.toString(),
      REQUEST_TIMEOUT_MS,
    );
    if (!upstream.ok) {
      throw new CoverError(
        `Upstream cover request returned ${upstream.status}`,
        502,
      );
    }

    const contentType =
      upstream.headers.get("content-type")?.split(";")[0].trim() ||
      "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename=\"${fileName}\"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof CoverError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "Failed to download cover" },
      { status: 500 },
    );
  }
}

