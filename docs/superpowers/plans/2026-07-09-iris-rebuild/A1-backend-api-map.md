# 附录 A1 · 后端 REST API 接线地图(前端重写用)

> 生成方式:2026-07-09 对工作树(feat/fe-iris-redesign)代码级盘点。**实施时以代码现状为准**;
> 若与本表冲突,改本表并在 commit message 记录偏差。所有路径均为完整 `/api/...`(router 无额外 prefix)。

## 0. 组装与全局约定

- 工厂 `create_app()`:`services/api/app/main.py:46`;CORS 仅放行 `http://127.0.0.1:5173` / `http://localhost:5173`(main.py:58-64)。
- 桌面生产模式由后端直接服 `dist/`(SPA 兜底 `main.py:190-207`);dev 走 Vite 5173 + `/api` 代理。
- 非流式端点返回 Pydantic `model_dump(mode="json")`;SSE 端点统一 `data: <json>\n\n`(`routes/_sse.py:18-29`,chat 自带同形序列化)。
- **失败契约**:业务失败通常 HTTP 200 + `run.status:"failed"` + `error_code`/`error_message`(见 §13);前端读 run 字段,勿依赖 HTTP 状态。例外:Crew `run-agent` 映射 502/503。

## 1. 鉴权(三模式并存)

| 模式 | 适用端点 | 说明 |
|---|---|---|
| `Authorization: Bearer <token>` | `/api/auth/*`、`/api/session/current`、全部 `/api/crew/*` | token 来自 `POST /api/auth/login`;旧前端存 `localStorage["anna.crew.token"]` |
| `X-Anna-Workspace-ID` + `X-Anna-User-ID` | chat / create / finance / hiker / associate / reimbursement / admin 记忆与台账 | 值取自 `GET /api/session/current`;请求体 `workspace_id`/`actor_user_id` 必须与头一致,否则 403(`security.py:6-13`) |
| 无鉴权头 | `admin_runtime` 全部端点、governance 多数端点 | 本机管理面 |

- `GET /api/session/current`(session.py:21):带 Bearer → token 身份;无 token → 本地运行时身份回落(`runtime_config.py:219-262`,缺省 `local-workspace`/`role=boss`)。**桌面单机可免登录直用**。
- 附件上传额外头:`X-Anna-Attachment-Name`(percent-encoded)+ raw body。无 cookie 依赖。
- DEV_LOGIN_AUTOFILL 是纯前端机制(旧 `LoginPage.tsx`,演示账号 `boss@anna.demo`/`crew-demo`);后端靠 `_bootstrap_demo_workspace` 播种(main.py:265-280)。新前端保留该便利。

## 2. 端点清单(按域)

### auth / session
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| POST | `/api/auth/login` | 登录,返回 `{token,...}` | auth.py:12 |
| POST | `/api/auth/logout` | 注销(Bearer) | auth.py:20 |
| GET | `/api/auth/team` | 工作区成员(Bearer) | auth.py:27 |
| GET | `/api/health` | 存活探针 | session.py:17 |
| GET | `/api/session/current` | 当前身份(含回落) | session.py:21 |

### Chat
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| GET | `/api/chat/prompt-templates` | 模板列表 | chat.py:17 |
| GET | `/api/chat/model-profiles` | 档位选择器数据源(脱敏 `{id,label,provider,model_name}` + `default_profile_id`) | chat.py:25 |
| POST | `/api/chat/runs/stream` | **主对话 SSE**;req `CreateChatRunRequest{workspace_id,actor_user_id,message,template_id?,model_profile_id?,skill_id?}`(schemas.py:53-60) | chat.py:85 |
| POST | `/api/chat/runs` | 非流式启动 | chat.py:37 |
| GET | `/api/chat/runs` / `/api/chat/runs/{id}` | 历史列表 / 单条回看 | chat.py:59/72 |
| POST | `/api/chat/runs/{id}/save` | 保存结果为产物(`saved_by` 须等于 header user) | chat.py:125 |

