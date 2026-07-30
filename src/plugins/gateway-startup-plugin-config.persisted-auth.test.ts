import { beforeEach, describe, expect, it, vi } from "vitest";

const listPotentialConfiguredChannelIds = vi.hoisted(() =>
  vi.fn(
    (
      _config: unknown,
      _env: NodeJS.ProcessEnv,
      options?: { includePersistedAuthState?: boolean },
    ) => (options?.includePersistedAuthState ? ["credential-only"] : []),
  ),
);

vi.mock("../channels/config-presence.js", () => ({
  listExplicitlyDisabledChannelIdsForConfig: () => [],
  listPotentialConfiguredChannelIds,
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

describe("collectConfiguredStartupChannelIds persisted auth", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockClear();
  });

  it("does not treat credential-only state as startup activation by default", () => {
    expect(
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
      }),
    ).toEqual([]);
    expect(listPotentialConfiguredChannelIds).toHaveBeenCalledTimes(2);
    for (const call of listPotentialConfiguredChannelIds.mock.calls) {
      expect(call[2]?.includePersistedAuthState).toBe(false);
    }
  });

  it("allows migration discovery to opt into credential-only state", () => {
    expect(
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
        includePersistedAuthState: true,
      }),
    ).toEqual(["credential-only"]);
  });
});
