# Anna Code 模式(通用 Vibe Coding Agent)设计 spec

- 日期:2026-07-07;状态:设计已批准方向(P3 优化轮拍板:四模式,本轮出 spec,下一轮专轮实现)
- 对标:Claude Code 的 Code 窗口;运行在 Anna 既有 forge 引擎上(QueryEngine + capability 模式)
- 红线:零假 UI——本 spec 落地前,模式切换器保持 Chat/Cowork/Create 三段,不渲染 Code 入口

## 1. 定位

第四顶层模式 **Code**:面向仓库/目录的通用编码 Agent。用户选定工作目录(或由 Anna 创建 git worktree),用自然语言布置编码任务;Agent 以 ReAct 循环读代码、改代码、跑命令,全过程 Stage/Step 可见,写入与执行动作走审批门。

## 2. 复用底座(全部已存在)

| 能力 | 复用自 |
|------|--------|
| ReAct 引擎/流式帧契约(text_delta/tool_*/event/done/error) | QueryEngine + R2 统一帧词表 |
| 审批门(awaiting_approval → approve/reject) | 报销 capability 的挂起/恢复范式 |
| Stage/Step 折叠 | agentStream/agentTraceModel/StageStepTrace |
| 模型/Skill 选择 | P3 的 model_profiles + skill_id 运行参数 |
| Boss 附加指令 | P2 agent_directives("code" 键) |
| 上下文额度表 | ContextUsageIndicator + model_context_window 设置 |

## 3. 后端新建(services/code/)

- **CodeOrchestrator**(BaseOrchestrator 派生):runs 内存态;start/stream 同 chat 双轨;run 携带 workspace 路径与 worktree 元数据。
- **工作区管理**:`POST /api/code/workspaces` 注册本地目录(白名单存 runtime 配置 `code_workspaces`,防任意路径);可选 `create_worktree=true` 时 `git worktree add .anna-worktrees/<run>`(仓库需为 git);run 结束可 `merge/keep/discard`。
- **CodeCapabilityHandler 工具集**(全部限定在工作区根内,路径穿越即拒):
  - `code.read_file(path, offset?, limit?)` / `code.list_dir(path)` / `code.grep(pattern, glob?)` — 只读,不审批
  - `code.write_file(path, content)` / `code.edit_file(path, old, new)` — **审批门**:挂起 run,前端渲染 diff 审批卡(复用 lg-decision-card),同意才落盘
  - `code.run_command(cmd)` — **审批门**;命令在工作区 cwd 下执行,超时 120s,输出截断 8k;禁止清单(rm -rf/format 等)代码层拦截
  - 会话级「本次全部允许写入」开关(用户显式打开,审计记录),对标 Claude Code 的权限模式
- **上下文额度**:orchestrator 逐轮累计 tokens(engine 已有用量事件),`context_used/context_window` 随帧下发。
- **文件上传**:`POST /api/code/uploads`(≤2MB 文本类),存工作区 `.anna-uploads/`,作为消息附件注入 prompt;Chat 复用同一端点族(R3 遗留项一并落)。
- 审计:每个工具调用/审批决定进 audit_events(既有 AuditService)。

## 4. 前端(features/code/)

- 模式切换器加第四段 `Code`(icon: Terminal);侧栏:新会话 CTA、工作区选择器(白名单内选择或注册新目录)、会话历史(runs 列表)、资源(产物中心)。
- 主视图 = 会话列(全宽单栏,Claude Code 式):消息流 + Stage/Step + **diff 审批卡**(写入前 old/new 对照,同意/驳回)+ **命令审批卡**(命令+cwd,同意/驳回)+ 运行输出块(等宽字体,可折叠)。
- composer:模型选择器 + Skill 选择器(复用 P3 组件)+ 附件按钮(上传)+ 权限模式开关(「逐次审批 / 本次允许写入」)+ 右上 ContextUsageIndicator(used/window 百分比,>80% 橙、>95% 红)。
- 状态徽标:当前工作区路径 + worktree 分支名常驻头部。

## 5. 分片计划(下一轮)

C1 后端 workspaces+只读工具(TDD)→ C2 写入/命令审批门(TDD,对标报销挂起测试)→ C3 worktree 生命周期 → C4 前端会话视图+审批卡 → C5 上传(Code+Chat 共用)→ C6 上下文额度表 → C7 权限模式开关+审计 → C8 验收(真实仓库端到端:改一个文件+跑测试+审批链路)。

## 6. 不做(v1)

多 worktree 并行会话、终端交互式(TTY)命令、二进制文件编辑、远程仓库 clone、自动 commit/push(用户手动或明确指令,且 push 永远逐次确认)。