### Cowork · Finance
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| POST | `/api/cowork/finance/dashboard/runs` | 看板快照 run;req `{workspace_id,actor_user_id,period}` | finance.py:16 |
| POST | `/api/cowork/finance/assistant/runs/stream` | 财务助手 SSE(+`question`) | finance.py:55 |
| POST | `/api/cowork/finance/assistant/runs` | 助手非流式 | finance.py:35 |

`FinanceDashboardSnapshot`(services/finance/app/schemas.py:57-64):`metrics[{id,label,value,unit?,trend?,narrative?}]` / `anomalies[{id,title,severity,explanation}]` / `suggested_actions[{id,label,target,payload}]`(target ∈ finance_assistant|associate|write_intent)/ `trends[{metric_id,label,unit?,points[{period,value}]}]` / `receivables_aging[{customer,customer_id?,overdue_amount,aging_days?,currency}]`。
→ 五段式映射:anomalies→AlertBand、metrics→KpiCard 带、trends→TrendChart、receivables_aging→MetricBar、suggested_actions→AskChip/建议动作。

### Cowork · Hiker
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| POST | `/api/cowork/hiker/dashboard/runs` | 看板快照(无 period) | hiker.py:16 |
| POST | `/api/cowork/hiker/assistant/runs/stream` | 助手 SSE(**无非流式版**) | hiker.py:26 |

`HikerDashboardSnapshot`(services/hiker/app/schemas.py:49-57):`source:"Hiker MCP"` / `kpis[]` / `collection{planned_amount,actual_amount,unreceived_amount}` / `aging_buckets[]` / `risk_due_soon_count,risk_overdue_count` / `top_customers[]` / `anomalies[]`。

### Cowork · 报销(审批 HITL 全通道)
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| POST | `/api/cowork/reimbursements/attachments` | 上传附件(raw body + `X-Anna-Attachment-Name`)→ `{name,uri:"anna://attachment/..."}` | reimbursement.py:96 |
| POST | `/api/cowork/reimbursements/runs/stream` | 启动 SSE(含 awaiting_approval 帧) | reimbursement.py:214 |
| GET | `/api/cowork/reimbursements/runs` / `.../runs/{id}` | 列表 / 详情 | :53/:61 |
| POST | `.../runs/{id}/answers/stream` | 补齐字段后推进 SSE(supplement 变体接这里) | :246 |
| POST | `.../approvals/{approval_id}/approve/stream` | **批准 SSE(RESUME 路径)** | :278 |
| POST | `.../approvals/{approval_id}/reject` | 驳回(非流式) | :136 |
| POST | `.../runs/{id}/verify` | 重试回读校验 | :158 |
| GET | `/api/admin/audit/reimbursement/runs/{id}` | run 审计事件流(「查看审计」按钮) | :174 |

### Create / 产物
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| POST | `/api/create/drafts` | 生成产物草稿(`kind` 默认 "skill") | create.py:37 |
| GET | `/api/create/drafts` | 草稿 run 列表(产物中心数据源;产物内容内嵌 CreateRun) | create.py:57 |
| POST | `/api/create/drafts/{run_id}/activate` | 激活(confirmed_by 须匹配 header) | create.py:65 |
| POST | `/api/create/skills` / `.../skills/{run_id}/save` | Skill 草稿生成 / 保存为正式 Skill | create.py:18/90 |

**缺口**:无独立 artifact 内容下载端点;无跨域统一产物索引(Chat 存的产物走 `/api/chat/runs/{id}/save`,Create 的在 CreateRun 内)。

### Associate(应收回收,节点审批,全同步)
`POST .../receivables-recovery/runs`(:19)/ `GET .../runs/{id}`(:39)/ `POST .../nodes/{node_id}/approval`(:51)/ `POST .../approvals/{id}/approve|reject`(:76/:98)。本轮不进 Iris IA,留后端能力。

### Crew(Bearer 鉴权)
`GET /api/crew/templates`(:78)、`POST /api/crew/projects`(:82)、`.../decompose`(:98)、`GET /api/crew/projects[/{id}]`(:116/:122)、任务 assign/start/submit/review(:127-:161)、`run-agent`(:162,502/503 映射)、`suggest-assignments`(:182)。**本轮 Iris IA 中 Crew 为站位**(虚线+即将上线),端点保留。

