import NextAuth from "next-auth";
import { authOptions } from "@/auth";
import { env } from "@/lib/env";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

const handler = NextAuth(authOptions);

async function withRateLimit(
  req: Request,
  context: { params: Promise<{ nextauth: string[] }> },
) {
  if (req.method === "POST") {
    const rate = rateLimit(req, {
      keyPrefix: "auth",
      max: env.RATE_LIMIT_AUTH_MAX,
      windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
    });
    if (!rate.allowed) {
      console.warn("[security] auth rate limit exceeded", { ip: rate.ip });
      const headers = rateLimitHeaders(rate);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers,
      });
    }
    const url = new URL(req.url);
    console.info("[security] auth POST", { ip: rate.ip, path: url.pathname });
  }
  return handler(req, context);
}

export { withRateLimit as GET, withRateLimit as POST };
