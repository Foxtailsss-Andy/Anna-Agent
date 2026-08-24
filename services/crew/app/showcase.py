from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterable, Literal

from pydantic import BaseModel, Field

from services.crew.app.schemas import ArtifactVersion, ChannelMessage, CrewProject, CrewTask, TaskDraft
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.schemas import Account

SHOWCASE_SCENARIO_ID = "weekly_action_closure_v1"
LEGACY_SHOWCASE_SCENARIO_IDS = ("github_launch_v1",)
SHOWCASE_VERSION = 3
SHOWCASE_TEMPLATE_ID = "feature_iteration"
SHOWCASE_GOAL = "周会行动项闭环：会议纪要、责任人返工、并行核对、评审与下游同步"


class ShowcaseEnsureResult(BaseModel):
    scenario_id: str
    scenario_version: int
    project: CrewProject
    created: bool
    migrated: bool = False
    warnings: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class CrewShowcase:
    scenario_id: str
    version: int
    locale: str


def showcase_project_id(workspace_id: str, owner_user_id: str) -> str:
    return _showcase_project_id(workspace_id, owner_user_id, SHOWCASE_SCENARIO_ID)


def _showcase_project_id(workspace_id: str, owner_user_id: str, scenario_id: str) -> str:
    digest = hashlib.sha1(
        f"{workspace_id}:{owner_user_id}:{scenario_id}".encode("utf-8")
    ).hexdigest()
    return f"crew_showcase_{digest[:12]}"


