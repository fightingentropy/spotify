import { describe, expect, test } from "bun:test";
import { createApiAuthRequestGuard } from "../src/client/api-auth-request";
import { withAccountScope } from "../packages/shared/src/account-scope";

describe("API authentication response ownership", () => {
  test("a current request can expire its account's session", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("first");
    expect(auth.capture(withAccountScope("/api/liked", "first"))()).toBe(true);
    expect(auth.capture("/api/legacy")()).toBe(true);
  });

  test("an old account's late 401 cannot sign out the newly signed-in account", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("first");
    const oldResponseMayExpire = auth.capture(withAccountScope("/api/liked", "first"));
    auth.setScope("second");
    expect(oldResponseMayExpire()).toBe(false);
    expect(auth.capture(withAccountScope("/api/liked", "second"))()).toBe(true);
  });

  test("a legacy unscoped request is rejected after sign-out and signing in again", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("first");
    const oldResponseMayExpire = auth.capture("/api/legacy");
    auth.setScope(null);
    auth.setScope("first");
    expect(oldResponseMayExpire()).toBe(false);
  });

  test("an old scoped URL cannot expire a different account even if its fetch starts late", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("second");
    expect(auth.capture(withAccountScope("/api/liked", "first"))()).toBe(false);
  });

  test("clearing auth data invalidates old requests when the same account signs in again", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("first");
    const oldResponseMayExpire = auth.capture(withAccountScope("/api/liked", "first"));
    auth.invalidate();
    auth.setScope("first");
    expect(oldResponseMayExpire()).toBe(false);
    expect(auth.capture(withAccountScope("/api/liked", "first"))()).toBe(true);
  });

  test("reapplying the same normalized scope leaves its active requests valid", () => {
    const auth = createApiAuthRequestGuard();
    auth.setScope("first");
    const responseMayExpire = auth.capture(withAccountScope("/api/liked", "first"));
    auth.setScope(" first ");
    expect(auth.getScope()).toBe("first");
    expect(responseMayExpire()).toBe(true);
  });
});
