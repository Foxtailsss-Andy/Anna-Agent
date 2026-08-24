import { parseJsonValue } from "@anna/harness-v2";
import type {
  CanonicalEvent,
  JsonValue,
  ProjectionCommitResult,
  ScopedChannelStore,
} from "@anna/harness-v2";

export type ProjectionReducer<State extends JsonValue> = (
  state: State,
  event: CanonicalEvent,
) => State | Promise<State>;

export async function projectNext<State extends JsonValue>(
  store: ScopedChannelStore,
  projector: string,
  streamId: CanonicalEvent["streamId"],
  initialState: State,
  reduce: ProjectionReducer<State>,
): Promise<ProjectionCommitResult | undefined> {
  const current = await store.loadProjection(projector, streamId);
  const snapshot = current ?? {
    state: parseJsonValue(initialState, "ProjectionReducer.initialState") as State,
    version: 0,
    lastSeq: -1,
  };

  for await (const event of store.read(streamId, snapshot.lastSeq)) {
    const state = await reduce(snapshot.state as State, event);
    const committed = await store.commitProjection({
      projector,
      streamId,
      eventId: event.id,
      eventSeq: event.seq,
      expectedVersion: snapshot.version,
      state,
    });
    if (committed.applied) {
      return committed;
    }
  }

  return undefined;
}
