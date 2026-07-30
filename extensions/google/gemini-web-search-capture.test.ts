// Google tests cover Gemini web-search debug-capture redaction metadata.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";

const withTrustedWebSearchEndpointMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: withTrustedWebSearchEndpointMock,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

it("marks Gemini operator header names and values as sensitive debug-capture data", async () => {
  withTrustedWebSearchEndpointMock.mockImplementation(
    async (_params: unknown, run: (response: Response) => Promise<unknown>): Promise<unknown> =>
      await run(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "Grounded answer" }] },
                groundingMetadata: {},
              },
            ],
          }),
        ),
      ),
  );
  const { createGeminiWebSearchProvider } = await import("./src/gemini-web-search-provider.js");
  const config = {
    plugins: {
      entries: {
        google: {
          config: {
            webSearch: {
              apiKey: "AIza-plugin-test",
              headers: { "X-Routing-Target": "staging-private-route" },
            },
          },
        },
      },
    },
  } satisfies OpenClawConfig;
  const tool = createGeminiWebSearchProvider().createTool({
    config,
    searchConfig: { provider: "gemini" },
  });

  await tool?.execute({ query: "OpenClaw debug capture redaction" });

  expect(withTrustedWebSearchEndpointMock).toHaveBeenCalledOnce();
  expect(withTrustedWebSearchEndpointMock.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      capture: {
        sensitiveRequestHeaderNames: ["x-routing-target"],
        sensitiveValues: ["staging-private-route"],
      },
    }),
  );
});
