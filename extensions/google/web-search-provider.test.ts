// Google tests cover web search provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

type TestModelProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function installGeminiFetch() {
  const mockFetch = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Grounded answer" }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              },
            },
          ],
        }),
      ),
    ),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

function createGoogleModelProviderConfig(
  overrides: Partial<TestModelProviderConfig>,
): TestModelProviderConfig {
  return {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    models: [],
    ...overrides,
  };
}

function requireFirstGeminiFetchCall(
  mockFetch: ReturnType<typeof installGeminiFetch>,
): [RequestInfo | URL | undefined, RequestInit | undefined] {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected Gemini web search fetch call");
  }
  return call as [RequestInfo | URL | undefined, RequestInit | undefined];
}

/** Reads request headers as a plain record; the provider passes a `Headers` instance. */
function readInitHeaders(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function getFetchHeaders(mockFetch: ReturnType<typeof installGeminiFetch>): Record<string, string> {
  const [, init] = requireFirstGeminiFetchCall(mockFetch);
  return readInitHeaders(init);
}

function getGeminiFetchUrl(mockFetch: ReturnType<typeof installGeminiFetch>): string | undefined {
  const [input] = requireFirstGeminiFetchCall(mockFetch);
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input?.url;
}

/**
 * Request headers for each `:generateContent` call, ignoring the citation-redirect
 * HEAD requests that also land on the mock.
 */
function getGeminiSearchCallHeaders(
  mockFetch: ReturnType<typeof installGeminiFetch>,
): Array<Record<string, string>> {
  return mockFetch.mock.calls
    .map((call) => call as [RequestInfo | URL | undefined, RequestInit | undefined])
    .filter(([input]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
      return (url ?? "").includes(":generateContent");
    })
    .map(([, init]) => readInitHeaders(init));
}

function parseGeminiFetchBody(mockFetch: ReturnType<typeof installGeminiFetch>): {
  contents?: Array<{ parts?: Array<{ text?: string }> }>;
  tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
} {
  const [, init] = requireFirstGeminiFetchCall(mockFetch);
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected Gemini fetch body string");
  }
  return JSON.parse(body) as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("google web search provider", () => {
  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      await expect(tool.execute({ query: "OpenClaw docs" })).resolves.toEqual({
        docs: "https://docs.openclaw.ai/tools/web",
        error: "missing_gemini_api_key",
        message:
          "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, configure plugins.entries.google.config.webSearch.apiKey, or reuse models.providers.google.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      });
    });
  });

  it("stores configured credentials at the canonical plugin config path", () => {
    const provider = createGeminiWebSearchProvider();
    const config = {} as OpenClawConfig;

    provider.setConfiguredCredentialValue?.(config, "AIza-plugin-test");

    expect(provider.credentialPath).toBe("plugins.entries.google.config.webSearch.apiKey");
    expect(provider.getConfiguredCredentialValue?.(config)).toBe("AIza-plugin-test");
  });

  it("routes Gemini web search through plugin webSearch.baseUrl", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  baseUrl: "https://generativelanguage.googleapis.com/proxy/v1beta/",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw docs" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/proxy/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("merges configured webSearch.headers into Gemini requests", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  headers: {
                    "X-Routing-Target": "https://gateway.example.com/staging",
                  },
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw configured search headers" });

    expect(getFetchHeaders(mockFetch)["x-routing-target"]).toBe(
      "https://gateway.example.com/staging",
    );
  });

  it("keeps provider-owned Gemini headers ahead of configured headers", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  // Lower-case collisions must replace, not append; Headers would
                  // otherwise emit "text/plain, application/json".
                  headers: {
                    "content-type": "text/plain",
                    "x-goog-api-key": "AIza-header-override",
                  },
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw provider header precedence" });

    const headers = getFetchHeaders(mockFetch);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-goog-api-key"]).toBe("AIza-plugin-test");
  });

  it("drops header values the request cannot carry", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  headers: {
                    // Header values are ByteStrings; code units above U+00FF throw
                    // from the Headers constructor rather than being ignored.
                    "X-Em-Dash": "staging—eu",
                    "X-Cjk": "東京",
                    "X-Injected": "value\r\nX-Smuggled: yes",
                    // Env substitution preserves the placeholder when unset, so an
                    // unresolved reference must not reach the wire.
                    "X-Unresolved": "${GEMINI_ROUTING_TARGET_NOT_SET}",
                    // Framing headers are valid tokens but break the request.
                    "Transfer-Encoding": "chunked",
                    "Content-Length": "0",
                    "X-Kept": "staging",
                  },
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw unusable header values" });

    const headers = getFetchHeaders(mockFetch);
    expect(headers["x-kept"]).toBe("staging");
    for (const dropped of [
      "x-em-dash",
      "x-cjk",
      "x-injected",
      "x-smuggled",
      "x-unresolved",
      "transfer-encoding",
    ]) {
      expect(Object.keys(headers)).not.toContain(dropped);
    }
    // Without the framing denylist these would reach the wire and break the POST.
    expect(headers["content-length"]).toBeUndefined();
  });

  it("collapses operator header names that differ only by case", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  headers: {
                    "X-Routing-Target": "staging",
                    "x-routing-target": "prod",
                  },
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw header case collision" });

    // Headers.append would otherwise emit "staging, prod" as one malformed value.
    expect(getFetchHeaders(mockFetch)["x-routing-target"]).toBe("prod");
  });

  it("never forwards models.providers.google.headers to web search", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        models: {
          providers: {
            google: createGoogleModelProviderConfig({
              apiKey: "AIza-provider-test",
              baseUrl: "https://internal-gateway.example.com/gemini/v1beta/",
              headers: { Authorization: "Bearer gateway-token-example" },
            }),
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw provider header isolation" });

    // Provider headers are scoped to the provider baseUrl and may carry credentials.
    // webSearch.baseUrl points elsewhere here, so forwarding them would leak the
    // gateway token to a third-party origin.
    expect(getGeminiFetchUrl(mockFetch)).toContain("generativelanguage.googleapis.com");
    expect(getFetchHeaders(mockFetch)["authorization"]).toBeUndefined();
  });

  it("drops header names that are not valid HTTP tokens", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  headers: { "X Route": "staging", "X-Route:": "staging", "X-Good": "kept" },
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw malformed header names" });

    const headers = getFetchHeaders(mockFetch);
    expect(headers["x-good"]).toBe("kept");
    expect(Object.keys(headers)).not.toContain("x route");
    expect(Object.keys(headers)).not.toContain("x-route:");
  });

  it("partitions the Gemini search cache by configured headers", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const createToolForRoutingTarget = (routingTarget: string) =>
      provider.createTool({
        config: {
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: "AIza-plugin-test",
                    headers: { "X-Routing-Target": routingTarget },
                  },
                },
              },
            },
          },
        },
        searchConfig: { provider: "gemini" },
      });
    const query = "OpenClaw configured header cache partitioning";

    await createToolForRoutingTarget("https://gateway.example.com/staging")?.execute({ query });
    await createToolForRoutingTarget("https://gateway.example.com/canary")?.execute({ query });

    const searchCallHeaders = getGeminiSearchCallHeaders(mockFetch);
    expect(searchCallHeaders).toHaveLength(2);
    expect(searchCallHeaders[1]?.["x-routing-target"]).toBe("https://gateway.example.com/canary");
  });

  it("accepts Gemini success JSON with empty grounding metadata", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: { parts: [{ text: "Today's date is Sunday, June 7, 2026." }] },
                    groundingMetadata: {},
                  },
                ],
              }),
            ),
          ),
        ),
      ),
    );
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    const result = await tool?.execute({ query: "current date today" });

    expect(result).toMatchObject({
      citations: [],
      model: "gemini-2.5-flash",
      provider: "gemini",
    });
    expect(String(result?.content)).toContain("Today's date is Sunday, June 7, 2026.");
  });

  it("reports malformed Gemini API JSON with a stable provider error", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(vi.fn(() => Promise.resolve(new Response("{ nope")))),
    );
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("rejects wrong-root Gemini success JSON with a stable provider error", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(vi.fn(() => Promise.resolve(new Response(JSON.stringify([]))))),
    );
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("rejects Gemini success JSON without candidate text", async () => {
    vi.stubGlobal(
      "fetch",
      withFetchPreconnect(
        vi.fn(() =>
          Promise.resolve(
            new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
          ),
        ),
      ),
    );
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await expect(tool?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });

  it("passes provider execution abort signals into the Gemini fetch", async () => {
    const mockFetch = installGeminiFetch();
    const controller = new AbortController();
    controller.abort();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw docs" }, { signal: controller.signal });

    const [, init] = requireFirstGeminiFetchCall(mockFetch);
    expect(init?.signal?.aborted).toBe(true);
  });

  it("reuses the Google model provider key when no web search key or env key is set", async () => {
    await withEnvAsync({ GEMINI_API_KEY: undefined }, async () => {
      const mockFetch = installGeminiFetch();
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({
        config: {
          models: {
            providers: {
              google: createGoogleModelProviderConfig({
                apiKey: "AIza-provider-test",
              }),
            },
          },
        },
        searchConfig: { provider: "gemini" },
      });

      await tool?.execute({ query: "OpenClaw provider key fallback" });

      expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-provider-test");
      expect(getFetchHeaders(mockFetch)["x-goog-api-client"]).toMatch(/^openclaw\//u);
    });
  });

  it("keeps plugin web search keys ahead of env and provider keys", async () => {
    await withEnvAsync({ GEMINI_API_KEY: "AIza-env-test" }, async () => {
      const mockFetch = installGeminiFetch();
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool({
        config: {
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: "AIza-plugin-test",
                  },
                },
              },
            },
          },
          models: {
            providers: {
              google: createGoogleModelProviderConfig({
                apiKey: "AIza-provider-test",
              }),
            },
          },
        },
        searchConfig: { provider: "gemini" },
      });

      await tool?.execute({ query: "OpenClaw plugin key precedence" });

      expect(getFetchHeaders(mockFetch)["x-goog-api-key"]).toBe("AIza-plugin-test");
      expect(getFetchHeaders(mockFetch)["x-goog-api-client"]).toMatch(/^openclaw\//u);
    });
  });

  it("routes Gemini web search through provider-level google.baseUrl as a fallback", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        models: {
          providers: {
            google: createGoogleModelProviderConfig({
              apiKey: "AIza-provider-test",
              baseUrl: "https://generativelanguage.googleapis.com/provider/v1beta/",
            }),
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw provider baseUrl fallback" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/provider/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("keeps plugin webSearch.baseUrl ahead of provider-level google.baseUrl", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                  baseUrl: "https://generativelanguage.googleapis.com/plugin/v1beta/",
                },
              },
            },
          },
        },
        models: {
          providers: {
            google: createGoogleModelProviderConfig({
              baseUrl: "https://generativelanguage.googleapis.com/provider/v1beta/",
            }),
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "OpenClaw plugin baseUrl precedence" });

    expect(getGeminiFetchUrl(mockFetch)).toBe(
      "https://generativelanguage.googleapis.com/plugin/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("uses a soft recency hint for Gemini day freshness shortcuts instead of a 24-hour range", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "latest ai news timestamp precision", freshness: "pd" });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(body.contents?.[0]?.parts?.[0]?.text).toContain(
      "Prioritize web sources published in the last 24 hours.",
    );
  });

  it("preserves hard Gemini time ranges for wider freshness values", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "latest ai news timestamp precision", freshness: "week" });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe("latest ai news timestamp precision");
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
  });

  it("partitions Gemini cache entries for soft day freshness, hard week freshness, and no freshness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "same query cache partition", freshness: "day" });
    await tool?.execute({ query: "same query cache partition", freshness: "week" });
    await tool?.execute({ query: "same query cache partition" });

    const postCalls = mockFetch.mock.calls.filter(([, init]) => typeof init?.body === "string");
    expect(postCalls).toHaveLength(3);
    const parsePostedBody = (call: (typeof postCalls)[number] | undefined) => {
      const body = call?.[1]?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Gemini fetch body to be a string");
      }
      return JSON.parse(body) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
        tools?: Array<{ google_search?: { timeRangeFilter?: unknown } }>;
      };
    };
    const firstBody = parsePostedBody(postCalls[0]);
    const secondBody = parsePostedBody(postCalls[1]);
    const thirdBody = parsePostedBody(postCalls[2]);
    expect(firstBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(firstBody.contents?.[0]?.parts?.[0]?.text).toContain(
      "Prioritize web sources published in the last 24 hours.",
    );
    expect(secondBody.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-08T12:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
    expect(secondBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
    expect(thirdBody.tools?.[0]?.google_search?.timeRangeFilter).toBeUndefined();
    expect(thirdBody.contents?.[0]?.parts?.[0]?.text).toBe("same query cache partition");
  });

  it("strips sub-second precision from date-range timestamps so Gemini accepts them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // "now" with non-zero milliseconds. Without stripping, toISOString() emits
    // "2026-04-15T12:00:00.123Z", which Gemini's google_search.time_range_filter
    // rejects with "Granularity of nano is not supported".
    vi.setSystemTime(new Date("2026-04-15T12:00:00.123Z"));
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({ query: "latest ai news", date_after: "2026-04-01" });

    const body = parseGeminiFetchBody(mockFetch);
    const filter = body.tools?.[0]?.google_search?.timeRangeFilter as
      | { startTime: string; endTime: string }
      | undefined;
    expect(filter?.startTime).not.toMatch(/\.\d+Z$/);
    expect(filter?.endTime).not.toMatch(/\.\d+Z$/);
    expect(filter).toEqual({
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-04-15T12:00:00Z",
    });
  });

  it("passes date ranges to Gemini Google Search grounding", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await tool?.execute({
      query: "OpenClaw release notes",
      date_after: "2026-04-01",
      date_before: "2026-04-30",
    });

    const body = parseGeminiFetchBody(mockFetch);
    expect(body.tools?.[0]?.google_search?.timeRangeFilter).toEqual({
      startTime: "2026-04-01T00:00:00Z",
      endTime: "2026-05-01T00:00:00Z",
    });
  });

  it("returns validation errors for invalid Gemini time filters before fetch", async () => {
    const mockFetch = installGeminiFetch();
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: "AIza-plugin-test",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "gemini" },
    });

    await expect(
      tool?.execute({
        query: "OpenClaw release notes",
        freshness: "week",
        date_after: "2026-04-01",
      }),
    ).resolves.toEqual({
      docs: "https://docs.openclaw.ai/tools/web",
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
