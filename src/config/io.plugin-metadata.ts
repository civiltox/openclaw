import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

/** Merges validation metadata from every configured agent workspace. */
export function mergeValidationPluginMetadataSnapshots(
  snapshots: readonly PluginMetadataSnapshot[],
): PluginMetadataSnapshot {
  const first = snapshots[0];
  if (!first) {
    throw new Error("Cannot merge an empty plugin metadata snapshot set.");
  }
  if (snapshots.length === 1) {
    return first;
  }
  const recordsByPluginId = new Map<
    string,
    Map<string, PluginMetadataSnapshot["plugins"][number]>
  >();
  for (const metadata of snapshots) {
    for (const plugin of metadata.manifestRegistry.plugins) {
      const pluginId = first.normalizePluginId(plugin.id);
      const bySource = recordsByPluginId.get(pluginId) ?? new Map();
      bySource.set(plugin.source, plugin);
      recordsByPluginId.set(pluginId, bySource);
    }
  }
  const diagnostics = snapshots.flatMap((metadata) => metadata.manifestRegistry.diagnostics);
  const plugins: PluginMetadataSnapshot["manifestRegistry"]["plugins"] = [];
  for (const [pluginId, bySource] of recordsByPluginId) {
    if (bySource.size > 1) {
      diagnostics.push({
        level: "error",
        pluginId,
        message: `plugin id ${JSON.stringify(pluginId)} is present in multiple agent workspaces: ${[...bySource.keys()].toSorted().join(", ")}`,
      });
      continue;
    }
    const plugin = bySource.values().next().value;
    if (plugin) {
      plugins.push(plugin);
    }
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ...first,
    workspaceDir: undefined,
    pluginIds: undefined,
    plugins,
    diagnostics,
    manifestRegistry: { plugins, diagnostics },
    byPluginId: new Map(plugins.map((plugin) => [first.normalizePluginId(plugin.id), plugin])),
  };
}
