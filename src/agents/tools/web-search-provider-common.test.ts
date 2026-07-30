// Shared web_search provider tests cover module-local cache isolation.
import { describe, expect, it, vi } from "vitest";

describe("web_search shared cache", () => {
  it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
    // Cache state should die with the module instance; a global symbol would
    // leak search payloads across tests, sessions, and plugin reloads.
    vi.resetModules();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];

    const module = await import("./web-search-provider-common.js");
    const cacheKey = "query:test";
    module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

    expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
    expect(
      (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")],
    ).toBeUndefined();
  });

  it("forwards caller-specific redaction metadata to guarded fetch capture", async () => {
    vi.resetModules();
    const withTrustedWebToolsEndpoint = vi.fn(
      async (
        _params: unknown,
        run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
      ) =>
        await run({
          response: new Response("ok"),
          finalUrl: "https://example.com",
        }),
    );
    vi.doMock("./web-guarded-fetch.js", () => ({
      withTrustedWebToolsEndpoint,
      withSelfHostedWebToolsEndpoint: vi.fn(),
    }));
    const module = await import("./web-search-provider-common.js");

    await module.withTrustedWebSearchEndpoint(
      {
        url: "https://example.com",
        timeoutSeconds: 10,
        init: {},
        capture: {
          sensitiveRequestHeaderNames: ["X-Routing-Target"],
          sensitiveValues: ["staging-private-route"],
        },
      },
      async () => undefined,
    );

    expect(withTrustedWebToolsEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        capture: {
          sensitiveRequestHeaderNames: ["X-Routing-Target"],
          sensitiveValues: ["staging-private-route"],
        },
      }),
      expect.any(Function),
    );
    vi.doUnmock("./web-guarded-fetch.js");
  });
});
