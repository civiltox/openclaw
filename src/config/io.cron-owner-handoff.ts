import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  readRetainedLegacyDefaultCronOwnerForStore,
  retainLegacyDefaultCronOwnerHandoffForStore,
} from "../cron/legacy-default-agent-owner-handoff.js";
import { beginLegacyDefaultOwnerHandoff } from "../cron/live-service-registry.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronOwnerHandoffTarget = {
  config: OpenClawConfig;
  storePath: string;
};

type CronStoreWritePlan = {
  recheckExplicitDestination?: () => Promise<void>;
  targets: CronOwnerHandoffTarget[];
};

function resolveExplicitCronOwner(job: unknown): string | undefined {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return undefined;
  }
  const record = job as { agentId?: unknown; sessionKey?: unknown };
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  if (agentId) {
    return normalizeAgentId(agentId);
  }
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
  return parseAgentSessionKey(sessionKey)?.agentId;
}

/** Refuses a store switch that would publish ownerless jobs under explicit ownership. */
async function assertCronStoreDestinationHasExplicitOwners(params: {
  config: OpenClawConfig;
  storePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { loadLegacyCronRepairState } = await import("../commands/doctor/cron/legacy-repair.js");
  const state = await loadLegacyCronRepairState({
    cfg: {},
    storePath: params.storePath,
    env: params.env,
    readOnly: true,
  });
  const eligibleAgentIds = new Set(listAgentIds(params.config).map(normalizeAgentId));
  const rawJobs = state?.rawJobs ?? [];
  const ownerlessJobs = rawJobs.filter((job) => !resolveExplicitCronOwner(job));
  const unavailableJobs = rawJobs.filter((job) => {
    const owner = resolveExplicitCronOwner(job);
    return owner !== undefined && !eligibleAgentIds.has(owner);
  });
  if (ownerlessJobs.length > 0) {
    // Once explicit ownership publishes, no ambient owner remains to repair this store later.
    // Refuse before the config points at it rather than silently orphaning scheduled work.
    throw new Error(
      `Config write refused: cron.store destination ${params.storePath} contains ${ownerlessJobs.length} ownerless legacy cron job(s). Assign every destination job an explicit agentId with openclaw cron edit, or repair the destination with openclaw doctor --fix while its legacy owner is still available, then retry the store change.`,
    );
  }
  if (unavailableJobs.length > 0) {
    throw new Error(
      `Config write refused: cron.store destination ${params.storePath} contains ${unavailableJobs.length} cron job(s) owned by agents absent from the incoming roster. Reassign those jobs with openclaw cron edit before retrying the store change.`,
    );
  }
}

/** Validates a cron store switch and plans any same-store legacy-owner handoff. */
export async function planCronStoreWrite(params: {
  cronHandoffAgentId?: string;
  env: NodeJS.ProcessEnv;
  nextConfig: OpenClawConfig;
  publishesExplicitOwnership: boolean;
  sourceConfig: OpenClawConfig;
}): Promise<CronStoreWritePlan> {
  const sourceStorePath = resolveCronJobsStorePathFromConfig(params.sourceConfig, params.env);
  const destinationStorePath = resolveCronJobsStorePathFromConfig(params.nextConfig, params.env);
  const recheckExplicitDestination =
    params.publishesExplicitOwnership && sourceStorePath !== destinationStorePath
      ? async () =>
          await assertCronStoreDestinationHasExplicitOwners({
            config: params.nextConfig,
            storePath: destinationStorePath,
            env: params.env,
          })
      : undefined;
  await recheckExplicitDestination?.();
  if (!params.cronHandoffAgentId) {
    return { recheckExplicitDestination, targets: [] };
  }
  if (sourceStorePath !== destinationStorePath) {
    throw new Error(
      `Config write refused: cron ownership migration cannot be committed atomically while cron.store changes from ${sourceStorePath} to ${destinationStorePath}. Keep cron.store unchanged while ownership is materialized; before a later store-only switch, assign explicit agentId values to every destination job because the explicit roster has no ambient fallback owner.`,
    );
  }
  return {
    recheckExplicitDestination,
    targets: [{ storePath: sourceStorePath, config: params.sourceConfig }],
  };
}

/** Seals and migrates every cron store until the config write commits or fails. */
export async function prepareLegacyCronOwnerHandoffs(params: {
  env: NodeJS.ProcessEnv;
  legacyDefaultAgentId: string;
  targets: readonly CronOwnerHandoffTarget[];
}): Promise<{ release: () => void }> {
  const handoffs: Array<ReturnType<typeof beginLegacyDefaultOwnerHandoff>> = [];
  const release = () => {
    for (const handoff of handoffs) {
      handoff.release();
    }
  };
  try {
    const { materializeLegacyDefaultCronJobOwners } =
      await import("../commands/doctor/cron/legacy-repair.js");
    for (const target of params.targets) {
      // Receipts belong to physical stores, not the config selecting them. A destination
      // can carry an older owner's late-writer handoff and must keep that authority.
      const legacyDefaultAgentId =
        readRetainedLegacyDefaultCronOwnerForStore(target.storePath, params.env) ??
        params.legacyDefaultAgentId;
      const handoff = beginLegacyDefaultOwnerHandoff({
        storePath: target.storePath,
        legacyDefaultAgentId,
      });
      handoffs.push(handoff);
      const liveMigration = await handoff.drainAndSeal();
      if (liveMigration.warnings.length > 0) {
        throw new Error(
          `Config write refused before live cron ownership was durable: ${liveMigration.warnings.join(" ")}`,
        );
      }
      const migration = await materializeLegacyDefaultCronJobOwners({
        cfg: target.config,
        storePath: target.storePath,
        env: params.env,
        legacyDefaultAgentId,
      });
      if (migration.warnings.length > 0) {
        throw new Error(
          `Config write refused before retired default ownership was durable: ${migration.warnings.join(" ")}`,
        );
      }
      // A CLI process cannot fence a separately running pre-upgrade Gateway.
      // Persist this after row migration but before config commit so late rows migrate at startup.
      retainLegacyDefaultCronOwnerHandoffForStore(
        target.storePath,
        legacyDefaultAgentId,
        params.env,
      );
      await handoff.refreshSealedServices();
    }
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