class CrewShowcaseService:
    """Explicitly materializes a built-in showcase as ordinary Crew facts.

    This module never records model/tool/token evidence, never writes
    notifications, and never emits Worker-authored rows without a real execution.
    """

    def __init__(self, store: SQLiteCrewStore) -> None:
        self._store = store

    def ensure(
        self,
        *,
        workspace_id: str,
        owner_user_id: str,
        members: Iterable[Account],
        scenario_id: str = SHOWCASE_SCENARIO_ID,
        locale: str = "zh-CN",
    ) -> ShowcaseEnsureResult:
        showcase = self._resolve(scenario_id=scenario_id, locale=locale)
        project_id = showcase_project_id(workspace_id, owner_user_id)
        existing = self._find_existing_showcase(
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            project_id=project_id,
        )
        if existing is not None:
            if self._is_current(existing, showcase):
                return ShowcaseEnsureResult(
                    scenario_id=showcase.scenario_id,
                    scenario_version=showcase.version,
                    project=existing,
                    created=False,
                )
            if existing.source != "showcase":
                return ShowcaseEnsureResult(
                    scenario_id=showcase.scenario_id,
                    scenario_version=showcase.version,
                    project=existing,
                    created=False,
                    warnings=["existing showcase id is not marked as showcase; no migration applied"],
                )
            project = self._build_project(
                project_id=existing.id,
                workspace_id=workspace_id,
                owner_user_id=owner_user_id,
                members=list(members),
                showcase=showcase,
            )
            project.project_version = existing.project_version
            self._store.save_project(project)
            self._store.replace_channel_messages(project.id, self._messages(project))
            return ShowcaseEnsureResult(
                scenario_id=showcase.scenario_id,
                scenario_version=showcase.version,
                project=project,
                created=False,
                migrated=True,
            )

        project = self._build_project(
            project_id=project_id,
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            members=list(members),
            showcase=showcase,
        )
        self._store.save_project(project)
        for message in self._messages(project):
            self._store.append_channel_message(message)
        return ShowcaseEnsureResult(
            scenario_id=showcase.scenario_id,
            scenario_version=showcase.version,
            project=project,
            created=True,
        )

    def _find_existing_showcase(
        self,
        *,
        workspace_id: str,
        owner_user_id: str,
        project_id: str,
    ) -> CrewProject | None:
        project_ids = [project_id] + [
            _showcase_project_id(workspace_id, owner_user_id, legacy_id)
            for legacy_id in LEGACY_SHOWCASE_SCENARIO_IDS
        ]
        for candidate in project_ids:
            existing = self._store.get_project(candidate)
            if (
                existing is not None
                and existing.workspace_id == workspace_id
                and existing.owner_user_id == owner_user_id
            ):
                return existing
        return None

    def _is_current(self, project: CrewProject, showcase: CrewShowcase) -> bool:
        return (
            project.source == "showcase"
            and bool(project.showcase)
            and project.showcase.get("scenario_id") == showcase.scenario_id
            and project.showcase.get("version") == showcase.version
            and project.showcase.get("locale") == showcase.locale
        )

    def _resolve(self, *, scenario_id: str, locale: str) -> CrewShowcase:
        if scenario_id != SHOWCASE_SCENARIO_ID:
            raise ValueError(f"unknown showcase scenario {scenario_id!r}")
        if locale != "zh-CN":
            raise ValueError(f"unsupported showcase locale {locale!r}")
        return CrewShowcase(scenario_id=scenario_id, version=SHOWCASE_VERSION, locale=locale)

    def _build_project(
        self,
        *,
        project_id: str,
        workspace_id: str,
        owner_user_id: str,
        members: list[Account],
        showcase: CrewShowcase,
    ) -> CrewProject:
        template = get_template(SHOWCASE_TEMPLATE_ID)
        if template is None:  # pragma: no cover
            raise ValueError(f"template {SHOWCASE_TEMPLATE_ID!r} missing")
        key_to_id = {spec.key: f"{project_id}_{spec.key}" for spec in template.tasks}
        title_by_key = {
            "brief": "周会原始纪要",
            "prd": "行动项清单",
            "prd_review": "行动项评审",
            "design": "协作看板草图",
            "tech_research": "数据口径核对",
            "design_review": "纪要发布评审",
            "build": "同步到看板与群公告",
            "code_review": "闭环验收",
            "accept": "下周复盘项",
        }
        role_by_key = {
            "brief": "产品",
            "prd": "文案",
            "prd_review": "产品",
            "design": "设计",
            "tech_research": "工程",
            "design_review": "产品",
            "build": "工程",
            "code_review": "验收",
            "accept": "产品",
        }
        tasks = [
            CrewTask(
                id=key_to_id[spec.key],
                project_id=project_id,
                key=spec.key,
                title=title_by_key.get(spec.key, spec.title),
                description=_description_for(spec.key),
                role_required=role_by_key.get(spec.key, spec.role_required),
                status="blocked" if spec.depends_on else "todo",
                assignee_member_id=None,
                depends_on=[key_to_id[key] for key in spec.depends_on],
                is_gate=spec.is_gate,
                reviews_task_id=key_to_id[spec.reviews] if spec.reviews else None,
                acceptance_criteria=_acceptance_for(spec.key, spec.acceptance_criteria),
            )
            for spec in template.tasks
        ]
        project = CrewProject(
            id=project_id,
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            goal_text=SHOWCASE_GOAL,
            sop_template_id=SHOWCASE_TEMPLATE_ID,
            status="active",
            source="showcase",
            showcase={
                "scenario_id": showcase.scenario_id,
                "version": showcase.version,
                "locale": showcase.locale,
                "mode": "deterministic",
            },
            tasks=tasks,
            audit_events=[
                _audit(project_id, "crew.project.created", {"template_id": SHOWCASE_TEMPLATE_ID, "source": "showcase"}),
                _audit(project_id, "crew.showcase.seeded", {"scenario_id": showcase.scenario_id, "version": showcase.version, "source": "showcase"}),
            ],
        )
        by_key = {task.key: task for task in project.tasks}
        scribe = _member_by_role(members, "文案") or owner_user_id
        designer = _member_by_role(members, "设计") or owner_user_id
        engineer = _member_by_role(members, "工程") or owner_user_id
        checker = _member_by_role(members, "验收") or owner_user_id

        _finish(by_key["brief"], owner_user_id, _artifact_meeting_notes(), _ts(2))
        _finish(by_key["prd"], scribe, _artifact_action_items_v1(), _ts(4))
        by_key["prd"].status = "rework"
        by_key["prd"].review_comment = "v1 只有事项，没有 DRI、截止时间、验收标准和依赖说明。"
        by_key["prd"].artifact_versions.append(
            ArtifactVersion(version=2, content=_artifact_action_items_v2(), submitted_at=_ts(7))
        )
        by_key["prd"].artifact = _artifact_action_items_v2()
        by_key["prd"].status = "done"
        by_key["prd_review"].status = "done"
        by_key["prd_review"].review_comment = "v2 已补齐每个行动项的 DRI、截止时间、验收标准和下游依赖。"
        _submit(by_key["design"], designer, _artifact_board_draft(), _ts(10))
        _finish(by_key["tech_research"], engineer, _artifact_metric_definition_check(), _ts(11))
        by_key["design_review"].status = "todo"
        by_key["build"].assignee_member_id = engineer
        by_key["build"].status = "blocked"
        by_key["code_review"].assignee_member_id = checker
        by_key["code_review"].status = "blocked"
        by_key["accept"].assignee_member_id = owner_user_id
        by_key["accept"].status = "blocked"
        return project

    def _messages(self, project: CrewProject) -> list[ChannelMessage]:
        by_key = {task.key: task for task in project.tasks}
        return [
            _msg(project, 1, "event", "Anna 已导入周会行动项闭环案例：原始纪要、行动项返工、协作看板、数据核对与下游同步都在同一张工作图里。"),
            _msg(project, 2, "artifact", "“周会原始纪要”已归档：议题、模糊行动项、不可伪造规则和交付物已明确。", task_id=by_key["brief"].id),
            _msg(project, 3, "artifact", "“行动项清单”v1 已提交，评审指出缺少 DRI、截止时间、验收标准和依赖说明。", task_id=by_key["prd"].id),
            _msg(project, 4, "event", "“行动项评审”驳回：v1 只有事项，没有办法让人负责、追踪或验收。", task_id=by_key["prd_review"].id),
            _msg(project, 5, "artifact", "“行动项清单”v2 已补齐：每项都有 DRI、截止时间、验收标准、依赖和同步对象。", task_id=by_key["prd"].id),
            _msg(project, 6, "event", "“行动项评审”通过，协作看板草图与数据口径核对并行解锁。", task_id=by_key["prd_review"].id),
            _msg(project, 7, "artifact", "“协作看板草图”已提交：待核对、进行中、待评审三列和每项阻塞原因已标清。", task_id=by_key["design"].id),
            _msg(project, 8, "artifact", "“数据口径核对”已归档：漏斗指标分母、时间窗、负责人和下次更新时间齐备。", task_id=by_key["tech_research"].id),
            _msg(project, 9, "review", "“纪要发布评审”待评审 · 对象 · 协作看板草图 v1。下游“同步到看板与群公告”保持阻塞，直到负责人确认纪要可发布。", task_id=by_key["design_review"].id),
            _command_msg(project, 10),
        ]


