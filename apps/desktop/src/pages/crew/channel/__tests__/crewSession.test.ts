/**
 * latestCrewSession · 进入项目频道时恢复哪一个 Crew Anna 会话(review RS/C6)。
 * 只认本项目的 crew surface 会话;取最近更新的那个;无 → null(不造会话)。
 */
import { describe, expect, it } from "vitest";

import { latestCrewSession } from "../crewSession";

describe("latestCrewSession", () => {
  it("picks the most recently updated crew session of this project", () => {
    expect(latestCrewSession([
      { session_id: "s-old", surface: "crew", project_id: "p1", updated_at: "2026-10-07T08:00:00Z" },
      { session_id: "s-new", surface: "crew", project_id: "p1", updated_at: "2026-10-08T09:30:00Z" },
      { session_id: "s-mid", surface: "crew", project_id: "p1", updated_at: "2026-10-08T01:00:00Z" },
    ], "p1")).toBe("s-new");
  });

  it("ignores chat sessions and crew sessions of other projects", () => {
    expect(latestCrewSession([
      { session_id: "chat-1", surface: "chat", updated_at: "2026-10-09T00:00:00Z" },
      { session_id: "other", surface: "crew", project_id: "p2", updated_at: "2026-10-09T00:00:00Z" },
      { session_id: "mine", surface: "crew", project_id: "p1", updated_at: "2026-10-01T00:00:00Z" },
    ], "p1")).toBe("mine");
  });

  it("falls back to created_at when updated_at is missing", () => {
    expect(latestCrewSession([
      { session_id: "a", surface: "crew", project_id: "p1", created_at: "2026-10-01T00:00:00Z" },
      { session_id: "b", surface: "crew", project_id: "p1", created_at: "2026-10-03T00:00:00Z" },
    ], "p1")).toBe("b");
  });

  it("no matching session → null", () => {
    expect(latestCrewSession([], "p1")).toBeNull();
    expect(latestCrewSession([{ session_id: "x", surface: "chat" }], "p1")).toBeNull();
  });
});
