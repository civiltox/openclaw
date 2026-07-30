// Google provider module implements model/runtime integration.
import { createHash } from "node:crypto";
import {
  createProviderHttpError,
  formatProviderHttpErrorMessage,
  readProviderJsonObjectResponse,
  redactOpaqueValuesInText,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveCitationRedirectUrl,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleApiClientHeaders } from "../google-api-client-header.js";
import {
  resolveGeminiConfig,
  resolveGeminiBaseUrl,
  resolveGeminiModel,
  type GeminiConfig,
} from "./gemini-web-search-provider.shared.js";

type GeminiFreshness = "day" | "week" | "month" | "year";

type GeminiTimeRangeFilter = {
  startTime: string;
  endTime: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

function throwMalformedGeminiResponse(): never {
  throw new Error("Gemini API error: malformed JSON response");
}

// Framing and hop-by-hop names are syntactically valid but break the request:
// undici rejects Expect and Transfer-Encoding outright and honors Content-Length,
// which truncates the JSON body. These are rejected at search execution so one bad
// entry cannot disable unrelated Google plugin capabilities at config load.
const REJECTED_REQUEST_HEADER_NAMES = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Names the Gemini request owns. Declared statically rather than derived from
// resolveGoogleApiClientHeaders: that helper returns {} for non-Google endpoints, so
// deriving it would leave x-goog-api-client unreserved on exactly the gateway
// deployments this feature exists for, contradicting the documented reservation.
const PROVIDER_OWNED_HEADER_NAMES = new Set([
  "content-type",
  "x-goog-api-client",
  "x-goog-api-key",
]);

// Fetch constructs Sec-Fetch-Mode from the request's mode and overwrites any
// configured value before transmission.
const FETCH_OWNED_HEADER_NAMES = new Set(["sec-fetch-mode"]);
// The guarded transport may attach this private marker for the standalone debug
// proxy and strips it before forwarding. Operators cannot override that contract.
const RESERVED_TRANSPORT_HEADER_NAMES = new Set(["x-openclaw-debug-proxy-redact-all"]);

// Config env substitution warns and preserves the placeholder when a variable is
// unset, so an unresolved reference would otherwise be sent verbatim.
const UNRESOLVED_ENV_PLACEHOLDER_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/u;
const HTTP_HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]+$/u;

function throwInvalidGeminiHeader(name: string, reason: string): never {
  throw new Error(
    `web_search (gemini): invalid header ${JSON.stringify(name)} in plugins.entries.google.config.webSearch.headers (${reason})`,
  );
}

/**
 * Resolves operator headers from `webSearch.headers`. Invalid entries fail only the
 * current Gemini search, before cache lookup or network I/O. `Headers.set` owns the
 * platform's HTTP name/value validation and normalization.
 *
 * Values are plain strings only. Secret references are deliberately unsupported:
 * this path is not a registered secret target, so a ref cannot resolve.
 */
function resolveGeminiWebSearchHeaders(params: {
  gemini?: GeminiConfig;
}): Record<string, string> | undefined {
  const raw = params.gemini?.headers;
  if (!isRecord(raw)) {
    return undefined;
  }
  const resolved = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(raw)) {
    const name = rawName.toLowerCase();
    if (REJECTED_REQUEST_HEADER_NAMES.has(name)) {
      throwInvalidGeminiHeader(rawName, "framing and hop-by-hop headers are not allowed");
    }
    if (PROVIDER_OWNED_HEADER_NAMES.has(name)) {
      throwInvalidGeminiHeader(rawName, "reserved for the Gemini request contract");
    }
    if (FETCH_OWNED_HEADER_NAMES.has(name)) {
      throwInvalidGeminiHeader(rawName, "reserved for the Fetch request contract");
    }
    if (RESERVED_TRANSPORT_HEADER_NAMES.has(name)) {
      throwInvalidGeminiHeader(rawName, "reserved for the OpenClaw request contract");
    }
    if (typeof rawValue !== "string") {
      throwInvalidGeminiHeader(rawName, "value must be a string");
    }
    if (!rawValue.trim()) {
      throwInvalidGeminiHeader(rawName, "value is empty");
    }
    if (UNRESOLVED_ENV_PLACEHOLDER_PATTERN.test(rawValue)) {
      throwInvalidGeminiHeader(rawName, "value still contains an unresolved ${VAR}");
    }
    if (!HTTP_HEADER_VALUE_PATTERN.test(rawValue)) {
      throwInvalidGeminiHeader(rawName, "value has characters outside the HTTP field-value set");
    }
    const candidate = new Headers();
    try {
      candidate.set(rawName, rawValue);
    } catch {
      throwInvalidGeminiHeader(rawName, "name or value is not valid for HTTP");
    }
    const value = candidate.get(rawName);
    if (value === null) {
      throwInvalidGeminiHeader(rawName, "name or value is not valid for HTTP");
    }
    // Object insertion order is deterministic; a later case-variant entry wins.
    resolved.set(name, value);
  }
  return resolved.size > 0 ? Object.fromEntries(resolved) : undefined;
}

