# Anna FE Phase 3 — 优化轮(Refinement)spec + 计划

- 日期:2026-07-07;分支:`feat/fe-lingee-takeover` 之上继续(新分支 `feat/fe-refinement`)
- 执行:Fable 5 亲自实现(不走 superpowers 技能),每片 commit + 四门验收
- 已拍板:①Code=第四模式,本轮只出 spec 不渲染 UI;②Chat 本轮做模型档案+Skill 选择,文件上传随 Code 轮;③Agent 中心 v1=真数据总览+附加指令可编辑

## R1 模式改名(P1)
对话→Chat、工作→Cowork、开发→Create(模式切换器+相关文案)。

## R2 Cowork 看板回归 + 滑出问 Anna(P4)
finance/hiker 撤双栏:看板全宽主体;问 Anna 改滑出侧栏(右缘常驻握把+右上按钮滑出,250ms 位移动画,覆盖右侧 ~440px,拖拽调宽保留、存储键不变);点看板空白滑回。S5 的会话内容(头卡/简报/seeds/Stage-Step)整体保留在侧栏内。报销双栏不动。AgentWorkspace 保留供报销使用。

## R3 Chat 通用对话 Agent(P2 后端 + P3 前端)
- 后端(TDD):runtime 配置新增 `model_profiles`(id/label/provider/endpoint/model_name/api_key 列表;现有单配置自动迁移为 id="default" 档案)与 `agent_directives`(chat/finance/hiker/reimbursement/create → 附加指令文本)。chat 运行(POST /api/chat/runs[/stream])接受可选 `model_profile_id` 与 `skill_id`:档案解析为 settings 变体+按档案缓存 engine;skill 按次注入。附加指令由各 capability 注入 system prompt 尾部(`[Boss 附加指令]` 段)。配置编辑走既有 save→重启生效模式;档案间切换即时生效。
- 前端:composer 工具行=模型选择器(真实档案)+Skill 选择器(真实注册技能,「默认」=不指定),选择 localStorage 持久化;随运行请求发送。

## R4 产物中心(P5)
产物广场→产物中心;类型管理 Skill/Prompt/工具(Agent 类待 Code 轮);卡片动作:引用到对话/激活注册(activateDraft)/版本;Skill 卡新增「在 Chat 中使用」→ 跳 Chat 并预选该 Skill(接 R3)。

## R5 Agent 中心(P6)
侧栏用户条上方全局入口(Bot);五个真实 Agent(Chat/财务/Hiker/报销/Create)卡片:surface/模型(当前档案)/已载 Skill/可用工具(既有 admin API 数据);每 Agent「附加指令」可编辑(存 runtime 配置,注入行为已在 P2 以 TDD 锁定;保存后提示重启生效,复用既有重启入口)。

## R6 设置拆分(P7)
锚点滚动页改真子页:账户/模型(档案 CRUD 表格+provider 预设下拉自动填 endpoint 模板:DeepSeek/OpenAI 兼容/自定义)/连接(MCP)/技能与工具/运行与审计/沙箱。布尔项开关化、枚举项下拉化(以选代输)。

## R7 Code 模式 spec(P9,文档)
`docs/superpowers/specs/2026-07-07-anna-code-mode-design.md`:worktree 管理、read/write/edit/run/grep 工具集、写入与执行走审批卡(复用 awaiting_approval 范式)、上下文额度表(ContextUsageIndicator)、模型/Skill 选择(复用 R3)、文件上传。本轮不渲染任何 Code UI。

## R8 全局精致化(P8,Fable 全权)
统一字阶(11/12.5/13/14/16/20)与 4/8px 间距;发丝边+仅交互件 hover 抬升;160ms 全局过渡(导航/卡片/按钮);composer 聚焦光环;空态图标化;细滚动条;Dialog/Dropdown 圆角阴影统一;登录页渐变点缀;图表配色入 token;按钮 32/36 两档;胶囊统一内距;表格 hover/表头规范。

## 执行序(P 编号即 commit 序)
P1 改名 → P2 后端配置层(TDD:档案迁移/档案选择/skill 注入/附加指令注入)→ P3 Chat 选择器 → P4 Cowork 滑出 → P5 产物中心 → P6 Agent 中心 → P7 设置拆分 → P8 精致化 → P9 Code spec → P10 四门+Playwright 走查+验收记录。

## 验收
四门(tsc/vitest/build/pytest)每片全绿;P10 全量 Playwright 走查(改名/滑出交互/模型与 Skill 选择真跑/产物中心动作/Agent 中心编辑/设置子页)0 pageerror;诚实性红线不变(只渲染真数据,无假控件)。
