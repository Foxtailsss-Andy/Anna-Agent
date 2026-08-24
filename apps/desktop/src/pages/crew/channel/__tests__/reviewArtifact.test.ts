/**
 * reviewArtifact · R-F1 纯函数测试:评审门 → producer 最新产物解析(零捏造)。
 * 覆盖:门→reviews_task_id→producer→最新版;乱序取最大版本;扁平 artifact 退化;
 *      无产物 → latest=null;门无指向 / producer 缺失 / 门空 → 整体 null。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import { resolveReviewedArtifact } from "../reviewArtifact";

function task(partial: Partial<CrewTask> & { id: string }): CrewTask {
  return {
    project_id: "p1",
    key: partial.id,
    title: partial.id,
    status: "todo",
    role_required: "产品",
    ...partial,
  } as CrewTask;
}

describe("resolveReviewedArtifact", () => {
  it("门 → producer 最新版本正文", () => {
    const producer = task({
      id: "prd",
      title: "PRD 起草",
      artifact_versions: [
        { version: 1, content: "初稿", submitted_at: "2026-07-20T01:00:00Z" },
        { version: 2, content: "改稿", submitted_at: "2026-07-20T02:00:00Z" },
      ],
    });
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "prd", status: "in_review" });
    const r = resolveReviewedArtifact(gate, [producer, gate]);
    expect(r).not.toBeNull();
    expect(r!.producerId).toBe("prd");
    expect(r!.producerTitle).toBe("PRD 起草");
    expect(r!.latest).toEqual({ version: 2, content: "改稿", submitted_at: "2026-07-20T02:00:00Z" });
    expect(r!.versionCount).toBe(2);
  });

  it("版本乱序 → 取最大 version(非数组末位)", () => {
    const producer = task({
      id: "prd",
      artifact_versions: [
        { version: 3, content: "v3", submitted_at: "c" },
        { version: 1, content: "v1", submitted_at: "a" },
        { version: 2, content: "v2", submitted_at: "b" },
      ],
    });
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "prd" });
    const r = resolveReviewedArtifact(gate, [producer]);
    expect(r!.latest!.version).toBe(3);
    expect(r!.latest!.content).toBe("v3");
  });

  it("无版本历史但有扁平 artifact → 退化,version=null", () => {
    const producer = task({ id: "prd", artifact: "扁平正文", artifact_versions: [] });
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "prd" });
    const r = resolveReviewedArtifact(gate, [producer]);
    expect(r!.latest).toEqual({ version: null, content: "扁平正文", submitted_at: null });
    expect(r!.versionCount).toBe(0);
  });

  it("最新版正文为空白 → 退化到扁平 artifact", () => {
    const producer = task({
      id: "prd",
      artifact: "兜底正文",
      artifact_versions: [{ version: 1, content: "   ", submitted_at: "a" }],
    });
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "prd" });
    const r = resolveReviewedArtifact(gate, [producer]);
    expect(r!.latest!.content).toBe("兜底正文");
    expect(r!.latest!.version).toBeNull();
  });

  it("producer 存在但完全无产物 → latest=null(禁用通过的依据)", () => {
    const producer = task({ id: "prd", title: "PRD" });
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "prd" });
    const r = resolveReviewedArtifact(gate, [producer]);
    expect(r).not.toBeNull();
    expect(r!.latest).toBeNull();
    expect(r!.producerTitle).toBe("PRD");
  });

  it("门无 reviews_task_id → null", () => {
    const gate = task({ id: "g", is_gate: true });
    expect(resolveReviewedArtifact(gate, [gate])).toBeNull();
  });

  it("reviews_task_id 指向不存在的任务 → null(不造产物)", () => {
    const gate = task({ id: "g", is_gate: true, reviews_task_id: "ghost" });
    expect(resolveReviewedArtifact(gate, [gate])).toBeNull();
  });

  it("门为 undefined → null", () => {
    expect(resolveReviewedArtifact(undefined, [])).toBeNull();
  });
});
