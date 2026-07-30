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
  options: {
    nextAgents?: OpenClawConfig["agents"];
    sessionStore?: string;
    switchStore?: boolean;
  } = {},
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
    ...(options.sessionStore ? { session: { store: options.sessionStore } } : {}),
    cron: { store: sourceStorePath } as CronConfigWithStore,
  } satisfies OpenClawConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  const targetStorePath = options.switchStore === false ? sourceStorePath : destinationStorePath;
  await saveCronJobsStore(targetStorePath, { version: 1, jobs: destinationJobs }, { env });
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
    ...(options.nextAgents ? { agents: options.nextAgents } : {}),
    cron: { ...(snapshot.config.cron as object), store: targetStorePath },
  } as OpenClawConfig;
  const allowedAgentRosterRemovals = options.nextAgents
    ? Object.keys(agents?.entries ?? {}).filter(
        (agentId) => !Object.hasOwn(options.nextAgents?.entries ?? {}, agentId),
      )
    : [];
  const write = (preCommitRuntimePreflight?: () => Promise<void>) =>
    io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      explicitSetPaths: [options.nextAgents ? ["agents"] : ["cron"]],
      explicitSetValueSource: nextConfig,
      ...(allowedAgentRosterRemovals.length > 0 ? { allowedAgentRosterRemovals } : {}),
      preservedLegacyRootKeys: ["cron"],
      ...(preCommitRuntimePreflight ? { preCommitRuntimePreflight } : {}),
    });
  return { configPath, destinationStorePath: targetStorePath, env, write };
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

  it("refuses a destination job owned by an agent absent from the incoming roster", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("departed-owner", "legacy-agent")]);

    await expect(fixture.write()).rejects.toThrow("agents absent from the incoming roster");
  });

  it("allows an explicit-roster switch when a session key owns the destination job", async () => {
    const fixture = await createStoreSwitchFixture([
      { ...cronJob("session-owned"), sessionKey: "agent:ops:main" },
    ]);

    await expect(fixture.write()).resolves.toBeDefined();
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

  it("refuses a same-store roster replacement that would orphan ownerless jobs", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {}, writer: {} },
        },
      },
    );

    await expect(fixture.write()).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("retains a removed sole agent as the fixed-session-store compatibility owner", async () => {
    const sessionStore = path.join(tempDirs.make("openclaw-fixed-session-owner-"), "sessions.json");
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: {} } },
      {
        sessionStore,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {}, writer: {} },
        },
      },
    );

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe("ops");
  });
});
