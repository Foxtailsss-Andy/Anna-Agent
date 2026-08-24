# Home 合并轮 · 实施计划(紧凑版)

> 2026-07-11 · 分支 `feat/fe-home-merge` · Fable 5 亲写(快速开发 · 快速校对 · 高质量)
> **设计权威** = `docs/superpowers/handoff/2026-07-11-home-merge/Anna · Home 合并轮 · 开发校对基准 V2.dc.html`(FREEZE 2026-07-11,读源码校对,含 N1-N7 红线 / H-01…H-14 / §4 扩展位 / §5 迁移表 / §6 验收)。视觉 token 与《开发校对基准(独立版)2026-07-10》并读。
> 用户授权:1:1 复刻;确实不合理处可自行调整(记录于本文件底部「偏差登记」);问题一律取**能解决问题的最简单方案**;最终目的 = 新前端 + 前后端打通 + 功能正常。

## 切片与顺序

| # | 切片 | 关键内容 | 依赖 |
|---|---|---|---|
| M1 | 壳与侧栏 | Sidebar 两段 Home\|Cowork;历史组模式联动;新建任务回问候页带模式;HomePage 骨架挂载 | — |
| M2 | 问候页双模 + Composer | 四层骨架;+菜单四项;Anna 档案 pill/面板;tag;/快召;模板面板;工作空间/权限弹层;M3-M7 | M1 |
| B1 | Create 流式化 | POST /api/create/runs + GET …/stream(chat 同型);humanize_step;旧 drafts 端点保留 | 可与 M2 并行 |
| M3 | 运行屏单列 | LoopCard 观测区(计划+tokens 入卡,CTX/模型退出);办妥;Create 收尾段;页头 chips;上下文环 | M1,契约靠 B1 |
| M4 | 右侧滑出面板 | 470px 挤压式;Chat 画布/Create 文件+代码;双入口;永不自动弹开 | M3 |
| B2 | 工作空间 | workspaces API + state store;run 带 workspace_id → 文件夹上下文+读工具;Electron IPC 选文件夹(浏览器回退路径输入) | 可并行,M2 的弹层先接 |
| B3 | 审批门 + agent_id | Create 写类动作 Ask 档走 awaiting_approval(复用报销原语);permission_mode 参数;chat/create 增 agent_id 注入指令 | B1 |
| M5 | 收官 | 深色三屏;§6 五项硬核对(残留清零:CTX/default·deepseek/礼成=0);Playwright 逐屏亲看;四门 | 全部 |

## 后端契约(最简方案)

- **Create 流式**:`POST /api/create/runs {prompt, kind, skill_id?, agent_id?, workspace_id?, permission_mode?}` → `{run_id}`;`GET /api/create/runs/{id}/stream` SSE 帧词表与 chat 完全一致(step/tool_start/tool_done/event/awaiting_approval/done/error);done.run 带校验三字段(validation/sandbox_result/activation_eligibility)与 artifacts/files;注册动作沿现有 activate。前端归一化层零改动直通。
- **工作空间**:`GET/POST/DELETE /api/workspaces`(`{id,name,path,last_used_at}`,POST 校验路径存在);运行注入 = 系统上下文加文件树摘要(depth≤2、条目≤200)+ 工具 `workspace.list_files` / `workspace.read_file`(路径白名单=workspace 根内,读上限 64KB);写工具仅 Create:`workspace.write_file`(Ask 档挂审批门)。
- **agent_id**:chat/create 请求可选 `agent_id` → 该 Agent 附加指令注入 system(Agent 中心 P3 库)。
- **上下文环**:前端取现有 `model.call.started.context_percent_left` 审计(W5 通路),仅换呈现(无字环)。

## 关键实现决定

1. `HomePage` 新建,吸收 ChatPage/CreatePage 职能(问候态+会话态双形态、模式绑定会话);旧 ChatPage/CreatePage 在 M3 完成后删除(迁移期共存,路由不再指向)。
2. LoopCard 结构沿用(类型步/L3/FLAT_TURN_LIMIT=4),只改观测区与 done 皮(办妥);组件不分叉(N7:两模式同一套)。
3. 模板库 v1 = `lib/templates.ts` 前端静态表(Chat 4 场景×4 模板,Create 3 kind×3-5 模板,文案照 V2 稿)。
4. 面板挤压 = flex 宽度过渡 + `container query` 降级 LoopCard(V2 H-11 规格)。
5. 附件管道:M2 先做「读入文本」honest 版(+菜单「添加文件」→读文本入 prompt 附件 chip);真文件上传管道待验证后升级(V2 稿自标 ⚠)。

## 验收

- V2 §6 全套:逐屏走查顺序①-⑧;五项硬核对(真值/整洁预算 4/7·5/7/迁移九行/扩展位不画站位/Iris 语言)。
- 四门:`npx tsc --noEmit` 0 · vitest 绿 · `npm run build` ✓ · `.venv/Scripts/python.exe -m pytest services/ tests/ -q` 绿。
- 真流亲测:Chat run + Create run 各一条(demo-erp + ANNA_RUNTIME_CONFIG_PATH),截图对照 V2 基准亲看。

## 偏差登记(实现中自行调整处,逐条记录)

- **M2 · 档案面板「档位」段暂缓**:V2 H-06 的 轻快/均衡/匠心 三档,后端今日无对应参数(W2 tier 从未接线)——按 N4 零站位红线不画,待真参数就位再上。面板 v1 = 档案列表 + 底注。
- **M2 · Agent 面板枚举口径**:V2 H-04 示例列五域;实现 = 枚举 runtime config `agent_directives` 真键(配置过指令的 Agent 才可选),空则显式空态。「默认(本域 Agent)」恒在。
- **M2 · workdir 命名**:「工作空间」后端名 `workdir`(`/api/workdirs`),避开既有租户概念 workspace_id;UI 文案不变。
- **M3 · running 页头无 run id**:V2 H-09 页头含 run id;现行帧契约 runId 只随 done/error 帧到达(chat.run.created 审计不透出 run_id 字段到归一化层)——running 期页头仅标题,done 后补全。B 系列(done.run 带 id 提前/created 事件透传)自然修复。
- **M3 · ArtifactCard「在画布打开」过渡文案**:M4 右侧滑出面板落地前,产物卡点击为新窗口打开;M4 将替换为 V2 锚点 chip(◇/◈ + ↗)并接面板。
- **B3 · Ask 门本轮无受门动作**:create 管线为单次结构化调用、无写类工具(激活本就是显式用户确认),故 permission_mode 本轮真存真审计(run 字段 + `create.{kind}.run.created` 审计 payload),不挂 awaiting_approval;拦截点随后续写工具/Code 模式点亮。
