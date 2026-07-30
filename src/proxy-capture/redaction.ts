// Proxy capture redaction scrubs headers, URLs, metadata, and payloads before persistence.
import { isUtf8 } from "node:buffer";
import {
  redactOpaqueValuesInSerializedJson,
  redactOpaqueValuesInText,
} from "@openclaw/normalization-core/opaque-value-redaction";
import { normalizeHeadersInitForFetch } from "../infra/fetch-headers.js";
import {
  hasRegisteredSecretValuesForRedaction,
  redactRegisteredSecretValues,
} from "../logging/secret-redaction-registry.js";
import {
  redactedCaptureHeaders as redactCaptureHeaderMap,
  REDACTED_CAPTURE_HEADER_VALUE,
} from "./header-redaction.js";

const REDACTED_CAPTURE_VALUE = REDACTED_CAPTURE_HEADER_VALUE;
const REDACTED_CAPTURE_BINARY_PAYLOAD = Buffer.from("[REDACTED BINARY PAYLOAD]", "utf8");

function redactAdditionalCaptureValues(value: string, sensitiveValues?: readonly string[]): string {
  return redactOpaqueValuesInText(value, sensitiveValues, REDACTED_CAPTURE_VALUE);
}

export function redactedCaptureHeaders(
  headers: HeadersInit | undefined,
  additionalSensitiveNames?: Iterable<string>,
  sensitiveValues?: readonly string[],
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  return redactCaptureHeaderMap(
    new Headers(normalizeHeadersInitForFetch(headers)),
    additionalSensitiveNames,
    sensitiveValues,
  );
}

export function redactCaptureUrl(rawUrl: string, sensitiveValues?: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "https://redacted.invalid/%5BREDACTED%5D";
  }
  const redactComponent = (value: string) => redactCaptureText(value, sensitiveValues);
  const decodeComponent = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (redactComponent(url.hostname) !== url.hostname) {
    url.hostname = "redacted.invalid";
  }
  for (const key of ["username", "password"] as const) {
    const decoded = decodeComponent(url[key]);
    const redacted = redactComponent(decoded);
    if (redacted !== decoded) {
      url[key] = redacted;
    }
  }
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        const redacted = redactComponent(decoded);
        return redacted === decoded ? segment : encodeURIComponent(redacted);
      } catch {
        return segment;
      }
    })
    .join("/");
  const searchParams = new URLSearchParams();
  let searchChanged = false;
  for (const [name, value] of url.searchParams.entries()) {
    const redactedName = redactComponent(name);
    const redactedValue = redactComponent(value);
    searchParams.append(redactedName, redactedValue);
    if (redactedName !== name || redactedValue !== value) {
      searchChanged = true;
    }
  }
  if (searchChanged) {
    url.search = searchParams.toString();
  }
  const decodedHash = decodeComponent(url.hash.slice(1));
  const redactedHash = redactComponent(decodedHash);
  if (redactedHash !== decodedHash) {
    url.hash = redactedHash;
  }
  const serialized = url.toString();
  return redactComponent(serialized) === serialized
    ? serialized
    : `${url.protocol}//redacted.invalid/%5BREDACTED%5D`;
}

export function redactCaptureText(value: string, sensitiveValues?: readonly string[]): string {
  return redactRegisteredSecretValues(
    redactAdditionalCaptureValues(value, sensitiveValues),
    () => REDACTED_CAPTURE_VALUE,
  );
}

export function redactCapturePayload(
  value: string | Buffer | null | undefined,
  sensitiveValues?: readonly string[],
): string | Buffer | null {
  if (typeof value === "string") {
    return redactRegisteredSecretValues(
      redactOpaqueValuesInSerializedJson(value, sensitiveValues, REDACTED_CAPTURE_VALUE),
      () => REDACTED_CAPTURE_VALUE,
    );
  }
  if (!Buffer.isBuffer(value)) {
    return value ?? null;
  }
  if (!isUtf8(value)) {
    return hasRegisteredSecretValuesForRedaction() || sensitiveValues?.length
      ? REDACTED_CAPTURE_BINARY_PAYLOAD
      : value;
  }
  const text = value.toString("utf8");
  const redacted = redactRegisteredSecretValues(
    redactOpaqueValuesInSerializedJson(text, sensitiveValues, REDACTED_CAPTURE_VALUE),
    () => REDACTED_CAPTURE_VALUE,
  );
  return redacted === text ? value : Buffer.from(redacted, "utf8");
}

export function redactedCaptureJson(
  value: unknown,
  stringify: (value: unknown) => string | undefined,
  sensitiveValues?: readonly string[],
): string | undefined {
  const serialized = stringify(value);
  if (serialized === undefined) {
    return undefined;
  }
  return redactRegisteredSecretValues(
    redactOpaqueValuesInSerializedJson(serialized, sensitiveValues, REDACTED_CAPTURE_VALUE),
    () => REDACTED_CAPTURE_VALUE,
  );
}
