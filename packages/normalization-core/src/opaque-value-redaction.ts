// Opaque value redaction handles caller-designated sensitive strings without parsing their meaning.

type RedactionVariant = {
  value: string;
  caseInsensitive: boolean;
  suppressWholeField: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildVariants(values: readonly string[]): RedactionVariant[] {
  const variants = new Map<string, RedactionVariant>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const suppressWholeField = value.length < 6;
    const add = (variant: string, caseInsensitive: boolean) => {
      if (!variant) {
        return;
      }
      const key = `${caseInsensitive ? "i" : "s"}:${variant}`;
      variants.set(key, { value: variant, caseInsensitive, suppressWholeField });
    };
    add(value, false);
    const encoded = encodeURIComponent(value);
    add(encoded, encoded !== value);
    const formEncoded = new URLSearchParams([["value", value]]).toString().slice("value=".length);
    add(formEncoded, formEncoded !== value);
    add(JSON.stringify(value).slice(1, -1), false);
  }
  return [...variants.values()].toSorted((left, right) => right.value.length - left.value.length);
}

function includesVariant(text: string, variant: RedactionVariant): boolean {
  return variant.caseInsensitive
    ? new RegExp(escapeRegExp(variant.value), "iu").test(text)
    : text.includes(variant.value);
}

function replaceVariant(text: string, variant: RedactionVariant, replacement: string): string {
  return variant.caseInsensitive
    ? text.replace(new RegExp(escapeRegExp(variant.value), "giu"), replacement)
    : text.replaceAll(variant.value, replacement);
}

/**
 * Redacts caller-designated opaque values from one unstructured field.
 *
 * Short values are ambiguous substrings (`us` in `usable`), so any match suppresses
 * the whole field instead of risking a partial leak or corrupting structured syntax.
 */
export function redactOpaqueValuesInText(
  text: string,
  values: readonly string[] | undefined,
  replacement: string,
): string {
  const variants = buildVariants(values ?? []);
  if (variants.some((variant) => variant.suppressWholeField && includesVariant(text, variant))) {
    return replacement;
  }
  let redacted = text;
  for (const variant of variants) {
    redacted = replaceVariant(redacted, variant, replacement);
  }
  return redacted;
}

type OpaqueValueJsonRedactionOptions = {
  /** Preserve property names for callers that still need to inspect a known payload shape. */
  redactKeys?: boolean;
};

/** Redacts JSON string values and, by default, property names while preserving valid JSON. */
export function redactOpaqueValuesInJson(
  value: unknown,
  values: readonly string[] | undefined,
  replacement: string,
  options: OpaqueValueJsonRedactionOptions = {},
): unknown {
  if (typeof value === "string") {
    return redactOpaqueValuesInText(value, values, replacement);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    const redacted = redactOpaqueValuesInText(serialized, values, replacement);
    return redacted === serialized ? value : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOpaqueValuesInJson(item, values, replacement, options));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        options.redactKeys === false ? key : redactOpaqueValuesInText(key, values, replacement),
        redactOpaqueValuesInJson(item, values, replacement, options),
      ]),
    );
  }
  return value;
}

/**
 * Redacts a serialized JSON value structurally. Invalid JSON is treated as one
 * unstructured field and follows the conservative short-value rule.
 */
export function redactOpaqueValuesInSerializedJson(
  serialized: string,
  values: readonly string[] | undefined,
  replacement: string,
  options?: OpaqueValueJsonRedactionOptions,
): string {
  try {
    return JSON.stringify(
      redactOpaqueValuesInJson(JSON.parse(serialized), values, replacement, options),
    );
  } catch {
    return redactOpaqueValuesInText(serialized, values, replacement);
  }
}
