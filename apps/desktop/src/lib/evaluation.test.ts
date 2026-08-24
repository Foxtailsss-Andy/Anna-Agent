/**
 * evaluation(J2 前端补完)· 判断层「未完全达成」的诚实标注
 *
 * 断言全部围绕一件事:**只有判断层真的标注了缺口,答案区才出这条**。
 * 干净的 run、评估被跳过的 run、以及判断层复核通过的 run,答案区一个字都不该多。
 */
import { describe, expect, it } from "vitest";

import { evaluationNotice } from "./evaluation";

const ev = (type: string, payload: unknown = {}) => ({
  type,
  run_id: "chat_run_001",
  payload,
  created_at: "2026-08-05T10:00:00Z",
});

describe("evaluationNotice", () => {
  it("有 flagged → 给出缺口原文(判断层写什么就显示什么)", () => {
    const notice = evaluationNotice([
      ev("run.evaluation.started", { trigger: "claim_no_tools" }),
      ev("run.evaluation.verdict", { category: "partial", confidence: 0.9 }),
      ev("run.evaluation.flagged", { gaps: ["报告只写了上月,未覆盖季度", "未交付图表"] }),
    ]);
    expect(notice).not.toBeNull();
    expect(notice!.gaps).toEqual(["报告只写了上月,未覆盖季度", "未交付图表"]);
  });

  it("干净的 run(零评估事件)→ null,答案区不出任何多余的话", () => {
    expect(evaluationNotice([ev("chat.response.generated", { response_hash: "x" })])).toBeNull();
  });

  it("评估被跳过(fail-open)→ null:没判断出结论就不该吓唬用户", () => {
    expect(
      evaluationNotice([
        ev("run.evaluation.started", { trigger: "plan_pending" }),
        ev("run.evaluation.skipped", { reason: "judge_unavailable" }),
      ]),
    ).toBeNull();
  });

  it("复核通过(achieved,无 flagged)→ null", () => {
    expect(
      evaluationNotice([
        ev("run.evaluation.started", {}),
        ev("run.evaluation.verdict", { category: "achieved", confidence: 1 }),
      ]),
    ).toBeNull();
  });

  it("flagged 但 gaps 为空 → 仍然出条(标注是真的),只是没有条目可列", () => {
    const notice = evaluationNotice([ev("run.evaluation.flagged", { gaps: [] })]);
    expect(notice).not.toBeNull();
    expect(notice!.gaps).toEqual([]);
  });

  it("gaps 里的非字符串/空串被剔除,不渲染垃圾", () => {
    const notice = evaluationNotice([
      ev("run.evaluation.flagged", { gaps: ["真缺口", "", 42, null, "另一个"] }),
    ]);
    expect(notice!.gaps).toEqual(["真缺口", "另一个"]);
  });

  it("多次 flagged(补办后仍不达)→ 取最后一次,不叠加旧结论", () => {
    const notice = evaluationNotice([
      ev("run.evaluation.flagged", { gaps: ["第一轮的缺口"] }),
      ev("run.evaluation.flagged", { gaps: ["补办后仍缺的"] }),
    ]);
    expect(notice!.gaps).toEqual(["补办后仍缺的"]);
  });

  it("非数组/畸形载荷 → null(不猜、不崩)", () => {
    expect(evaluationNotice(null)).toBeNull();
    expect(evaluationNotice(undefined)).toBeNull();
    expect(evaluationNotice("nope")).toBeNull();
    expect(evaluationNotice([null, 7])).toBeNull();
    expect(evaluationNotice([ev("run.evaluation.flagged", { gaps: "not-an-array" })])!.gaps).toEqual([]);
  });
});
