# RC1 · Workbench source Developer Preview

RC1 connects ordinary conversation in Home/Create, Cowork, and Crew to shared Harness Sessions and Runs. Anna can answer directly and discover authorized capabilities; explicit resource creation and existing business workflows remain available.

This release is source only. Build and run it on macOS arm64 using the quick start in [README](../../README.md) or [中文说明](../../README.zh-CN.md), then configure a local model provider as described in [DEVELOPMENT](../../DEVELOPMENT.md). No new installer, signature, or notarization is included.

## Changes / 变化

- Ordinary questions and follow-up use stable Session/Run identity without requiring a resource kind or an Artifact.
- Available search, URL reading, registered Skills, and explicitly authorized workdir file reading reuse the existing capability and Gateway boundary.
- Cowork dashboards retain independent refresh; Crew questions retain project/channel scope. Existing Create, Hiker, reimbursement, and Crew business actions remain available.
- Run state and targeted Stop are visible. Navigation and closing a view do not cancel the backend task. Missing model configuration is reported explicitly.

## Validation / 验证

Source commit: [`b450ee1f8173`](https://github.com/Foxtailsss-Andy/Anna-Agent/commit/b450ee1f8173f169444730a7e99d0bac054b6a14). Documentation is committed separately; the release commit retains the same product/test bytes.

The local checks used macOS arm64, Node 24.12.0, Python 3.12.13, and the existing verified OMP 18.0.11 / Bun 1.3.14 runtime. No runtime package or lockfile changed for RC1.

| Check | Recorded result |
| --- | --- |
| `npm run typecheck` | Final source passed, exit 0. |
| `npm run build` / `npm run harness:v2:build` | Web and Host builds passed. Web was rebuilt after the final frontend fixes; Host inputs stayed unchanged. |
| `.venv/bin/python -m pytest -q` | 1093 passed, exit 0. |
| `npm test -- --reporter=dot` | Initial candidate: 1239 passed, 2 failed on the existing 5000 ms timeout, 7 skipped, exit 1. Final frontend review fixes came after the frontend portion; Host/backend inputs remained frozen. |
| Two timed-out legacy workdir cases, isolated | Both passed under the original 5000 ms limit (3573 ms / 2924 ms). The full-suite failures remain recorded; their timing cause is not uniquely established. |
| `npm run frontend:product-smoke` | 9 passed, exit 0. |
| `node --test tests/frontend/rc1_workbench_ui.test.mjs` | Final built product UI passed, exit 0; independent controller run 35.586 seconds. |
| Standards / Spec review | Both axes closed their findings. Final scoped timing probes passed; no remaining hard Standards or Spec findings. |

The UI test runs the real Product Host, Python identity/business stores, Gateway, and OMP against an explicitly fixed local HTTPS model transport. It checks ordinary answers, follow-up history, resource creation entry points, session reopening, scoped synthetic Crew project/channel reads, Hiker conversation close/refresh/reopen and targeted stop, and a real unconfigured Host. Crew answers are derived from validated tool output, including success status, project/workspace identity, and stored channel facts. Screenshots were visually checked.

The full JavaScript suite was not repeatedly rerun locally after the targeted frontend repairs. GitHub CI runs it again on the published release commit, together with the maintained checks and this UI flow. See the [repository Actions](https://github.com/Foxtailsss-Andy/Anna-Agent/actions) and the GitHub release notes for that commit's final CI status. Local timeouts are not relabeled as a clean full-suite pass.

Prior WB01/WB02 deterministic and OMP evidence remains in the repository. It covers the earlier source, not the new UI integration. The prior 5-second intermittent focused-test timeout and historical readiness/raw-log limitations remain recorded in the existing handoffs.

## Limits / 限制

- Local identity, state, Gateway, and OMP use the real implementation; deterministic external model transports prove behavior, not live model quality. Current Provider/MCP acceptance is blocked, distribution-package acceptance is not run, and runtime usage is unavailable where the provider does not report it.
- macOS arm64 is the current development validation platform. Windows/Linux and a new packaged application are not accepted by this source release.
- Full fair scheduling, steer, ask/answer, crash recovery, directory/content search, additional business capability catalog entries, Memory, Sandbox, and general execution remain pending. RC1 is a bounded preview, not complete M1 or production acceptance.
- Existing Hiker permissions and reimbursement/Crew state machines remain the business authority. Live Hiker writes/readback depend on the connected service and are not established by read-only or synthetic tests.

RC1 发布后保留上述待办，不自动扩大开发范围。源码与启动方式面向开发者；真实业务操作受已配置服务及权限约束。