/**
 * Secret-free cache discriminator for operator headers. Search cache keys live in a
 * process-wide map and routing headers can point the same baseUrl at a different
 * backend, so the header set must partition the cache without storing its values.
 * Sorting is load-bearing only here, so that two configs declaring the same headers
 * in a different order share a cache entry.
 */
function resolveGeminiWebSearchHeadersCacheKey(
  headers?: Record<string, string>,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const sorted = Object.entries(headers).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/** Headers the Gemini request owns; operator config may not supply or override these. */
function resolveProviderOwnedGeminiHeaders(params: {
  apiKey: string;
  baseUrl: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-goog-api-key": params.apiKey,
    ...resolveGoogleApiClientHeaders({
      baseUrl: params.baseUrl,
      api: "google-generative-ai",
      capability: "other",
      transport: "http",
    }),
  };
}

/**
 * Merges already-validated operator headers with provider-owned ones. Reserved names
 * are filtered during resolution, so `set` here only establishes the request
 * contract rather than resolving collisions.
 */
function buildGeminiRequestHeaders(params: {
  providerOwned: Record<string, string>;
  operatorHeaders?: Record<string, string>;
}): Headers {
  const headers = new Headers(params.operatorHeaders);
  for (const [name, value] of Object.entries(params.providerOwned)) {
    headers.set(name, value);
  }
  return headers;
}

function redactGeminiOperatorHeaderValues(text: string, headers?: Record<string, string>): string {
  return redactOpaqueValuesInText(
    text.replace(/key=[^&\s]+/giu, "key=***"),
    Object.values(headers ?? {}),
    "***",
  );
}

const GEMINI_FRESHNESS_DAYS: Record<GeminiFreshness, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const GEMINI_DAY_FRESHNESS_HINT = "Prioritize web sources published in the last 24 hours.";

// Gemini's google_search.time_range_filter accepts second-precision RFC 3339
// only. Despite the underlying google.protobuf.Timestamp type accepting "0, 3,
// 6 or 9 fractional digits", the Search grounding endpoint rejects any
// non-zero fractional component with
//   "[FIELD_INVALID] Granularity of nano is not supported".
// Strip the fractional-second component before serializing.
function toGeminiTimeRangeTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function isoDateStart(value: string): string {
  return `${value}T00:00:00Z`;
}

function isoDateExclusiveEnd(value: string): string {
  const end = new Date(`${value}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return toGeminiTimeRangeTimestamp(end);
}

function freshnessStartTime(freshness: GeminiFreshness, now: Date): string {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - GEMINI_FRESHNESS_DAYS[freshness]);
  return toGeminiTimeRangeTimestamp(start);
}

function queryWithSoftFreshness(query: string, freshness?: "day"): string {
  if (freshness !== "day") {
    return query;
  }
  return `${query}\n\nSearch recency instruction: ${GEMINI_DAY_FRESHNESS_HINT} If no matching recent sources are available, state that limitation and use the most relevant available sources.`;
}

function resolveGeminiTimeRangeFilter(
  args: Record<string, unknown>,
  now = new Date(),
):
  | { timeRangeFilter?: GeminiTimeRangeFilter; freshness?: "day" }
  | {
      error:
        | "invalid_freshness"
        | "invalid_date"
        | "invalid_date_range"
        | "conflicting_time_filters";
      message: string;
      docs: string;
    } {
  const rawFreshness = readStringParam(args, "freshness");
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  const parsedTimeFilters = parseWebSearchTimeFilters({
    rawDateAfter,
    rawDateBefore,
    rawFreshness,
    freshnessProvider: "perplexity",
    invalidFreshnessMessage:
      "freshness must be day, week, month, year, or the shortcuts pd, pw, pm, py.",
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedTimeFilters) {
    return parsedTimeFilters;
  }

  const { freshness, dateAfter, dateBefore } = parsedTimeFilters;
  if (freshness) {
    // Gemini rejects 24-hour google_search.timeRangeFilter windows, while
    // wider freshness windows still preserve the hard grounding contract.
    if (freshness === "day") {
      return {
        freshness,
      };
    }
    return {
      timeRangeFilter: {
        startTime: freshnessStartTime(freshness, now),
        endTime: toGeminiTimeRangeTimestamp(now),
      },
    };
  }

  if (!dateAfter && !dateBefore) {
    return {};
  }

  return {
    timeRangeFilter: {
      startTime: dateAfter ? isoDateStart(dateAfter) : "1970-01-01T00:00:00Z",
      endTime: dateBefore ? isoDateExclusiveEnd(dateBefore) : toGeminiTimeRangeTimestamp(now),
    },
  };
}

function resolveGeminiRuntimeApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "plugins.entries.google.config.webSearch.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"]) ??
    readConfiguredSecretString(gemini?.providerApiKey, "models.providers.google.apiKey")
  );
}

async function runGeminiSearch(params: {
  query: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  timeRangeFilter?: GeminiTimeRangeFilter;
  headers?: Record<string, string>;
  providerOwnedHeaders: Record<string, string>;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${params.baseUrl}/models/${params.model}:generateContent`;
  const googleSearch =
    params.timeRangeFilter === undefined ? {} : { timeRangeFilter: params.timeRangeFilter };
  const operatorHeaderNames = params.headers ? Object.keys(params.headers) : undefined;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      stripHeadersOnCrossOriginRedirect: operatorHeaderNames,
      capture: operatorHeaderNames
        ? {
            sensitiveRequestHeaderNames: operatorHeaderNames,
            sensitiveValues: Object.values(params.headers ?? {}),
          }
        : undefined,
      init: {
        method: "POST",
        headers: buildGeminiRequestHeaders({
          providerOwned: params.providerOwnedHeaders,
          operatorHeaders: params.headers,
        }),
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.query }] }],
          tools: [{ google_search: googleSearch }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const error = await createProviderHttpError(res, "Gemini API error", {
          redactValues: Object.values(params.headers ?? {}),
        });
        throw new Error(redactGeminiOperatorHeaderValues(error.message, params.headers));
      }

      const data = (await readProviderJsonObjectResponse(
        res,
        "Gemini API error",
      )) as GeminiGroundingResponse;

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          formatProviderHttpErrorMessage({
            label: "Gemini API error",
            status: data.error.code ?? 0,
            detail: redactGeminiOperatorHeaderValues(rawMessage, params.headers),
          }),
        );
      }

      if (!Array.isArray(data.candidates)) {
        throwMalformedGeminiResponse();
      }
      const candidate = data.candidates[0];
      if (!isRecord(candidate) || !isRecord(candidate.content)) {
        throwMalformedGeminiResponse();
      }
      const parts = candidate.content.parts;
      if (!Array.isArray(parts)) {
        throwMalformedGeminiResponse();
      }
      const content = parts
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : undefined))
        .filter((text): text is string => Boolean(text))
        .join("\n");
      if (!content) {
        throwMalformedGeminiResponse();
      }
      const groundingMetadata = candidate.groundingMetadata;
      const groundingChunks =
        groundingMetadata === undefined
          ? []
          : isRecord(groundingMetadata)
            ? groundingMetadata.groundingChunks === undefined
              ? []
              : Array.isArray(groundingMetadata.groundingChunks)
                ? groundingMetadata.groundingChunks
                : undefined
            : undefined;
      if (!groundingChunks) {
        throwMalformedGeminiResponse();
      }
      const rawCitations = groundingChunks.flatMap((chunk) => {
        if (!isRecord(chunk) || !isRecord(chunk.web) || typeof chunk.web.uri !== "string") {
          return [];
        }
        return [
          {
            url: chunk.web.uri,
            title: typeof chunk.web.title === "string" ? chunk.web.title : undefined,
          },
        ];
      });

      const citations: Array<{ url: string; title?: string }> = [];
      for (let index = 0; index < rawCitations.length; index += 10) {
        const batch = rawCitations.slice(index, index + 10);
        const resolved = await Promise.all(
          batch.map(async (citation) =>
            Object.assign({}, citation, { url: await resolveCitationRedirectUrl(citation.url) }),
          ),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

export async function executeGeminiSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  context?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(
    {
      country: args.country,
      language: args.language,
    },
    "gemini",
  );
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const timeRange = resolveGeminiTimeRangeFilter(args);
  if ("error" in timeRange) {
    return timeRange;
  }

  const geminiConfig = resolveGeminiConfig(searchConfig);
  const apiKey = resolveGeminiRuntimeApiKey(geminiConfig);
  if (!apiKey) {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, configure plugins.entries.google.config.webSearch.apiKey, or reuse models.providers.google.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  const count =
    readPositiveIntegerParam(args, "count", {
      max: MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
    }) ??
    searchConfig?.maxResults ??
    undefined;
  const model = resolveGeminiModel(geminiConfig);
  const baseUrl = resolveGeminiBaseUrl(geminiConfig);
  const providerOwnedHeaders = resolveProviderOwnedGeminiHeaders({ apiKey, baseUrl });
  const headers = resolveGeminiWebSearchHeaders({ gemini: geminiConfig });
  const cacheKey = buildSearchCacheKey([
    "gemini",
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    baseUrl,
    model,
    timeRange.freshness,
    timeRange.timeRangeFilter?.startTime,
    timeRange.timeRangeFilter?.endTime,
    resolveGeminiWebSearchHeadersCacheKey(headers),
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const result = await runGeminiSearch({
    query: queryWithSoftFreshness(query, timeRange.freshness),
    baseUrl,
    model,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal: context?.signal,
    timeRangeFilter: timeRange.timeRangeFilter,
    headers,
    providerOwnedHeaders,
  });
  const payload = {
    query,
    provider: "gemini",
    model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "gemini",
      wrapped: true,
    },
    content: wrapWebContent(result.content),
    citations: result.citations,
  };
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
