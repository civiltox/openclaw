// Guarded fetch capture adapters preserve caller-specific redaction metadata.
import { isTruthyEnvValue } from "../env.js";

const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";
const OPENCLAW_DEBUG_PROXY_REQUIRE = "OPENCLAW_DEBUG_PROXY_REQUIRE";
const OPENCLAW_DEBUG_PROXY_URL = "OPENCLAW_DEBUG_PROXY_URL";

/**
 * Private hop marker for the standalone debug proxy. It carries no secret
 * metadata; the proxy removes it before forwarding the request.
 */
export const DEBUG_PROXY_REDACT_ALL_CAPTURE_HEADER = "x-openclaw-debug-proxy-redact-all";

export type GuardedFetchCaptureOptions = {
  flowId?: string;
  meta?: Record<string, unknown>;
  /** Request header values that debug capture must redact without changing the request. */
  sensitiveRequestHeaderNames?: readonly string[];
  /** Exact values that debug capture must redact from every persisted exchange surface. */
  sensitiveValues?: readonly string[];
};

type GuardedFetchCapture = false | GuardedFetchCaptureOptions;

type GuardedFetchCaptureBase = {
  url: string;
  method: string;
  transport?: "http" | "sse";
  capture: GuardedFetchCapture | undefined;
  auditContext?: string;
};

function shouldCapture(capture: GuardedFetchCapture | undefined): boolean {
  return capture !== false && isTruthyEnvValue(process.env[OPENCLAW_DEBUG_PROXY_ENABLED]);
}

function resolveCaptureOptions(
  capture: GuardedFetchCapture | undefined,
): GuardedFetchCaptureOptions | undefined {
  return capture === false ? undefined : capture;
}

export function shouldMarkStandaloneProxyCapture(params: {
  capture: GuardedFetchCapture | undefined;
  envProxyUrl: string | undefined;
  protocol: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  const capture = resolveCaptureOptions(params.capture);
  const debugProxyUrl = env[OPENCLAW_DEBUG_PROXY_URL]?.trim();
  const usesDebugProxy = (() => {
    try {
      return Boolean(
        params.envProxyUrl &&
        debugProxyUrl &&
        new URL(params.envProxyUrl).href === new URL(debugProxyUrl).href,
      );
    } catch {
      return false;
    }
  })();
  return Boolean(
    params.protocol === "http:" &&
    usesDebugProxy &&
    capture &&
    (capture.sensitiveRequestHeaderNames?.length || capture.sensitiveValues?.length) &&
    isTruthyEnvValue(env[OPENCLAW_DEBUG_PROXY_ENABLED]) &&
    isTruthyEnvValue(env[OPENCLAW_DEBUG_PROXY_REQUIRE]),
  );
}

function buildCaptureMeta(params: GuardedFetchCaptureBase): Record<string, unknown> {
  const capture = resolveCaptureOptions(params.capture);
  return {
    captureOrigin: "guarded-fetch",
    ...(params.auditContext ? { auditContext: params.auditContext } : {}),
    ...capture?.meta,
  };
}

export async function captureGuardedFetchExchange(
  params: GuardedFetchCaptureBase & {
    requestHeaders?: HeadersInit;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    capturedByGlobalFetchPatch?: boolean;
  },
): Promise<void> {
  if (!shouldCapture(params.capture)) {
    return;
  }
  const capture = resolveCaptureOptions(params.capture);
  const { captureHttpExchangeInternal, isDebugProxyGlobalFetchPatchInstalled } =
    await import("../../proxy-capture/runtime.js");
  if (params.capturedByGlobalFetchPatch && isDebugProxyGlobalFetchPatchInstalled()) {
    return;
  }
  captureHttpExchangeInternal({
    url: params.url,
    method: params.method,
    requestHeaders: params.requestHeaders,
    requestBody: params.requestBody,
    response: params.response,
    transport: params.transport,
    flowId: capture?.flowId,
    sensitiveRequestHeaderNames: capture?.sensitiveRequestHeaderNames,
    sensitiveValues: capture?.sensitiveValues,
    meta: buildCaptureMeta(params),
  });
}

export async function captureGuardedFetchError(
  params: GuardedFetchCaptureBase & { error: unknown },
): Promise<void> {
  if (!shouldCapture(params.capture)) {
    return;
  }
  const capture = resolveCaptureOptions(params.capture);
  const { captureHttpError } = await import("../../proxy-capture/runtime.js");
  captureHttpError({
    url: params.url,
    method: params.method,
    error: params.error,
    transport: params.transport,
    flowId: capture?.flowId,
    sensitiveValues: capture?.sensitiveValues,
    meta: buildCaptureMeta(params),
  });
}
