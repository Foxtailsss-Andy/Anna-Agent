from __future__ import annotations

from services.crew.app.schemas import SopTaskSpec, SopTemplate

# 旗舰 SOP:功能迭代与设计(9 节点,3 评审门,含并行段)。示例项目=登录页重设计。
# 角色词表与 seed 一致:产品 / 文案 / 设计 / 工程 / 验收;门由产品(Boss)评审。
# 并行段(R-B #4):PRD 评审通过后分叉「设计稿 ∥ 技术预研」,两支在设计评审双父门汇合。
_FEATURE_ITERATION = SopTemplate(
    id="feature_iteration",
    name="功能迭代与设计",
    description="一次功能迭代从需求到验收合并的标准协作流程，含设计、预研并行段与三道评审门。",
    tasks=[
        SopTaskSpec(key="brief", title="需求简报", role_required="产品"),
        SopTaskSpec(key="prd", title="PRD 起草", role_required="文案",
                    depends_on=["brief"]),
        SopTaskSpec(key="prd_review", title="PRD 评审", role_required="产品",
                    depends_on=["prd"], is_gate=True, reviews="prd",
                    acceptance_criteria=(
                        "目标、范围、验收标准三者清晰；关键路径无遗漏；"
                        "登录页三态（空态、校验中、错误）口径已定义。")),
        # --- 并行段:设计稿 ∥ 技术预研,两者都在 PRD 评审通过后同时解锁 ---
        SopTaskSpec(key="design", title="设计稿", role_required="设计",
                    depends_on=["prd_review"]),
        SopTaskSpec(key="tech_research", title="技术预研", role_required="工程",
                    depends_on=["prd_review"]),
        # 设计评审=双父汇合门:设计稿 submitted + 技术预研 done 两支齐备才 ready。
        # 评审对象仍是设计稿(技术预研为并行输入,喂入门的就绪但不单独过审)。
        # 原设计评审为「产品+工程」双审;模板结构仅支持单审人,取产品(偏差登记)。
        SopTaskSpec(key="design_review", title="设计评审", role_required="产品",
                    depends_on=["design", "tech_research"], is_gate=True, reviews="design",
                    acceptance_criteria=(
                        "空态：默认免登录文案与入口齐备。"
                        "校验中：按钮禁用且等待口径可测。"
                        "错误：远程 4xx 三种文案，真图各一。"
                        "技术预研结论已纳入实现约束。")),
        SopTaskSpec(key="build", title="实施", role_required="工程",
                    depends_on=["design_review"]),
        SopTaskSpec(key="code_review", title="代码评审", role_required="产品",
                    depends_on=["build"], is_gate=True, reviews="build",
                    acceptance_criteria=(
                        "四门通过（typecheck、test、build、pytest）；"
                        "实现与设计稿三态一致；远程 4xx 错误分支有真实兜底。")),
        SopTaskSpec(key="accept", title="验收合并", role_required="产品",
                    depends_on=["code_review"]),
    ],
)

_MARKETING_COLLATERAL = SopTemplate(
    id="marketing_collateral",
    name="营销物料",
    description="营销物料的标准创作与发布流程。",
    tasks=[
        SopTaskSpec(key="brief", title="营销 Brief", role_required="PM"),
        SopTaskSpec(key="copy", title="文案撰写", role_required="文案", depends_on=["brief"]),
        SopTaskSpec(key="copy_review", title="文案评审", role_required="boss",
                    depends_on=["copy"], is_gate=True, reviews="copy",
                    acceptance_criteria="信息准确、调性一致、无合规问题。"),
        SopTaskSpec(key="visual", title="视觉设计", role_required="设计",
                    depends_on=["copy_review"]),
        SopTaskSpec(key="visual_review", title="视觉评审", role_required="boss",
                    depends_on=["visual"], is_gate=True, reviews="visual",
                    acceptance_criteria="视觉符合品牌规范与文案表达。"),
        SopTaskSpec(key="publish", title="投放、发布", role_required="运营",
                    depends_on=["visual_review"]),
    ],
)

_TEMPLATES = {t.id: t for t in (_FEATURE_ITERATION, _MARKETING_COLLATERAL)}


def list_templates() -> list[SopTemplate]:
    return list(_TEMPLATES.values())


def get_template(template_id: str) -> SopTemplate | None:
    return _TEMPLATES.get(template_id)