### Admin · Runtime(设置页数据源,无鉴权头)
| 方法 | 路径 | 用途 | 出处 |
|---|---|---|---|
| GET | `/api/admin/runtime/status` | 总览:model / reimbursement_mcp / erp_mcp / hiker_mcp / skill / tools / config(脱敏) | admin_runtime.py:71 |
| GET/PUT | `/api/admin/runtime/config` | 读写运行时配置(model_profiles、agent_directives、各域 skill_id;`requires_restart_after_save:true`) | :109/:116 |
| POST/DELETE | `/api/admin/runtime/model-profiles[/{id}]` | 档位增删(密钥不回传;id 禁空/禁 "default";409 冲突) | :125/:144 |
| GET | `/api/admin/runtime/skills` | Skill 注册表(`active_skill_id` + skills) | :98 |
| POST | `/api/admin/runtime/validate` | 实时校验探针(写 ledger,保留 20 条) | :155 |
| GET | `.../validation-ledger` / `.../validation-report` | 校验台账 / 汇总 | :169/:178 |
| GET | `/api/admin/mcp/reimbursement/status` / `.../tools` | 报销 MCP 状态 / 模型可见工具 | :59/:63 |

### Admin · Governance
`GET /api/admin/governance/status`(:40)、`GET /api/admin/agent-runs/ledger`(X-Anna-*,:56)、`GET /api/admin/harness/catalog`(:74)、`GET /api/admin/harness/domain-readiness`(:78)、`GET /api/admin/live-validation/checklist|runners`(:95/:118)、`GET /api/admin/desktop/delivery-readiness`(:136)、`GET /api/admin/tool-registry/catalog`(:140)、`POST /api/admin/sandbox/probe`(:144)、`GET|POST /api/admin/memory/business`(X-Anna-*,:148/:168)。

## 3. 关键机制标注

- **模型档位**:唯一内建档位 `"default"`(config.py:81-90);其余用户自定义于 `runtime.json` `model_profiles`,**无硬编码 lite/craft**。Chat 按 run 传 `model_profile_id`。→ Composer `modelTier` 三档(W2)不能写死:档位列表来自 `GET /api/chat/model-profiles`,UI 呈现为档位菜单;设计的 lite/default/craft 语义映射在设置「模型档案」卡中由用户命名决定。
- **Skill**:Chat 按 run 传 `skill_id`;其余域用配置 `*_skill_id`(经 PUT config)。
- **Agent 指令(Agent 中心)**:`agent_directives` 五 key = chat/finance/hiker/reimbursement/create,读写走 runtime config;各 orchestrator 经 `settings.agent_directive(agent_id)` 注入系统提示。
- **LIVE/stub 无静态常量**:即时投影 = `GET /api/admin/runtime/status` + `GET /api/admin/harness/domain-readiness`(readiness_status ∈ ready/blocked/needs_validation/unknown);未连接 = `blocked` + `*_not_connected`。→ 设置「连接」卡与看板 offline 态的数据源。

## 4. 最小必接端点集(按新 IA 分组)

- **引导**:`GET /api/session/current`(免登录回落)→ 失败再走 `POST /api/auth/login`;`POST /api/auth/logout`。
- **Chat**:model-profiles、prompt-templates、runs/stream、runs(+/{id})、runs/{id}/save。
- **Cowork**:finance dashboard/runs + assistant/runs/stream;hiker dashboard/runs + assistant/runs/stream;报销 attachments + runs/stream + answers/stream + approve/stream + reject + runs(+/{id}) + 审计。
- **Create/产物中心**:create drafts(POST/GET)+ activate + skills(+save);chat runs(source=Chat 的产物,W 站位视数据而定)。
- **设置**:runtime/status、runtime/config(GET/PUT)、model-profiles(POST/DELETE)、runtime/skills、validate + validation-ledger;开发者视角追加 governance/status、domain-readiness、agent-runs/ledger、tool-registry/catalog。
- **Agent 中心(并入设置开发者视角)**:runtime/config 读写 `agent_directives`。