def _member_by_role(members: list[Account], role: str) -> str | None:
    for member in members:
        if member.role == role and member.kind == "agent":
            return member.id
    for member in members:
        if member.role == role:
            return member.id
    return None


def _finish(task: CrewTask, assignee: str, artifact: str, submitted_at: str) -> None:
    task.assignee_member_id = assignee
    task.status = "done"
    task.artifact_versions = [ArtifactVersion(version=1, content=artifact, submitted_at=submitted_at)]
    task.artifact = artifact


def _submit(task: CrewTask, assignee: str, artifact: str, submitted_at: str) -> None:
    task.assignee_member_id = assignee
    task.status = "submitted"
    task.artifact_versions = [ArtifactVersion(version=1, content=artifact, submitted_at=submitted_at)]
    task.artifact = artifact


def _msg(
    project: CrewProject,
    seq: int,
    kind: Literal["event", "artifact", "review", "say", "command"],
    body: str,
    *,
    task_id: str | None = None,
    payload: dict | None = None,
) -> ChannelMessage:
    msg_payload = {"source": "showcase", "scenario_id": SHOWCASE_SCENARIO_ID, "version": SHOWCASE_VERSION, "mode": "deterministic"}
    if payload:
        msg_payload.update(payload)
    return ChannelMessage(
        id=f"{project.id}:showcase:m{seq:03d}",
        project_id=project.id,
        workspace_id=project.workspace_id,
        seq=seq,
        author_kind="anna",
        author_member_id=None,
        kind=kind,
        body=body,
        task_id=task_id,
        run_ref=None,
        mentions=[],
        audit_ref="#a2",
        payload=msg_payload,
        created_at=_ts(seq),
    )


def _command_msg(project: CrewProject, seq: int) -> ChannelMessage:
    draft = TaskDraft(
        title="补齐下周二 10:00 自动追踪提醒",
        role="产品",
        depends_on=["纪要发布评审"],
        acceptance="每个行动项包含提醒时间、负责人、验收标准和逾期升级人。",
    )
    return _msg(
        project,
        seq,
        "command",
        "Anna 已准备一个可选协调提案：为未完成行动项补齐下周二 10:00 自动追踪提醒。确认前不会进入工作图。",
        payload={"origin": "anna_coordination", "drafts": [draft.model_dump(mode="json")], "coordination_actor_id": "anna"},
    )


