import { afterEach } from "vitest";

import { SqliteEventStore } from "../src/index";
import { eventStoreConformance } from "./conformance";

let store: SqliteEventStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

eventStoreConformance(() => {
  store = new SqliteEventStore(":memory:");
  return store;
});
