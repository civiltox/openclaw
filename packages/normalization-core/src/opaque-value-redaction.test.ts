import { describe, expect, it } from "vitest";
import {
  redactOpaqueValuesInSerializedJson,
  redactOpaqueValuesInText,
} from "./opaque-value-redaction.js";

describe("opaque value redaction", () => {
  it("suppresses an unstructured field when an embedded short value is ambiguous", () => {
    expect(redactOpaqueValuesInText("route=uswest", ["us"], "***")).toBe("***");
  });

  it("matches percent-encoded values without depending on hex casing", () => {
    expect(redactOpaqueValuesInText("rejected route%20A%2fsecret", ["route A/secret"], "***")).toBe(
      "rejected ***",
    );
  });

  it("matches form-encoded values with plus signs for spaces", () => {
    expect(
      redactOpaqueValuesInText("rejected route+A%2fsecret%7e%21", ["route A/secret~!"], "***"),
    ).toBe("rejected ***");
  });

  it("redacts punctuation-only JSON values without corrupting JSON syntax", () => {
    const redacted = redactOpaqueValuesInSerializedJson(
      '{"detail":":","status":"usable"}',
      [":"],
      "***",
    );

    expect(JSON.parse(redacted)).toStrictEqual({ detail: "***", status: "usable" });
  });

  it("redacts opaque values used as JSON property names", () => {
    const redacted = redactOpaqueValuesInSerializedJson(
      '{"tenant-route":"safe","safe":"tenant-route"}',
      ["tenant-route"],
      "***",
    );

    expect(JSON.parse(redacted)).toStrictEqual({ "***": "safe", safe: "***" });
    expect(redacted).not.toContain("tenant-route");
  });

  it("can preserve property names while redacting values for schema inspection", () => {
    const redacted = redactOpaqueValuesInSerializedJson(
      '{"message":"message"}',
      ["message"],
      "***",
      { redactKeys: false },
    );

    expect(JSON.parse(redacted)).toStrictEqual({ message: "***" });
  });

  it("redacts opaque values echoed as non-string JSON scalars", () => {
    const redacted = redactOpaqueValuesInSerializedJson(
      '{"route":12345,"enabled":true,"fallback":null,"count":7}',
      ["12345", "true", "null"],
      "***",
    );

    expect(JSON.parse(redacted)).toStrictEqual({
      route: "***",
      enabled: "***",
      fallback: "***",
      count: 7,
    });
  });
});
