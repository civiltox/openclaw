import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { createConfigIO, resetConfigRuntimeState } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronConfigWithStore = NonNullable<OpenClawConfig["cron"]> & { store?: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetConfigRuntimeState();
});

function cronJob(id: string, agentId?: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
    ...(agentId ? { agentId } : {}),
  };
}

async function createStoreSwitchFixture(
  destinationJobs: CronJob[],
  agents: OpenClawConfig["agents"] | null = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  },
) {
  const root = tempDirs.make("openclaw-cron-store-switch-");
  const configPath = path.join(root, "openclaw.json");
  const sourceStorePath = path.join(root, "cron", "source.json");
  const destinationStorePath = path.join(root, "cron", "destination.json");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_FAST: "1",
  } as NodeJS.ProcessEnv;
  const config = {
    ...(agents !== null ? { agents } : {}),
    cron: { store: sourceStorePath } as CronConfigWithStore,
  } satisfies OpenClawConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  await saveCronJobsStore(destinationStorePath, { version: 1, jobs: destinationJobs }, { env });
  const io = createConfigIO({
    configPath,
    env,
    homedir: () => root,
    observe: false,
    preservedLegacyRootKeys: ["cron"],
    logger: { warn: () => {}, error: () => {} },
  });
  const snapshot = await io.readConfigFileSnapshot();
  const nextConfig = {
    ...snapshot.config,
    cron: { ...(snapshot.config.cron as object), store: destinationStorePath },
  } as OpenClawConfig;
  const write = (preCommitRuntimePreflight?: () => Promise<void>) =>
    io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["cron"]],
      explicitSetValueSource: nextConfig,
      preservedLegacyRootKeys: ["cron"],
      ...(preCommitRuntimePreflight ? { preCommitRuntimePreflight } : {}),
    });
  return { configPath, destinationStorePath, env, write };
}

describe("cron store switch ownership guard", () => {
  it("refuses an explicit-roster switch to ownerless destination jobs", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("ownerless")]);

    await expect(fixture.write()).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("allows an explicit-roster switch when destination jobs have owners", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("owned", "ops")]);

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect((persisted.cron as CronConfigWithStore | undefined)?.store).toBe(
      fixture.destinationStorePath,
    );
  });

  it("allows an implicit-main switch to ownerless destination jobs", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("implicit-main")], null);

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect((persisted.cron as CronConfigWithStore | undefined)?.store).toBe(
      fixture.destinationStorePath,
    );
  });

  it("ignores an ownerless legacy row shadowed by an owned current row", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("shadowed", "ops")]);
    await fs.mkdir(path.dirname(fixture.destinationStorePath), { recursive: true });
    await fs.writeFile(fixture.destinationStorePath, JSON.stringify([cronJob("shadowed")]), "utf8");

    await expect(fixture.write()).resolves.toBeDefined();
  });

  it("rechecks destination ownership at the config commit boundary", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("initially-owned", "ops")]);

    await expect(
      fixture.write(async () => {
        await saveCronJobsStore(
          fixture.destinationStorePath,
          { version: 1, jobs: [cronJob("late-ownerless")] },
          { env: fixture.env },
        );
      }),
    ).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });
});
