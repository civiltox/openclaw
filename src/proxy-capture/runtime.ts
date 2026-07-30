// Proxy capture runtime coordinates capture sessions, proxy startup, and storage.
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../infra/fetch-headers.js";
import { resolveDebugProxySettings, type DebugProxySettings } from "./env.js";
import {
  redactCapturePayload,
  redactCaptureText,
  redactCaptureUrl,
  redactedCaptureHeaders,
  redactedCaptureJson,
} from "./redaction.js";
import {
  closeDebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
  safeJsonString,
} from "./store.sqlite.js";
import type {
  CaptureDirection,
  CaptureEventKind,
  CaptureEventRecord,
  CaptureProtocol,
} from "./types.js";

const DEBUG_PROXY_FETCH_PATCH_KEY = Symbol.for("openclaw.debugProxy.fetchPatch");
// Cap captured response bodies so debug proxy capture cannot be turned into an
// out-of-memory vector. The patched global fetch tees every outbound response
// through clone(), so a single large (or hostile, effectively endless) provider
// response would otherwise be buffered fully into memory just to record it.
const MAX_CAPTURED_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;

type CapturedResponseBodyResult =
  | { status: "captured"; buffer: Buffer }
  | { status: "too-large" | "unavailable" };

// Reads a cloned capture response body under a byte cap. Oversized or
// non-streaming Response-like bodies return a metadata-only status instead of
// allocating the full body.
//
// Unlike media-core's readResponseWithLimit this never awaits reader.cancel():
// the body here is one branch of a Response.clone() tee whose sibling (the
// caller-facing response) is still live, and cancelling such a branch never
// settles (it only resolves once BOTH branches cancel). Awaiting it would hang
// the capture pipeline and retain the buffered prefix forever, so we cancel
// fire-and-forget, mirroring src/agents/tools/web-shared.ts#readResponseText.
async function readCapturedResponseBodyBounded(
  response: Response,
  maxBytes: number,
): Promise<CapturedResponseBodyResult> {
  const clone = response.clone();
  const body = (clone as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== "function") {
    // A real null-body Response consumes as empty. Response-like objects without
    // a stream cannot be read under a byte cap, so never call arrayBuffer().
    return clone instanceof Response && clone.body === null
      ? { status: "captured", buffer: Buffer.alloc(0) }
      : { status: "unavailable" };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }
      if (total + value.length > maxBytes) {
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    if (truncated) {
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Some non-compliant/mocked streams reject releaseLock; ignore.
    }
  }
  return truncated
    ? { status: "too-large" }
    : { status: "captured", buffer: Buffer.concat(chunks, total) };
}
function parseDeclaredCaptureContentLength(raw: string | null | undefined): bigint | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return BigInt(trimmed);
}

// Runtime capture records HTTP/fetch and websocket events into the SQLite store,
// redacting sensitive headers and persisting bodies in capture_blobs.
type GlobalFetchPatchedState = {
  originalFetch: typeof globalThis.fetch;
};

type GlobalFetchPatchTarget = typeof globalThis & {
  [DEBUG_PROXY_FETCH_PATCH_KEY]?: GlobalFetchPatchedState;
};

const suppressedGlobalFetchCaptureInits = new WeakSet<RequestInit>();

/**
 * Skips the ambient global-fetch capture for one exact init object. Callers that
 * need request-specific redaction can then record the exchange themselves.
 */
export function suppressDebugProxyGlobalFetchCaptureOnce(init: RequestInit): void {
  suppressedGlobalFetchCaptureInits.add(init);
}

type DebugProxyCaptureStoreLike = Pick<
  ReturnType<typeof getDebugProxyCaptureStore>,
  "upsertSession" | "endSession" | "recordEvent"
>;

export type DebugProxyCaptureRuntimeDeps = {
  getStore?: () => DebugProxyCaptureStoreLike;
  closeStore?: typeof closeDebugProxyCaptureStore;
  persistEventPayload?: (
    store: DebugProxyCaptureStoreLike,
    payload: Parameters<typeof persistEventPayload>[1],
  ) => ReturnType<typeof persistEventPayload>;
  safeJsonString?: typeof safeJsonString;
  fetchTarget?: typeof globalThis;
};

