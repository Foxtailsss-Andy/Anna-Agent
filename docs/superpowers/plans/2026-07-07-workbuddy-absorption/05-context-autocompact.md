# W5 — LLM 摘要压缩层(autocompact)+ 上下文指示全局化

> 对照物:WorkBuddy 三层防御——预防(memorySelector+延迟加载)/ 压缩(compact Agent,40% 触发,结构化摘要)/ 恢复(contextSummary Agent,90% 触发,9 段式重建);关键指令「所有任务已完成,不要重新执行」防止压缩后重复动作;阈值配置化(product.json tokenUsageThresholds)。
> Anna 现状:便宜无损层已接线(token 估算/阈值/旧 tool-result 截断/context_percent_left 审计);**LLM 摘要层在模块 docstring 里明说 "lands in a later slice"**;断路器常量与 `AutoCompactTrackingState` 已定义未使用。本 W 就是把"later slice"落掉。依赖 W2(lite 档跑摘要)。

**目标效果**:① 长对话在估算 tokens 超阈值时,中段历史被 lite 模型压成结构化摘要(头部 system+尾部近 N 条受保护);② 压缩在 trace 中可见(「上下文已压缩:节省 ~X tokens」);③ 连续失败断路(跳过压缩,只截断,不死循环);④ 上下文 % 指示从 finance 专属变成全 surface composer 常驻。

## 现状锚点

| 事实 | 位置 |
|---|---|
| 便宜层模块(本 W 的宿主) | `services/runtime/app/context_compaction.py`:estimate_tokens 180-193,阈值 126-148,compact_messages 196-243(PROTECTED_TAIL_MESSAGES=6),docstring 22-26 声明缺摘要层 |
| 断路器(已定义未接) | 同文件 :48 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`、:71-83 `AutoCompactTrackingState` |
| 挂点(chokepoint) | `services/runtime/app/harness_runtime.py:56-96`(call_model:压缩→context_usage 审计→调用);流式 `engine/streaming_model.py:133-155` |
| 审计事件 | `context.compaction.applied`(既有)、`model.call.started{context_percent_left}`(既有) |
| FE 指示器(仅 finance) | `apps/desktop/src/features/finance/ContextUsageIndicator.tsx`(读 model.call.started 帧) |
| vendored 参考件 | `vendor/hermes-agent/agent/context_compressor.py`(小模型摘要中段/保护头尾/Resolved-Pending 模板)、`conversation_compression.py`(可行性探针/阈值下调)——只读参考 |

## 契约

**autocompact 函数**(加在 context_compaction.py,纯函数+注入的调用器):

```python
def autocompact_messages(messages: list[dict], *, summarize: Callable[[str], str | None],
                         state: AutoCompactTrackingState, window: int,
                         threshold: float) -> tuple[list[dict], AutoCompactInfo | None]:
    """est_tokens/window < threshold → 原样返回。否则:
    保护段 = system 头 + 最近 PROTECTED_TAIL_MESSAGES 条;中段 → summarize() 生成结构化摘要,
    以一条 user 消息回填:<conversation_summary>…</conversation_summary>。
    summarize 返回 None(失败)→ state.record_failure();连续≥MAX 次 → 断路,退回便宜截断。
    成功 → state.reset()。返回 info{before_tokens, after_tokens} 供审计。"""
```

**摘要模板**(WorkBuddy 9 段式裁剪为 5 段,prompt 常量进模块):`原始意图 / 已完成(含关键结论与数据) / 未完成与下一步 / 关键实体(单号、id、文件) / 注意事项`;末尾固定一句:**「以上任务中已完成的部分不要重新执行。」**(防重复动作,WorkBuddy 关键指令同款)。

**summarize 实现**:`aux_tasks.run_aux_completion(tier="lite", system=SUMMARY_SYSTEM, user=中段文本, max_tokens=768)`(W2 产物;没配 lite 档 → 走 default 模型;连 default 都不可用 → summarize 返回 None 走断路)。

**阈值配置**(runtime.json,新键,读入 config.py):

```json
"context": { "autocompact_enabled": true, "autocompact_threshold": 0.6, "hard_truncate_threshold": 0.85 }
```

0.6 触发摘要(对齐 WorkBuddy inputTokens.warning),0.85 兜底截断(既有便宜层),两层各司其职。审计新增 `context.autocompact.applied {before_tokens, after_tokens, model}`。

## 任务分解

### Task 1: autocompact 纯函数 + 断路器接线(TDD)

**Files:** Modify `services/runtime/app/context_compaction.py`;Test `tests/runtime/test_autocompact.py`。

- [ ] Step 1:失败测试——低于阈值不动;超阈值中段被替换为 summary 消息且头尾受保护;summarize 连续失败 N 次断路退回截断;成功后 state 重置 → 实现 → PASS。
- [ ] Step 2:commit `feat(harness): W5.T1 — autocompact summary layer + breaker wiring`。

### Task 2: 挂到 chokepoint + 配置(TDD)

**Files:** Modify `services/runtime/app/harness_runtime.py`(call_model 顺序:autocompact→便宜层→审计)、`streaming_model.py` 同步、`config.py`(context 配置键);Test:fake provider 长历史触发,断言 `context.autocompact.applied` 事件与消息形变;开关 false 时不触发。

- [ ] Step 1:失败测试 → 接线 → PASS;全量 pytest。
- [ ] Step 2:commit `wire(harness): W5.T2 — autocompact at model chokepoint (config-gated)`。

### Task 3: 上下文指示全局化 + 压缩可见(FE)

**Files:** Move `ContextUsageIndicator.tsx` → `apps/desktop/src/features/agentic/`(finance 引用改路径);Mount 到 chat/create/reimbursement/hiker composer 区;Modify `agentTraceModel.ts`/trace 标签(`context.autocompact.applied` → 「已压缩上下文,节省 ~X tokens」行);Test:vitest 事件→标签纯函数。

- [ ] Step 1:搬迁+挂载,四面走查指示出现且随 run 更新。
- [ ] Step 2:trace 压缩行渲染;长对话真机触发一次(把 threshold 临时调 0.05 验证后还原)。
- [ ] Step 3:commit `feat(fe): W5.T3 — global context indicator + visible compaction`。

## 调用方式汇总

- 配置开关:`runtime.json → context.autocompact_enabled`(默认 true;演示不稳可关)。
- 数据流:`model.call.started.context_percent_left`(指示器)/ `context.autocompact.applied`(trace 行)——都是既有 event 帧通道,前端零新帧型。
- W3 的多轮历史组装自动受益(build_conversation_history 产出的长历史过同一 chokepoint)。

## 验收门

四门全绿;真机长对话(或调低阈值)看到:trace 压缩行 → 后续回答仍记得早期关键实体(摘要有效)→ 不重复执行已完成动作;断网 lite 模型时对话不因压缩失败而失败(断路生效)。

## 风险

- 摘要丢关键细节:5 段模板的「关键实体」段强制保留单号/id;验收含"早期实体仍可引用"人工判读。
- 每次超阈值都重摘要 → 成本抖动:summary 消息带内部标记,再压缩时旧 summary 并入中段一起重摘(单条 summary 存续,不叠罗汉)。
