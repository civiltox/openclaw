/** Whether session.store resolves to a distinct store for each agent. */
export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  const normalized = storeConfig?.trim();
  return !normalized || normalized.includes("{agentId}");
}
