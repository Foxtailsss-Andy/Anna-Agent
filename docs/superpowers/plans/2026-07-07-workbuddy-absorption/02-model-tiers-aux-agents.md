# W2 — 模型分档(lite/default/craft)全面化 + 标题/摘要辅助小模型

> 对照物:WorkBuddy 模型成本匹配——memorySelector/Explore/promptHookEvaluator 用 lite,主 Agent 用 craft;terminalTitleGenerator/summaryGenerator 是系统触发的零工具小任务。「用廉价模型管理贵模型」。
> Anna 现状痛点:model_profiles 机制+Admin 面板全好,但 `resolve_model_profile` 只有 Chat 调用(其余 4 面死配置);全系统没有任何"系统触发的小模型任务",历史标题是 prompt 截断。

**目标效果**:① Admin 给每个 profile 标 tier;② 5 个 surface 都能 per-run 选 profile(不选则用各自默认);③ run 结束后 lite 档自动生成 3-8 词标题 + 1 句摘要,历史列表显示生成标题;④ 后续 W5(autocompact 摘要)/W6(memorySelector)直接复用本 W 的 `run_aux_completion` 地基。

## 现状锚点

| 事实 | 位置 |
|---|---|
| model_profiles 全局池 + 解析 | `services/runtime/app/config.py:63, 93-106`(`resolve_model_profile`) |
| 只有 chat 接了选择 | `services/api/app/routes/chat.py:33,54`;`services/chat/app/orchestrator.py:346`;`services/chat/app/schemas.py:27` |
| Admin 面板/路由 | `apps/desktop/src/features/admin/ModelProfilesPanel.tsx`;`services/api/app/routes/admin_runtime.py:125-153` |
| per-profile engine 缓存 | P3 引入(chat orchestrator 内),推广时沿用同模式 |
| 历史标题=截断 | `apps/desktop/src/features/chat/historyModel.ts:20-24`;Create `AnnaShell.tsx:661-669` |
| vendored 参考件 | `vendor/hermes-agent/agent/title_generator.py`(只读参考,不 import) |

## 契约

**ModelProfile 新字段** `tier: "lite" | "default" | "craft"`(缺省 "default";Admin 面板下拉)。

**tier 解析函数**(config.py 扩展):

```python
def resolve_model_profile(settings, profile_id: str | None = None,
                          tier: str | None = None) -> ModelProfile | None:
    """profile_id 优先;否则按 tier 取第一个匹配 profile;都无 → None(调用方用默认模型)。"""
```

**辅助任务模块** `services/runtime/app/aux_tasks.py`(新建,W5/W6 复用):

```python
def run_aux_completion(settings, *, tier: str, system: str, user: str,
                       max_tokens: int = 256, timeout_s: float = 20.0) -> str | None:
    """单发无工具补全,走 tier 对应 profile(无则默认模型)。任何异常返回 None——辅助任务失败绝不影响主 run。"""

def generate_run_title(settings, question: str, answer: str) -> str | None:
    """3-8 词中文标题。代码门:strip 引号/换行,>24 字截断,空串→None。"""

def generate_run_summary(settings, question: str, answer: str) -> str | None:
    """≤50 字一句话摘要。同样过代码门。"""
```

**run 字段**:ChatRun/CreateDraft 运行模型 += `title: str | None`、`summary: str | None`;审计 `run.title.generated {tier, model}`。

## 任务分解

### Task 1: tier 字段 + 解析扩展(TDD)

**Files:** Modify `services/runtime/app/config.py`、`services/api/app/routes/admin_runtime.py`(写入白名单加 tier)、`services/api/app/runtime_config.py`;Test `tests/runtime/test_model_tiers.py`。

- [ ] Step 1:失败测试——profile 带 tier 解析回读;`resolve_model_profile(tier="lite")` 命中/回退语义 → FAIL → 实现 → PASS。
- [ ] Step 2:Admin 面板加 tier 下拉(lite/default/craft),保存回读;vitest(若面板有纯逻辑测试)+ 手工走查。
- [ ] Step 3:commit `feat(harness): W2.T1 — model profile tiers`。

### Task 2: model_profile_id 推广到其余 4 面(接线,TDD)

**Files:** Modify 各面 schemas+routes+orchestrator:`services/finance/app/…`、`services/hiker/app/…`、`services/reimbursement/app/…`、`services/create/app/…`(照抄 chat 模式:schemas 加 `model_profile_id: str | None`,route 透传,orchestrator 调 `resolve_model_profile`,沿用 per-profile engine 缓存);Test 各面新增 1 个接线测试。

- [ ] Step 1:每面一个失败测试(带 profile_id 的 run 使用该 profile 的 model 名,fake provider 断言)→ 实现 → PASS;全量 pytest。
- [ ] Step 2:FE:各面 composer 的[调优]抽屉挂 profile 选择(复用 chat 既有选择器组件;W8 会把它上浮到 composer 表面,本 task 只保证功能可达)。
- [ ] Step 3:commit `wire(harness): W2.T2 — model_profile_id on all five surfaces`。

### Task 3: aux_tasks 模块 + 标题/摘要生成(TDD)

**Files:** Create `services/runtime/app/aux_tasks.py`;Modify `services/chat/app/orchestrator.py`(run 终态后同线程调用——先简单可用,异步化归 W3 之后的优化)、`services/chat/app/schemas.py`、`services/create/app/orchestrator.py`(同样接);Test `tests/runtime/test_aux_tasks.py`。

- [ ] Step 1:失败测试——fake provider 下 generate_run_title 过代码门(引号剥离/超长截断/异常→None 且主 run 不受影响)→ 实现 → PASS。
- [ ] Step 2:chat/create 接线:done 之后 run.title/summary 落值 + 审计事件;测试断言。
- [ ] Step 3:FE:`historyModel.ts` 改为 `run.title ?? question 截断`;历史列表副行显示 summary(无则 answer 节选,现状兜底保留)。
- [ ] Step 4:commit `feat(harness): W2.T3 — lite-tier title/summary aux tasks`。

## 调用方式汇总

- API:五面 run 创建请求体均接受 `model_profile_id`;`GET /api/chat/model-profiles` 既有,其他面复用同一路由。
- 配置:`runtime.json → model_profiles: [{id, name, provider, model, tier, ...}]`;推荐配一条 `tier:"lite"` 的便宜模型(如 deepseek-chat 低价档)。
- 代码:任何后端要跑小模型任务 → `from services.runtime.app.aux_tasks import run_aux_completion`。

## 验收门

四门全绿;真机走查:配置 lite profile → 发一条 chat → 历史列表出现生成标题,审计含 `run.title.generated` 且 model 为 lite 档模型;拔掉 lite profile → 标题回退截断,主 run 不受影响。

## 风险

- 没配 lite profile 的环境:一切辅助任务静默跳过(None 分支),不许报错、不许用 craft 档跑辅助任务刷成本。
- 同线程生成标题拖慢收尾:max_tokens=256+timeout 20s 兜底;若实测 >1s 影响体验,改为 route 返回后 fire-and-forget 线程(记入 W3 备注)。