function resolveRuntimeDeps(deps: DebugProxyCaptureRuntimeDeps = {}) {
  return {
    getStore: deps.getStore ?? getDebugProxyCaptureStore,
    closeStore: deps.closeStore ?? closeDebugProxyCaptureStore,
    persistEventPayload:
      deps.persistEventPayload ??
      ((store, payload) =>
        persistEventPayload(store as ReturnType<typeof getDebugProxyCaptureStore>, payload)),
    safeJsonString: deps.safeJsonString ?? safeJsonString,
    fetchTarget: deps.fetchTarget ?? globalThis,
  };
}

function protocolFromUrl(rawUrl: string): CaptureProtocol {
  try {
    const url = new URL(rawUrl);
    switch (url.protocol) {
      case "https:":
        return "https";
      case "wss:":
        return "wss";
      case "ws:":
        return "ws";
      default:
        return "http";
    }
  } catch {
    return "http";
  }
}

function resolveUrlString(input: RequestInfo | URL): string | null {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

function createHttpCaptureEventBase(params: {
  settings: DebugProxySettings;
  rawUrl: string;
  url: URL;
  transport?: "http" | "sse";
  direction: CaptureDirection;
  kind: CaptureEventKind;
  flowId: string;
  method: string;
}): CaptureEventRecord {
  return {
    sessionId: params.settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: params.settings.sourceProcess,
    protocol: params.transport ?? protocolFromUrl(params.rawUrl),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    method: params.method,
    host: params.url.host,
    path: `${params.url.pathname}${params.url.search}`,
  };
}

function recordHttpCaptureError(
  params: {
    url: string;
    method: string;
    error: unknown;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
    sensitiveValues?: Iterable<string>;
  },
  settings: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps,
): void {
  const runtime = resolveRuntimeDeps(deps);
  const sensitiveValues = [...(params.sensitiveValues ?? [])];
  const captureUrl = redactCaptureUrl(params.url, sensitiveValues);
  const url = new URL(captureUrl);
  runtime.getStore().recordEvent({
    ...createHttpCaptureEventBase({
      settings,
      rawUrl: captureUrl,
      url,
      transport: params.transport,
      direction: "local",
      kind: "error",
      flowId: params.flowId ?? randomUUID(),
      method: params.method,
    }),
    errorText: redactCaptureText(
      params.error instanceof Error ? params.error.message : String(params.error),
      sensitiveValues,
    ),
    metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString, sensitiveValues),
  });
}

function installDebugProxyGlobalFetchPatch(
  settings: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const runtime = resolveRuntimeDeps(deps);
  const fetchTarget = runtime.fetchTarget as GlobalFetchPatchTarget;
  if (typeof fetchTarget.fetch !== "function") {
    return;
  }
  if (fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY]) {
    return;
  }
  // Patch only once per target and keep the original fetch for deterministic
  // teardown in tests and nested capture sessions.
  const fetchImpl = fetchTarget.fetch;
  const originalFetch = fetchImpl.bind(fetchTarget);
  fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY] = { originalFetch };
  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = resolveUrlString(input);
    const suppressCapture = init ? suppressedGlobalFetchCaptureInits.delete(init) : false;
    const normalizedInit = normalizeRequestInitHeadersForFetch(init);
    try {
      const response = await originalFetch(input, normalizedInit);
      if (!suppressCapture && url && /^https?:/i.test(url)) {
        captureHttpExchangeInternal(
          {
            url,
            method:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.method
                : undefined) ??
              normalizedInit?.method ??
              "GET",
            requestHeaders:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.headers
                : undefined) ?? normalizedInit?.headers,
            requestBody:
              (typeof Request !== "undefined" && input instanceof Request
                ? (input as Request & { body?: BodyInit | null }).body
                : undefined) ??
              (normalizedInit as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ??
              null,
            response,
            transport: "http",
            meta: {
              captureOrigin: "global-fetch",
              source: settings.sourceProcess,
            },
          },
          settings,
          deps,
        );
      }
      return response;
    } catch (error) {
      if (!suppressCapture && url && /^https?:/i.test(url)) {
        recordHttpCaptureError(
          {
            url,
            error,
            method:
              (typeof Request !== "undefined" && input instanceof Request
                ? input.method
                : undefined) ??
              normalizedInit?.method ??
              "GET",
            meta: { captureOrigin: "global-fetch" },
          },
          settings,
          deps,
        );
      }
      throw error;
    }
  };
  const mockState = (fetchImpl as typeof globalThis.fetch & { mock?: unknown }).mock;
  if (typeof mockState === "object" && mockState !== null) {
    // Preserve Vitest mock metadata when patching mocked fetch targets.
    (patchedFetch as typeof globalThis.fetch & { mock?: unknown }).mock = mockState;
  }
  fetchTarget.fetch = patchedFetch as typeof globalThis.fetch;
}

