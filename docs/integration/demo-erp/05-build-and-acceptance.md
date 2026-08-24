# 05 · 构建计划、验收与迁移

## 1. 分阶段开发计划

| 阶段 | 目标 | 内容 | 工期 |
|---|---|---|---|
| **P0 数据可读** | Anna 4 模块跑通 | 建库(文档01 表)→ 灌种子(文档03,路 A 直写 period_summary + 明细)→ MCP 适配读库(文档04 五工具) | 0.5–1 天 |
| **P1 真记账** | 数字由单据推导 | 实现过账(文档02 §2)→ 源单据 → GL → period_summary 派生;跑一致性校验 | 2–3 天 |
| **P2 可操作** | 像个真系统 | 管理后台 CRUD(客户/发票/供应商/账单/收付款);O2C/P2P 流程页 | 3–5 天 |
| **P3 增强** | 接近生产 | 增值税、多币种、权限、审计;Postgres;真实语义查询替换关键词路由 | 视需要 |

> 演示**最少做到 P0**;要"系统具备基本运行能力和业务逻辑"做到 **P1**;要给人操作做到 **P2**。

## 2. 技术栈(落地建议)
- DB:SQLite(P0/P1 演示)→ Postgres(P2+/与真实系统统一)。Schema 同(文档01)。
- 后端:Python **FastAPI**(与 Anna 演示连接器同栈,集成最省)。目录建议:
  ```
  demo_erp/
    db/schema.sql  db/seed.py
    domain/  (posting.py 记账, aging.py 账龄, periods.py 期间汇总, collections.py)
    api/     (REST CRUD, 可选)
    mcp/     (复用/扩展 tools/demo_mcp_connector,改为查库)
    scripts/ validate_consistency.py
  ```
- MCP 适配:在现有 `tools/demo_mcp_connector/connector.py` 的 `handle_erp` 里,把 `data.finance_*`
  换成查 `demo_erp` 库;契约(文档04)一字不改 → **Anna 零改动**。

## 3. 验收标准(建好跑这 9 条,全过才算"准、好用、数据对")

| # | 检查 | 通过标准 | 工具 |
|---|---|---|---|
| 1 | `tools/list` | 返回 5 个 ERP 工具 | ERP 探针 |
| 2 | 看板快照 | `get_dashboard_snapshot('2026-06')` 返回 6 指标+2异常+建议动作,数字=README §4 | ERP 探针 |
| 3 | 环比趋势 | 06 vs 05 各指标比值 = 文档03 §7 的环比(±0.2pp) | ERP 探针 |
| 4 | 账龄 | `get_receivables_aging` rows 之和 = 看板逾期(980,000),A/C/F 三行 | ERP 探针 |
| 5 | 助手问答 | `query` 对应收/费用/收入/应付/利润五类问题都有合理 answer + sources | ERP 探针 |
| 6 | 催收写读 | `create_draft` 返回非空 `external_task_id`;`get_status` 状态一致 | ERP 探针(--write) |
| 7 | 一致性 | `validate_consistency.py`:利润=收入−费用;AR=未收发票之和;AP=未付账单之和;每张 je 借贷平衡 | 库内脚本 |
| 8 | 报销主数据 | DEPT-001/CC-001/EMP-001/PROJ-ACME 存在且可查 | REST/库 |
| 9 | 诚实标注 | 所有对外文案含「演示数据/演示租户」 | 人工/探针 grep |

> **ERP 探针**:我可按现有 `scripts/probe-reimbursement-mcp.mjs` 同款,给你们一个
> `scripts/probe-erp-mcp.mjs`(零依赖 Node),一条命令跑第 1–6、9 条。说一声我就写。

## 4. 接入 Anna(建好后)
1. 把 MCP 适配端点(如 `http://<host>:8970/erp/rpc`)填进 Anna 的 `erp_mcp_server`(Admin 或 runtime.json)。
2. 重启 Anna runtime → Admin 看 `erp_mcp: connected`(5 工具)。
3. Cowork → 财务经营看板/财务助手/Associate 实测;跑探针确认 9 条。

## 5. 迁移到室友真实系统(关键:Anna 与适配层都不重写)
```
现在:  Anna ──MCP──▶ 适配层 ──查──▶ 演示库(SQLite)
以后:  Anna ──MCP──▶ 适配层 ──调──▶ 室友真实系统(REST/DB, Postgres)
                      ▲ 契约(文档04)不变,只换"查库"为"调真实系统"
```
- **契约稳定**(文档04)是迁移无痛的前提:工具名、入参、返回字段锁死。
- 真实系统只要能提供:期间财务汇总、应收账龄、应付、催收任务写读、报销主数据 —— 适配层把它们映射成 5 工具即可。
- 若真实系统直接说 MCP(像室友报销系统那样),可省掉适配层,Anna 直连。

## 6. 给 Roommate 的一句话任务
> 「照 docs/integration/demo-erp/ 这套文档,用 FastAPI+SQLite 建一个迷你经营系统:文档01 建表、
> 文档03 灌一套对得上的演示数据、文档02 实现记账与一致性、文档04 把 5 个 ERP 工具接到现有
> demo 连接器(改为查库)。建完跑 ERP 探针 9 条全过。Anna 一行不用改。」
