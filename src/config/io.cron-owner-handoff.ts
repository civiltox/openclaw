import {
  readRetainedLegacyDefaultCronOwnerForStore,
  retainLegacyDefaultCronOwnerHandoffForStore,
} from "../cron/legacy-default-agent-owner-handoff.js";
import { beginLegacyDefaultOwnerHandoff } from "../cron/live-service-registry.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronOwnerHandoffTarget = {
  config: OpenClawConfig;
  storePath: string;
};

function hasExplicitCronOwner(job: unknown): boolean {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return false;
  }
  const agentId = (job as { agentId?: unknown }).agentId;
  return typeof agentId === "string" && agentId.trim().length > 0;
}

/** Refuses a store switch that would publish ownerless jobs under explicit ownership. */
export async function assertCronStoreDestinationHasExplicitOwners(params: {
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
  const ownerlessJobs = (state?.rawJobs ?? []).filter((job) => !hasExplicitCronOwner(job));
  if (ownerlessJobs.length === 0) {
    return;
  }
  // Once explicit ownership publishes, no ambient owner remains to repair this store later.
  // Refuse before the config points at it rather than silently orphaning scheduled work.
  throw new Error(
    `Config write refused: cron.store destination ${params.storePath} contains ${ownerlessJobs.length} ownerless legacy cron job(s). Assign every destination job an explicit agentId with openclaw cron edit, or repair the destination with openclaw doctor --fix while its legacy owner is still available, then retry the store change.`,
  );
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
