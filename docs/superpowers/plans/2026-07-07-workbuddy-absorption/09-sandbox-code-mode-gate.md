# W9 — 沙盒激活路径 + Code 模式门(指向既有 spec)

> 对照物:WorkBuddy 截图 3 的场景本体——Loop Agent 在真实文件系统上「修改、运行校验: …\scrub_brands.py」→ 观察「脚本太慢了」→ 优化重跑;沙盒(FileProvider+NetworkExtension+SandboxHelper)位于**工具执行层**,权限模式(「允许完全访问」红色警示)决定跨界放行;「查看所有变更 (13)」= 文件写的 diff 汇总。
> **沙盒位置匹配(架构对齐)**:WorkBuddy 用 OS 级隔离(macOS FileProvider/NetworkExtension);Anna 按已拍板架构(anna-aios-architecture:Sandbox=代码执行工具,物理隔离用 Capability.isolation_mode)采用**进程级沙盒挂在工具执行层**,由 W4 权限模式守门——同一层位、不同实现代价,Windows 下不追 OS 级。
> 本文档是**门(gate)文档**:Code 模式的完整设计已在 `docs/superpowers/specs/2026-07-07-anna-code-mode-design.md`(worktree/读写执行工具/审批门/上下文额度表),执行时按该 spec 另开切片计划(writing-plans 展开)。本文只定义:沙盒从"评审版"到"可激活"的里程碑、与 W 系列的依赖关系、验收门。

## 现状锚点

| 事实 | 位置 |
|---|---|
| 评审版沙盒(已写全) | `services/create/app/sandbox.py`:AST 白名单 :17 / 危险调用黑名单 18-100 / 子进程 `-I -S` :142 / env 白名单 :150 / 5s 超时 / 8KB 输出 / 工作目录限定 :119 |
| 激活硬 block(要解锁的门) | `services/create/app/orchestrator.py:229-236`(恒 fail `python_tool_activation_blocked`) |
| hardened_sandbox 恒 False | `services/api/app/projections/governance.py:34,153`;自探针 39-160(block/timeout/network 断言) |
| isolation_mode 纯设计 | `docs/design/2026-06-28-*.md:87,122,207`(代码零命中) |
| Code 模式 FE 站位 | `apps/desktop/src/features/create/CreatePage.tsx`(plan/diff/terminal/files 四个暗色站位 tab) |
| 权限/审批地基 | W4 产物:`tool_risk.py` / `permission_gate.py` / ApprovalCard |

## 里程碑(顺序执行,每个可独立验收)

### M1 — 硬化探针达标(hardened_sandbox=True 的事实依据)

- [ ] Windows Job Object 资源限制(内存上限/进程数=1/杀进程树)包住 :142 的子进程——新模块 `services/create/app/sandbox_win.py`,`assign_job_object(popen) -> None`;探针(governance.py)新增内存炸弹/fork 炸弹两条断言,全过后 `hardened_sandbox` 改为**探针结果驱动**(不再写死 False)。TDD:`tests/create/test_sandbox_hardening.py`。
- [ ] 网络封锁从"AST 拒 import"升级为"运行时兜底":子进程 env 注入 `PYTHONSTARTUP` 禁 socket(sitecustomize 法在 -S 下不可用,用 startup 脚本 monkeypatch socket.socket 抛 PermissionError);探针 network_blocked 改为真实拦截断言。
- [ ] commit `feat(sandbox): W9.M1 — hardened runner (job object + runtime net block)`。

### M2 — python 工具激活解锁(Create 闭环)

- [ ] `orchestrator.py:229-236` 的恒 block 改为三条件门:`探针全绿 && runtime.json sandbox.allow_activation=true && permission_mode=="default" 下走审批`(激活=HIGH_RISK_TOOLS,进 W4 的 tool_risk 表,触发 ApprovalCard 人工确认)。TDD:三条件矩阵测试。
- [ ] 激活后的工具进 create registry 动态段,调用时**每次**都在 M1 沙盒内执行(不是激活时跑一次)。审计 `python_tool.executed {tool_id, duration_ms, exit}`。
- [ ] commit `feat(create): W9.M2 — python tool activation behind sandbox + approval gate`。

### M3 — Code 模式切片计划(另立文档)

- [ ] 前置检查:W1(step 帧/计划面板——Code 模式的过程呈现直接复用)、W4(审批)、M1/M2 全部完成。
- [ ] 按 `docs/superpowers/specs/2026-07-07-anna-code-mode-design.md` 用 writing-plans 展开 `plans/<日期>-anna-code-mode/`(worktree 工具/Read-Write-Execute 工具组/diff 汇总=截图「查看所有变更」对应物/CreatePage 四站位 tab 逐个点亮),那份计划替代本节。

## 验收门(M1+M2)

四门全绿;探针页(设置→沙箱与治理)全绿且 hardened_sandbox=true 为真值非写死;演示:Create 生成一个 python 小工具 → 审批卡确认 → 激活 → chat/create 调用它在沙盒执行 → 审计链完整;恶意样例(读 C:\、连外网、内存炸弹)全被拦且有审计。

## 风险

- Windows Job Object 兼容性(Electron 打包环境):M1 先在 dev 环境达标,打包环境探针不过则 hardened_sandbox 如实显示 false 且激活门保持关闭——**诚实性优先,宁可功能不开也不虚标安全**。
- 范围蔓延:本 W 不做容器/WSL 隔离、不做 isolation_mode 多进程架构(留给 Crew 异步化轮按架构记忆推进)。
