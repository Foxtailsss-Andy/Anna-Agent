import {
  parseStartRun,
  resolveRunProfile,
  type EventStore,
  type ResolveRunProfileOptions,
  type StartRun,
} from "@anna/harness-v2";

export type UnresolvedStartRun = Omit<
  StartRun,
  "runProfile" | "runProfileSnapshot" | "budget" | "stopCondition"
>;

export interface ClaimRunWithResolvedProfileOptions extends ResolveRunProfileOptions {
  readonly store: EventStore;
  readonly command: UnresolvedStartRun;
}

/** Resolves one policy profile, validates the derived command, and claims it in its scope. */
export async function claimRunWithResolvedProfile(
  options: ClaimRunWithResolvedProfileOptions,
): Promise<StartRun> {
  const snapshot = resolveRunProfile(options);
  const command = parseStartRun({
    ...options.command,
    runProfile: { id: snapshot.id, version: snapshot.version },
    runProfileSnapshot: snapshot,
    budget: snapshot.budget,
    stopCondition: snapshot.terminalRules.stopCondition,
  });

  return options.store.scope({
    workspaceId: command.workspaceId,
    channelId: command.channelId,
  }).claimStart(command);
}
