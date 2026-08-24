# Trace 轮 · 验收记录（2026-08-06，branch feat/trace-round）

## 四门终跑（收轮时全量，代码冻结后）

| 门 | 命令 | 结果 |
|---|---|---|
| pytest | `python -m pytest tests -q` | **901 passed, 0 failed**（1 个既有 httpx deprecation warning，非本轮引入）|
| tsc | `npx tsc --noEmit` | **0 errors** |
| vitest | `npx vitest run` | **47 files / 597 passed, 0 failed** |
| build | `npm run build` | **✓ built in 12.80s**（既有 elkjs/font chunk-size warning，非本轮）|

基线对照：轮前 885 pytest / 594 vitest → 轮后 901 / 597（净增 16 后端 + 3 前端，全部为本轮新测试）。

## 交付物 × commit

| # | 交付物 | commit |
|---|---|---|
| 0 | 00-plan（spec）+ 两次勘误 | d7e3fbe / 61598f2 / ef2b700 |
| 1 | `list_frames_with_meta` 读取面 | 7851b6e |
| 2 | gate RED（装配器契约 7 条） | 9af7f56 |
| 3 | 装配器 GREEN + 复审修复（gate 扩到 9 条，真实终局帧形状） | 705cef7 + f357846 |
| 4 | `GET /api/chat/runs/{run_id}/trace` | d1294f0 |
| 5 | FE client + `toWaterfall` 纯归约 | 5b98d3d |
| 6 | 瀑布图 drawer + HomePage 入口 + 两次诚实修复 | fd2a7e1 + b7354a8 + 3f34c1f |
| 7 | journal 毫秒 `ts`（附加字段） | 1c63ba7 |
| 8 | CONTEXT.md + ADR-003 + A2 增补 + 本文件 | （收轮 commit）|

## 复审纪律留痕

- 每 Task 独立复审（Task 1/2/4/5 subagent 复审，Task 3 opus 双轮含 82 帧真实捕获实测，Task 6/7 Fable 亲审）；
- 复审抓获并已修：Task 1 commit 卫生（`add -A` 扫入他轮文档→拆分）；Task 3 三 Important（`error.type` 未写 / awaiting 状态被收尾改写 / `anna.turns` 读了生产不存在的字段）+ 7 minor；Task 6 一 Critical（**测试注释不实声称做过手动点击验证→按实改写**）+ token 缺失补零两层（行 chip + 摘要条）。

## 残余缺口（如实登记，不装作验证过）

1. **瀑布行点击展开的 onClick→state 切换**：无自动化（repo 硬约束：vitest node 环境、只收 `*.test.ts`、零新依赖禁 jsdom）也无人工验证；已覆盖的是折叠态渲染与 `RowDetail` 展开内容两个真实渲染半边。→ 归入下面真机走查。
2. **真机走查（待用户）**：起桌面 App 真跑一条带 `erp.finance.query` 的消息 → 运行头点「执行过程」→ 应见：turn 分组瀑布、模型耗时/token、工具 span、压缩/判断层 chip；再开一条失败 run 看 error 标红；顺手点行展开（覆盖缺口 1）。
3. Minor 台账（终评判定均不阻塞合并）：Task 4 guard-None 分支与 conversation.id=thread 的路由级断言未覆盖（装配器 gate 已覆盖语义）；`lib/api/trace.ts` 照 crew.ts 用 Bearer authHeaders 而 chat.ts/finance.ts 同族只用 identityHeaders（无 token 时为空对象，无害不一致）；`RowDetail` 因 SSR 测试而导出（纯展示组件，可接受）；ADR-003 附注③ 的不可达极端不修。

## 与既有基准的关系

- 旧 run（无帧内 `ts`）工具 span 仍是秒粒度——瀑布最小宽度 + `<1s` 如实显示；T1b 之后的新 run 为毫秒级（e2e 实测 129ms 工具 span 不再塌 0）。
- 术语契约自本轮起以根 CONTEXT.md 为准；帧词表事实源仍是 A2（已加增补节）。

## 合并后 main 四门认证（2026-08-06，fix/judgment-review + feat/trace-round 双合流）

| 门 | 结果 |
|---|---|
| pytest | 925 passed, 0 failed |
| tsc | 0 errors |
| vitest | 48 files / 632 passed, 0 failed |
| build | ✓ |

合并序：main←fix/judgment-review（b9cf92c）←feat/trace-round（1212101）；无冲突（与 merge-tree 预测一致）。
