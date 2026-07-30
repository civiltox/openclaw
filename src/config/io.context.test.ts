import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { mergeValidationPluginMetadataSnapshots } from "./io.context.js";

function plugin(id: string, source: string): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "workspace",
    rootDir: `/tmp/${id}`,
    source,
    manifestPath: `${source}/openclaw.plugin.json`,
  };
}

function snapshot(plugins: PluginManifestRecord[]): PluginMetadataSnapshot {
  return {
    normalizePluginId: (pluginId: string) => pluginId.toLowerCase(),
    plugins,
    diagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
  } as unknown as PluginMetadataSnapshot;
}

describe("config validation plugin metadata snapshots", () => {
  it("merges plugins discovered in distinct agent workspaces", () => {
    const merged = mergeValidationPluginMetadataSnapshots([
      snapshot([plugin("ops-plugin", "/tmp/ops/plugin")]),
      snapshot([plugin("research-plugin", "/tmp/research/plugin")]),
    ]);

    expect(merged.manifestRegistry.plugins.map((entry) => entry.id)).toEqual([
      "ops-plugin",
      "research-plugin",
    ]);
  });

  it("rejects one plugin id discovered from different workspace sources", () => {
    const merged = mergeValidationPluginMetadataSnapshots([
      snapshot([plugin("shared", "/tmp/ops/shared")]),
      snapshot([plugin("shared", "/tmp/research/shared")]),
    ]);

    expect(merged.manifestRegistry.plugins).toEqual([]);
    expect(merged.manifestRegistry.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", pluginId: "shared" }),
    );
  });
});
