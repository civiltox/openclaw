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

function redactOpaqueValuesInTextWithVariants(
  text: string,
  variants: readonly RedactionVariant[],
  replacement: string,
): string {
  if (variants.some((variant) => variant.suppressWholeField && includesVariant(text, variant))) {
    return replacement;
  }
  let redacted = text;
  for (const variant of variants) {
    redacted = replaceVariant(redacted, variant, replacement);
  }
  return redacted;
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
  return redactOpaqueValuesInTextWithVariants(text, variants, replacement);
}

type OpaqueValueJsonRedactionOptions = {
  /** Preserve property names for callers that still need to inspect a known payload shape. */
  redactKeys?: boolean;
};

type JsonRedactionResult = {
  value: unknown;
  changed: boolean;
};

function redactOpaqueValuesInJsonWithResult(
  value: unknown,
  variants: readonly RedactionVariant[],
  replacement: string,
  options: OpaqueValueJsonRedactionOptions,
): JsonRedactionResult {
  if (typeof value === "string") {
    const redacted = redactOpaqueValuesInTextWithVariants(value, variants, replacement);
    return { value: redacted, changed: redacted !== value };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    const redacted = redactOpaqueValuesInTextWithVariants(serialized, variants, replacement);
    return { value: redacted === serialized ? value : redacted, changed: redacted !== serialized };
  }
  if (Array.isArray(value)) {
    const results = value.map((item) =>
      redactOpaqueValuesInJsonWithResult(item, variants, replacement, options),
    );
    return {
      value: results.map((result) => result.value),
      changed: results.some((result) => result.changed),
    };
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const redactedKey =
        options.redactKeys === false
          ? key
          : redactOpaqueValuesInTextWithVariants(key, variants, replacement);
      const redactedItem = redactOpaqueValuesInJsonWithResult(item, variants, replacement, options);
      changed ||= redactedKey !== key || redactedItem.changed;
      return [redactedKey, redactedItem.value];
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}

/** Redacts JSON string values and, by default, property names while preserving valid JSON. */
export function redactOpaqueValuesInJson(
  value: unknown,
  values: readonly string[] | undefined,
  replacement: string,
  options: OpaqueValueJsonRedactionOptions = {},
): unknown {
  const variants = buildVariants(values ?? []);
  if (variants.length === 0) {
    return value;
  }
  return redactOpaqueValuesInJsonWithResult(value, variants, replacement, options).value;
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
  const variants = buildVariants(values ?? []);
  if (
    variants.length === 0 ||
    (!serialized.includes("\\") &&
      !variants.some((variant) => includesVariant(serialized, variant)))
  ) {
    return serialized;
  }
  try {
    const result = redactOpaqueValuesInJsonWithResult(
      JSON.parse(serialized),
      variants,
      replacement,
      options ?? {},
    );
    return result.changed ? JSON.stringify(result.value) : serialized;
  } catch {
    return redactOpaqueValuesInTextWithVariants(serialized, variants, replacement);
  }
}
