import middleware from "next-auth/middleware";
import type { NextRequest } from "next/server";

export default function proxy(request: NextRequest, context: unknown) {
  // Wrap NextAuth middleware so Next 16 proxy sees a function export.
  return (
    middleware as unknown as (req: NextRequest, ctx?: unknown) => unknown
  )(request, context);
}

export const config = { matcher: ["/upload"] };