function uninstallDebugProxyGlobalFetchPatch(deps: DebugProxyCaptureRuntimeDeps = {}): void {
  const fetchTarget = resolveRuntimeDeps(deps).fetchTarget as GlobalFetchPatchTarget;
  const state = fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
  if (!state) {
    return;
  }
  fetchTarget.fetch = state.originalFetch;
  delete fetchTarget[DEBUG_PROXY_FETCH_PATCH_KEY];
}

export function isDebugProxyGlobalFetchPatchInstalled(): boolean {
  return Boolean((globalThis as GlobalFetchPatchTarget)[DEBUG_PROXY_FETCH_PATCH_KEY]);
}

export function initializeDebugProxyCapture(
  mode: string,
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  resolveRuntimeDeps(deps).getStore().upsertSession({
    id: settings.sessionId,
    startedAt: Date.now(),
    mode,
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    proxyUrl: settings.proxyUrl,
  });
  installDebugProxyGlobalFetchPatch(settings, deps);
}

// Finalization closes the session and restores the fetch patch before closing
// the cached store, preventing later normal requests from being captured.
export function finalizeDebugProxyCapture(
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  runtime.getStore().endSession(settings.sessionId);
  uninstallDebugProxyGlobalFetchPatch(deps);
  runtime.closeStore();
}

export function captureHttpExchangeInternal(
  params: {
    url: string;
    method: string;
    requestHeaders?: HeadersInit;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
    sensitiveRequestHeaderNames?: Iterable<string>;
    sensitiveValues?: Iterable<string>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  const store = runtime.getStore();
  const flowId = params.flowId ?? randomUUID();
  const sensitiveValues = [...(params.sensitiveValues ?? [])];
  const captureUrl = redactCaptureUrl(params.url, sensitiveValues);
  const url = new URL(captureUrl);
  const requestBody =
    typeof params.requestBody === "string" || Buffer.isBuffer(params.requestBody)
      ? params.requestBody
      : null;
  const normalizedRequestHeaders = params.requestHeaders
    ? new Headers(normalizeHeadersInitForFetch(params.requestHeaders))
    : undefined;
  const rawRequestContentType = normalizedRequestHeaders?.get("content-type") ?? undefined;
  const requestContentType =
    rawRequestContentType === undefined
      ? undefined
      : redactCaptureText(rawRequestContentType, sensitiveValues);
  const rawResponseContentType =
    typeof params.response.headers?.get === "function"
      ? (params.response.headers.get("content-type") ?? undefined)
      : undefined;
  const responseContentType =
    rawResponseContentType === undefined
      ? undefined
      : redactCaptureText(rawResponseContentType, sensitiveValues);
  const requestPayload = runtime.persistEventPayload(store, {
    data: redactCapturePayload(requestBody, sensitiveValues),
    contentType: requestContentType,
  });
  store.recordEvent({
    ...createHttpCaptureEventBase({
      settings,
      rawUrl: captureUrl,
      url,
      transport: params.transport,
      direction: "outbound",
      kind: "request",
      flowId,
      method: params.method,
    }),
    contentType: requestContentType,
    headersJson: runtime.safeJsonString(
      redactedCaptureHeaders(
        normalizedRequestHeaders,
        params.sensitiveRequestHeaderNames,
        sensitiveValues,
      ),
    ),
    metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString, sensitiveValues),
    ...requestPayload,
  });
  // Records the response status/headers without a body. Used both when a
  // Response-like object cannot be cloned and when capturing the body would be
  // unsafe (over the cap), so the exchange is still observable without OOM risk.
  const recordResponseMetadataOnly = (bodyCapture: "unavailable" | "too-large") => {
    store.recordEvent({
      ...createHttpCaptureEventBase({
        settings,
        rawUrl: captureUrl,
        url,
        transport: params.transport,
        direction: "inbound",
        kind: "response",
        flowId,
        method: params.method,
      }),
      status: params.response.status,
      contentType: responseContentType,
      headersJson:
        params.response.headers && typeof params.response.headers.entries === "function"
          ? runtime.safeJsonString(
              redactedCaptureHeaders(params.response.headers, undefined, sensitiveValues),
            )
          : undefined,
      metaJson: redactedCaptureJson(
        { ...params.meta, bodyCapture },
        runtime.safeJsonString,
        sensitiveValues,
      ),
    });
  };
  if (typeof params.response.clone !== "function") {
    // Some Response-like objects cannot be cloned. Still record status/headers
    // rather than forcing capture to consume or mutate the original response.
    recordResponseMetadataOnly("unavailable");
    return;
  }
  // Fast path: when the provider declares an oversized Content-Length, skip the
  // body entirely instead of buffering it. Missing/chunked lengths fall through
  // to the bounded streaming read below, which cancels on overflow.
  const declaredLength = parseDeclaredCaptureContentLength(
    typeof params.response.headers?.get === "function"
      ? params.response.headers.get("content-length")
      : undefined,
  );
  if (declaredLength !== undefined && declaredLength > BigInt(MAX_CAPTURED_RESPONSE_BODY_BYTES)) {
    recordResponseMetadataOnly("too-large");
    return;
  }
  void readCapturedResponseBodyBounded(params.response, MAX_CAPTURED_RESPONSE_BODY_BYTES)
    .then((result) => {
      if (result.status !== "captured") {
        // The body either exceeded the cap or offered no bounded streaming path.
        // Preserve the exchange as metadata instead of allocating the whole body.
        recordResponseMetadataOnly(result.status);
        return;
      }
      const responsePayload = runtime.persistEventPayload(store, {
        data: redactCapturePayload(result.buffer, sensitiveValues),
        contentType: responseContentType,
      });
      store.recordEvent({
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: captureUrl,
          url,
          transport: params.transport,
          direction: "inbound",
          kind: "response",
          flowId,
          method: params.method,
        }),
        status: params.response.status,
        contentType: responseContentType,
        headersJson: runtime.safeJsonString(
          redactedCaptureHeaders(params.response.headers, undefined, sensitiveValues),
        ),
        metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString, sensitiveValues),
        ...responsePayload,
      });
    })
    .catch((error: unknown) => {
      store.recordEvent({
        ...createHttpCaptureEventBase({
          settings,
          rawUrl: captureUrl,
          url,
          transport: params.transport,
          direction: "local",
          kind: "error",
          flowId,
          method: params.method,
        }),
        errorText: redactCaptureText(
          error instanceof Error ? error.message : String(error),
          sensitiveValues,
        ),
      });
    });
}

