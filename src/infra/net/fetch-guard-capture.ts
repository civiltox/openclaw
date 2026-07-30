// Guarded fetch capture adapters preserve caller-specific redaction metadata.
import { isTruthyEnvValue } from "../env.js";

const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";

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
