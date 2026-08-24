import { InMemoryEventStore } from "../src/index";
import { eventStoreConformance } from "./conformance";

eventStoreConformance(() => new InMemoryEventStore());
