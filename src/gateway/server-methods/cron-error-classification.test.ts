import { describe, expect, it } from "vitest";
import { isCronInvalidRequestError } from "./cron-error-classification.js";

describe("isCronInvalidRequestError", () => {
  it("classifies conflicting cron agent and session owners as an invalid request", () => {
    expect(
      isCronInvalidRequestError(
        new Error("cron job agentId ops does not match sessionKey owner research"),
      ),
    ).toBe(true);
  });
});
