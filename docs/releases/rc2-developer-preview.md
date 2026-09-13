# RC2 · Workbench source Developer Preview

RC2 addresses release validation failures found in RC1: the legacy workdir identity/scope test timeouts and the execution dependencies between CI evidence generation, verification, and upload. The shared Home/Create, Cowork, and Crew conversation flow remains the product scope.

RC2 聚焦 RC1 暴露的发布验证问题：旧入口工作目录身份/范围测试超时，以及 CI 证据生成、校验与上传的执行依赖。Home/Create、Cowork、Crew 共用的持续对话链路保持可用。

This is a source prerelease for developers on macOS arm64. Follow [README](../../README.md), [中文说明](../../README.zh-CN.md), and [DEVELOPMENT](../../DEVELOPMENT.md) to build, run, and configure it. No new installer, signature, or notarization is included.

## Changes / 变化

- The two legacy workdir registration/admission tests retain the real Python identity service, Product Host, persistent Runtime, and original assertions. They no longer initialize OMP before operations that finish before a Run starts. The two file-execution tests still use real OMP. No test timeout or production integrity check is relaxed.
- CI checks use explicit prerequisites, so an earlier test failure does not silently skip the required product UI, Python, and evidence checks when their dependencies are ready. Verification runs after successful generation or when a manifest exists; upload runs when evidence exists. Failed generation remains a failure, partial evidence can still be retained, and cancellation stops downstream work.

两个目录登记/入场拒绝用例保留真实身份、Product Host、持久 Runtime 和原断言，去掉尚未执行模型时不需要的 OMP 初始化。两个实际文件执行用例继续使用真实 OMP；测试时限和生产完整性检查保持。

CI 根据实际依赖继续 UI、Python 和证据检查；生成成功或已有 manifest 时执行校验，有实际产物时才上传。生成成功却缺文件仍会报错，生成失败不会被改写成成功，已有部分证据可以保留，取消后停止下游工作。

### Timeout diagnosis / 超时定位

The original focused command reproduced the same 5,000 ms timeout: the first registration test failed at about 5.15 seconds. A diagnostic timing probe measured about 0.87 seconds for Python startup, 4.37 seconds for OMP runtime manifest verification, and only tens of milliseconds for identity/workdir requests. The repeated runtime scan dominated setup; teardown took about 0.14 seconds.

After removing that unnecessary setup from the two non-executing tests, the same four-test file passed: registration 1,108 ms, admission rejection 862 ms, OMP revoke/read 10,619 ms, and OMP legacy Chat 10,983 ms. The original per-test limits remained unchanged. These are local fixture timings, not a product performance benchmark.

窄测试复现原 5 秒超时后，分段量测确认主要成本来自 OMP 运行包完整性扫描。修复后同一组四个用例全部通过；这些数字用于解释测试超时，不作为产品性能提升指标。

## Validation / 验证

Release baseline: [`9dee3583fa96`](https://github.com/Foxtailsss-Andy/Anna-Agent/commit/9dee3583fa96b590be4aacb398d5b2d4d806937d). The [RC1 record](rc1-developer-preview.md) and [failed RC1 CI run](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/runs/34567280207) remain historical evidence. RC1's product job passed; its checks job failed, and the UI/Python steps were skipped.

RC1 的原失败继续保留：product job 通过，checks job 失败，UI/Python 步骤被跳过。本轮验证单独记录，不改写 RC1 结果。

The [RC2 prerelease record](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/tag/workbench-rc2) records the final source commit, local validation results, and CI run for that exact commit. Publication requires both CI jobs (`checks` and `product`) to pass, local typechecking, the full JavaScript and Python suites, Web/Host builds, frontend smoke, the real product UI regression, and closure of the independent Standards/Spec reviews. The CI dependency guard separately covers failed prerequisites, failed generation with and without a manifest, missing output after successful generation, and cancellation.

[RC2 预发布记录](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/tag/workbench-rc2) 集中记录最终提交、本地验证结果与对应 SHA 的 CI 链接。发布门槛包括两个 CI job 通过、本地类型检查、完整 JS/Python、Web/Host 构建、前端 smoke、真实产品 UI 回归及 Standards/Spec 独立审查闭环。目录测试与 CI guard 的通过不代表真实 Provider/MCP 或分发验收完成。

## Limits / 限制

- The product UI regression uses real local identity, business stores, Gateway, and OMP with a fixed external model transport. It establishes local behavior, not live model quality. Current Provider/MCP acceptance remains blocked; usage remains unavailable where the provider does not report it.
- macOS arm64 is the development validation platform. This source release does not establish signed distribution, Windows/Linux acceptance, or production readiness.
- Full scheduling, steer, ask/answer, crash recovery, directory/content search, additional business capability catalog entries, Memory, Sandbox, and general execution remain pending. Full M1 and later milestones remain open.
- Existing Hiker permissions and reimbursement/Crew state machines remain authoritative. Live Hiker writes/readback require the connected service's capabilities; read-only and synthetic tests do not establish them. Hiker is an [external collaboration](../../README.md#credits-and-license), with its own authorship, private source, and license boundaries.

真实 Provider/MCP、签名分发、Windows/Linux 与生产验收仍未完成；本轮不关闭完整 M1。既有业务权限与状态机继续生效，合成测试不代表真实 Hiker 写入与读回已通过。
