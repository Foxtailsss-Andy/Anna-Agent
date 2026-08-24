import type {
  ChannelSession,
  EventStore,
  Run,
  RunId,
  ScopedChannelStore,
  StartRun,
} from "@anna/harness-v2";

import { RunManager } from "./run-manager";

export class ChannelSessionService {
  private readonly runs: RunManager;

  private constructor(store: ScopedChannelStore) {
    this.runs = new RunManager(store);
  }

  static async open(
    store: EventStore,
    session: ChannelSession,
  ): Promise<ChannelSessionService> {
    const scoped = store.scope(session);
    await scoped.claimChannelSession(session);
    return new ChannelSessionService(scoped);
  }

  start(command: StartRun): Promise<Run> {
    return this.runs.start(command);
  }

  get(runId: RunId): Promise<Run | undefined> {
    return this.runs.get(runId);
  }

  reconcile(): Promise<void> {
    return this.runs.reconcile();
  }
}