/** Records an HTTP exchange through the stable public plugin capture contract. */
export function captureHttpExchange(
  params: {
    url: string;
    method: string;
    requestHeaders?: Headers | Record<string, string> | undefined;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  captureHttpExchangeInternal(params, resolved, deps);
}

/** Records a failed HTTP transport with caller-specific redaction metadata. */
export function captureHttpError(
  params: {
    url: string;
    method: string;
    error: unknown;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
    sensitiveValues?: Iterable<string>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  recordHttpCaptureError(params, settings, deps);
}

// Websocket seams call this directly because Node fetch patching cannot observe
// frame traffic.
export function captureWsEvent(
  params: {
    url: string;
    direction: "outbound" | "inbound" | "local";
    kind: "ws-open" | "ws-frame" | "ws-close" | "error";
    flowId: string;
    payload?: string | Buffer;
    closeCode?: number;
    errorText?: string;
    meta?: Record<string, unknown>;
  },
  resolved?: DebugProxySettings,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const settings = resolved ?? resolveDebugProxySettings();
  if (!settings.enabled) {
    return;
  }
  const runtime = resolveRuntimeDeps(deps);
  const store = runtime.getStore();
  const captureUrl = redactCaptureUrl(params.url);
  const url = new URL(captureUrl);
  const payload = runtime.persistEventPayload(store, {
    data: redactCapturePayload(params.payload),
    contentType: "application/json",
  });
  store.recordEvent({
    sessionId: settings.sessionId,
    ts: Date.now(),
    sourceScope: "openclaw",
    sourceProcess: settings.sourceProcess,
    protocol: protocolFromUrl(captureUrl),
    direction: params.direction,
    kind: params.kind,
    flowId: params.flowId,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    closeCode: params.closeCode,
    errorText: params.errorText === undefined ? undefined : redactCaptureText(params.errorText),
    metaJson: redactedCaptureJson(params.meta, runtime.safeJsonString),
    ...payload,
  });
}