def _audit(project_id: str, event_type: str, payload: dict) -> dict:
    return {"type": event_type, "run_id": project_id, "payload": payload, "created_at": _ts(0)}


def _ts(minute: int) -> str:
    return f"2026-08-16T01:{minute:02d}:00+00:00"


def _description_for(key: str) -> str:
    return {
        "brief": "归档周会原始信息、模糊行动项和不可伪造规则。",
        "prd": "从纪要抽取行动项，并经过一次驳回返工链。",
        "prd_review": "评审行动项是否具备 DRI、截止时间、验收标准和依赖。",
        "design": "把行动项转成可扫读的协作看板草图。",
        "tech_research": "核对漏斗指标口径、分母、时间窗和数据负责人。",
        "design_review": "当前等待负责人确认的纪要发布评审门。",
        "build": "将确认后的行动项同步到看板和团队群公告。",
        "code_review": "验收看板、群公告、提醒和逾期升级规则。",
        "accept": "沉淀下周复盘项，确保闭环可以追踪。",
    }.get(key, "")


def _acceptance_for(key: str, fallback: str | None) -> str | None:
    return {
        "brief": "议题、原始纪要、模糊行动项和不可伪造规则齐备。",
        "prd": "每个行动项都有 DRI、截止时间、验收标准、依赖和同步对象。",
        "prd_review": "v2 必须补齐责任、时间、验收和依赖，不能只是会议摘要。",
        "design": "看板草图覆盖待核对、进行中、待评审三列和阻塞原因。",
        "tech_research": "数据核对包含指标分母、时间窗、负责人和下一次更新时间。",
        "design_review": "纪要可发布，且不会把未确认口径当成事实。",
        "build": "看板和群公告都包含同一组行动项、负责人和截止时间。",
        "code_review": "验收必须确认看板、公告、提醒、逾期升级规则都存在。",
        "accept": "下周复盘项归档，且没有伪造模型、工具、token 或 execution 成功。",
    }.get(key, fallback)


def _artifact_meeting_notes() -> str:
    return "# 周会原始纪要\n\n- 背景：周一增长例会后，Slack、飞书里留下了多条模糊行动项。\n- 原始记录：漏斗激活率下降要查；客户培训材料要补；账单权限口径下周前要统一。\n- 目标：30 分钟内形成可追踪行动项、协作看板、数据口径核对和纪要发布评审。\n- 边界：示例可以预置事实，但不能伪造模型输出、工具执行、token 或 execution 成功。\n"


def _artifact_action_items_v1() -> str:
    return "# 行动项清单 v1\n\n- 查漏斗激活率下降。\n- 补客户培训材料。\n- 统一账单权限口径。\n\n缺口：没有 DRI、截止时间、验收标准、依赖和同步对象。\n"


def _artifact_action_items_v2() -> str:
    return "# 行动项清单 v2\n\n| 行动项 | DRI | 截止时间 | 验收标准 | 依赖 |\n| --- | --- | --- | --- | --- |\n| 核对激活率下降 | Andy | 周二 18:00 | 给出分母、时间窗和下降原因 | 数据口径核对 |\n| 补客户培训材料 | Agent·Scribe | 周三 12:00 | 覆盖 Top 3 问题和新版截图 | 行动项评审通过 |\n| 统一账单权限口径 | Boss | 周二 16:00 | 列出 5 个关键账号的权限口径 | Andy 核对角色配置 |\n\n本示例不伪造模型、工具、token 或 execution 成功。\n"


def _artifact_board_draft() -> str:
    return "# 协作看板草图\n\n1. 待核对：激活率分母、账单权限角色配置。\n2. 进行中：客户培训材料补充。\n3. 待评审：纪要发布前确认行动项是否完整。\n4. 阻塞原因：下游同步必须等纪要发布评审通过。\n5. 提醒规则：下周二 10:00 对未完成项触发追踪。\n"


def _artifact_metric_definition_check() -> str:
    return "# 数据口径核对\n\n1. 激活率口径：新用户 7 日内完成首个项目创建。\n2. 分母：8 月第 2 周新增团队，排除测试空间。\n3. 现象：示例数据中激活率从 42% 降到 31%。\n4. 待确认：是否由新培训材料缺口导致首个项目创建失败。\n5. 下一次更新时间：周二 18:00，由 Andy 同步。\n"
