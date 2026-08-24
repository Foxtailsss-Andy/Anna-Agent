# W3 — run 持久化统一 + Chat 多轮续接

> 对照物:WorkBuddy 会话全持久(截图 3「已完成 285h22m」的会话可回看可续问);Agent 生命周期含 Resume(SendMessage 到 agent-id 继续完整上下文)。
> Anna 现状痛点:chat/finance/create 的 run 在内存 LRU(256 条,重启即失);chat 单轮不可续,追问靠把上文塞进新 prompt(HANDOFF 问题 3);报销/associate 已有 SQLite 范式却未推广。R3 路线图已列此项,本文档把它展开到可执行。

**目标效果**:① 后端重启后 Chat 历史对话/Create 项目列表原样还在;② 同一条历史对话可以「继续问」——新 run 携带 conversation_id,模型看到有界的往轮上下文;③ 挂起审批(W4 通用化后)跨重启可恢复(报销已有,推广后各面同享)。

## 现状锚点

| 事实 | 位置 |
|---|---|
| 内存 LRU(要替换的东西) | `services/runtime/app/run_registry.py:12-49`(OrderedDict,上限 256,注释:每个流式 run 独立线程) |
| SQLite 范式(照抄对象) | `services/reimbursement/app/state_store.py:15-27,58-116`(save_run/get_run/list_runs/get_run_by_approval_id);`services/associate/app/state_store.py` |
| 库文件与装配 | `.anna/state/anna-state.sqlite3`;装配在 `services/api/app/main.py:135-146` |
| chat 历史路由(S2 已建) | `GET /api/chat/runs`、`GET /api/chat/runs/{id}`(`services/api/app/routes/chat.py`) |
| 上下文压缩(续聊历史要过它) | `services/runtime/app/context_compaction.py`(estimate_tokens/compact_messages) |
| FE 历史列表/恢复 | `apps/desktop/src/AnnaShell.tsx:426-445(chat), 526-545(create)`;`historyModel.ts` |

## 契约

**通用 run store**(新建,一张表服务所有内存态 surface):

```python
# services/runtime/app/run_store.py
class RunStore:  # SQLite: .anna/state/anna-runs.sqlite3
    def save_run(self, surface: str, run_id: str, payload: dict) -> None: ...   # UPSERT,payload=run 的 JSON 全量
    def get_run(self, surface: str, run_id: str) -> dict | None: ...
    def list_runs(self, surface: str, limit: int = 50,
                  conversation_id: str | None = None) -> list[dict]: ...        # 按 created_at DESC
# DDL: CREATE TABLE runs(surface TEXT, run_id TEXT, conversation_id TEXT,
#   created_at TEXT, payload TEXT, PRIMARY KEY(surface, run_id));
#   CREATE INDEX idx_runs_conv ON runs(surface, conversation_id, created_at);
```

写入策略:**write-through**——run 终态(done/error/awaiting_approval)时全量落库;运行中仍走内存 registry(流式性能不变)。读取策略:内存命中优先,miss 落库查。

**多轮契约**:`ChatRun += conversation_id: str`(首轮 = 自身 run_id;续轮 = 首轮 id)。`POST /api/chat/runs` 请求体 += `conversation_id: str | None`。orchestrator 收到 conversation_id 时:`list_runs(surface="chat", conversation_id=…)` → 按时间序取往轮 `(question, answer)` 对 → 组装为 messages 历史(user/assistant 交替)→ **过 `compact_messages` 有界化** → 再拼当前问题。往轮上限:最近 6 轮或 compact 后 ≤ 配置阈值,超出靠压缩(W5 完成后自动升级为摘要压缩)。

## 任务分解

### Task 1: RunStore(TDD)

**Files:** Create `services/runtime/app/run_store.py`;Modify `services/api/app/main.py`(装配,路径沿用 `settings` 的 state 目录约定,参考 config.py:358-363 的 memory 库装配);Test `tests/runtime/test_run_store.py`。

- [ ] Step 1:失败测试——save/get/list/UPSERT/按 conversation_id 过滤/limit 排序 → 实现 → PASS。
- [ ] Step 2:commit `feat(harness): W3.T1 — shared SQLite RunStore`。

### Task 2: chat/finance/create 接线 write-through(TDD)

**Files:** Modify `services/chat/app/orchestrator.py`、`services/finance/app/orchestrator.py`、`services/create/app/orchestrator.py`(终态落库);Modify `services/api/app/routes/chat.py` 等 list/get 路由(内存 miss → store);Test 各面 1 个「重启存活」测试(新建 store 实例模拟重启,list 仍有数据)。

- [ ] Step 1:失败测试 → 接线 → PASS;全量 pytest。
- [ ] Step 2:手工验收:跑两条 chat → 杀 uvicorn → 重启 → 历史列表还在。
- [ ] Step 3:commit `wire(harness): W3.T2 — write-through persistence for chat/finance/create`。

### Task 3: Chat 多轮续接(TDD)

**Files:** Modify `services/chat/app/schemas.py`(conversation_id)、`routes/chat.py`(透传)、`services/chat/app/orchestrator.py`(历史组装,函数 `build_conversation_history(store, conversation_id, limit=6) -> list[Message]` 独立可测);Test `tests/chat/test_multiturn.py`。

- [ ] Step 1:失败测试——续轮 run 的模型请求 messages 含往轮 QA 且经过压缩上界;首轮 conversation_id 自指 → 实现 → PASS。
- [ ] Step 2:FE:`useChatStream.send` 支持 `conversationId`;历史对话打开后 composer 不再置灰,继续发送即续轮;线程视图按 conversation 聚合渲染(`historyModel.ts` 加 `groupByConversation`,vitest)。
- [ ] Step 3:Playwright:开历史对话 → 追问 → 回答引用了往轮内容(人工判读)→ 截图归档。
- [ ] Step 4:commit `feat: W3.T3 — chat multiturn via conversation_id`。

## 调用方式汇总

- `POST /api/chat/runs {message, conversation_id?, model_profile_id?, skill_id?}`;`GET /api/chat/runs?conversation_id=…`。
- 库位置:`.anna/state/anna-runs.sqlite3`(与 anna-state/anna-memory 并列;备份=拷文件)。
- 追问动作(P4 的「整理成文档/做成网页」)改走 conversation_id,不再自行拼上文。

## 验收门

四门全绿;重启存活走查;续聊语义走查(追问「刚才第二点展开讲」能对上);LRU 淘汰后的旧 run 通过 store 仍可打开。

## 风险

- run payload 里有大 artifact(html 全文)→ 库膨胀:payload 落库前 artifacts 只存元数据+内容摘要 hash,全文另存 `artifacts` 子表(同库),按需读。
- 双写不一致:终态落库失败只记 error 日志不阻断响应(内存仍有);下次终态重试 UPSERT。
