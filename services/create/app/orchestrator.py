from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from services.create.app.sandbox import CreateToolSandbox
from services.runtime.app.event_stream import AuditFrameWatermark
from services.create.app.schemas import (
    CreateActivationEligibility,
    CreateArtifact,
    CreateDraftRun,
    CreateValidationResult,
)
from services.reimbursement.app.audit import AuditService
from services.runtime.app.base_orchestrator import BaseOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.create_tool_registry import (
    REGISTERED_MODEL_VISIBLE_TOOLS,
    CreateToolRegistry,
)
from services.runtime.app.model_provider import ModelRequest
from services.runtime.app.run_store import RunStore
from services.runtime.app.skill_loader import SkillLoader, SkillLoaderError
from services.runtime.app.workdir_store import (
    resolve_valid_workdir,
    workdir_system_context,
)


logger = logging.getLogger(__name__)

# L2:create run 落库的 surface 维度键(run_store 一张表按 surface 区分)。
_CREATE_SURFACE = "create"


def _create_run_creation_order_key(run: CreateDraftRun) -> tuple[str, str]:
    """Stable creation-order key: first audit event timestamp, then run id.

    A run's first audit event is ``create.<kind>.run.created`` (or
    ``create.failed`` for an invalid kind) — appended once at creation and never
    mutated — so its monotonic ``created_at`` is the run's creation instant; the
    run id breaks a same-microsecond tie. Orders merged registry+store lists.
    """
    created_at = run.audit_events[0].created_at if run.audit_events else ""
    return (created_at, run.id)


def _rehydrate_run(payload: dict[str, Any]) -> CreateDraftRun | None:
    """Validate one persisted payload into a CreateDraftRun, or ``None`` if corrupt.

    A store row whose JSON no longer matches the current ``CreateDraftRun`` schema
    (schema drift or a truncated write) must NOT sink an otherwise-recoverable
    lookup or list — mirrors ``run_store.list_frames``' per-row skip. Logged,
    skipped: a get treats the corrupt row as absent, a list keeps every healthy
    sibling.
    """
    try:
        return CreateDraftRun.model_validate(payload)
    except Exception:  # noqa: BLE001 — one corrupt row must never sink the rest
        run_id = payload.get("id") if isinstance(payload, dict) else None
        logger.warning("skipping corrupt create run payload id=%s", run_id, exc_info=True)
        return None


class CreateRunNotFoundError(Exception):
    pass


class CreateOrchestrator(BaseOrchestrator):
    _fail_event_type = "create.failed"
    _run_id_prefix = "create_run_"

    def __init__(
        self,
        tool_registry: CreateToolRegistry | None = None,
        skill_loader: SkillLoader | None = None,
        audit: AuditService | None = None,
        settings: RuntimeSettings | None = None,
        project_root: Path | None = None,
        workspace_root: Path | None = None,
        engine: QueryEngine | None = None,
        run_store: RunStore | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self.project_root = (project_root or Path.cwd()).resolve()
        self.workspace_root = (
            workspace_root
            or Path(self.settings.create_workspace_root or self.project_root / ".anna" / "create-runs")
        ).resolve()
        self.tool_registry = tool_registry or CreateToolRegistry()
        self.skill_loader = skill_loader or SkillLoader(project_root=self.project_root)
        self.sandbox = CreateToolSandbox(self.workspace_root)
        self.audit = audit or AuditService()
        # Create is a SINGLE structured-output model call, not a ReAct loop: the
        # model emits exactly one create.emit_*_draft tool call that IS the
        # draft, then the orchestrator does deterministic post-processing. It
        # drives the engine's single-call primitive (run_single_call), never the
        # AgentLoop — max_turns=1 through the loop would dispatch the emit tool
        # then exhaust, wrongly failing a good draft.
        self.engine = engine or QueryEngine(self.settings)
        # L2 Run 持久化 (P2 状态外置):可选 run store(与 chat 同一张表,surface
        # 区分)。None → 纯内存(注入编排器的既有单测行为不变);有值 → 创建即写、
        # 终态即写,list/get 内存 miss 落库查。create 无会话线程,thread_id 恒 None。
        self._run_store = run_store
        # Seed the run-id counter from the store so ids keep climbing across a
        # restart (a cold counter would re-mint create_run_001 and UPSERT over a
        # persisted run).
        self._run_counter = (
            run_store.max_run_sequence(_CREATE_SURFACE, self._run_id_prefix)
            if run_store is not None
            else 0
        )
        self._runs: dict[str, CreateDraftRun] = {}

    def _fail_run(self, run: Any, error_code: str, message: str) -> Any:
        """Fail the run (shared bookkeeping) then write-through the terminal.

        Overrides ``BaseOrchestrator._fail_run`` so every failure path — invalid
        kind, model errors, draft-not-emitted, validation, fixture, save guards —
        persists its terminal ``failed`` state from one place. The success
        terminals (ready_for_review / saved) persist explicitly.
        """
        result = super()._fail_run(run, error_code, message)
        self._persist_run(result)
        return result

    def _persist_run(self, run: CreateDraftRun) -> None:
        """Write-through one draft run; a store failure never breaks the run.

        Honest degradation: on a persistence error the run still lives in the
        in-memory registry and is returned to the caller — log and swallow.
        create has no conversation thread, so ``thread_id`` is always None.
        """
        if self._run_store is None:
            return
        try:
            self._run_store.save_run(
                surface=_CREATE_SURFACE,
                run_id=run.id,
                thread_id=None,
                workspace_id=run.workspace_id,
                actor_user_id=run.actor_user_id,
                status=run.status,
                created_at=(
                    run.audit_events[0].created_at if run.audit_events else ""
                ),
                payload=run.model_dump(mode="json"),
            )
        except Exception:  # noqa: BLE001 — persistence must not break a live run
            logger.warning("create run %s failed to persist", run.id, exc_info=True)

    def _begin_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        prompt: str,
        kind: str,
        agent_id: str | None = None,
        workdir_id: str | None = None,
        permission_mode: Literal["ask", "bypass"] = "ask",
    ) -> tuple[CreateDraftRun, CreateDraftRun | None]:
        """Create + register a run; returns ``(run, failed_run)``(kind 非法即失败)。"""
        if kind not in {"skill", "prompt", "python_tool"}:
            run = CreateDraftRun(
                id=self._next_run_id(),
                workspace_id=workspace_id,
                actor_user_id=actor_user_id,
                prompt=prompt,
                kind="skill",
                agent_id=agent_id,
                workdir_id=workdir_id,
                permission_mode=permission_mode,
                status="generating",
            )
            self._runs[run.id] = run
            failed = self._fail_run(
                run,
                "create_kind_invalid",
                "Create kind must be skill, prompt, or python_tool",
            )
            return run, failed
        run = CreateDraftRun(
            id=self._next_run_id(),
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            prompt=prompt,
            kind=kind,
            agent_id=agent_id,
            workdir_id=workdir_id,
            permission_mode=permission_mode,
            status="generating",
        )
        self._runs[run.id] = run
        self.audit.append(
            run.audit_events,
            f"create.{kind}.run.created",
            run.id,
            {
                "prompt_hash": self._hash_payload({"prompt": prompt}),
                "agent_id": agent_id,
                "workdir_id": workdir_id,
                # B3:审批档真存真审计;拦截随写工具/Code 模式点亮(本轮无受门动作)。
                "permission_mode": permission_mode,
            },
        )
        # L2 write-through: persist at creation (status "generating") so a run
        # whose process dies mid-build is recorded — the startup sweep heals it
        # to "interrupted" rather than losing it silently.
        self._persist_run(run)
        return run, None

    def create_draft(
        self,
        workspace_id: str,
        actor_user_id: str,
        prompt: str,
        kind: str = "skill",
        agent_id: str | None = None,
        workdir_id: str | None = None,
        permission_mode: Literal["ask", "bypass"] = "ask",
    ) -> CreateDraftRun:
        run, failed = self._begin_run(
            workspace_id, actor_user_id, prompt, kind, agent_id,
            workdir_id=workdir_id, permission_mode=permission_mode,
        )
        if failed is not None:
            return failed
        return self._advance_run(run)

    async def stream_draft(
        self,
        workspace_id: str,
        actor_user_id: str,
        prompt: str,
        kind: str = "skill",
        agent_id: str | None = None,
        workdir_id: str | None = None,
        permission_mode: Literal["ask", "bypass"] = "ask",
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream a Create draft build, yielding chat-shape wire frames(B1)。

        Create 是单次结构化输出调用 + 确定性后处理(见 __init__ 注释),不走 AgentLoop;
        流式化 = 把阻塞的 ``_advance_run`` 放工作线程,主协程按审计水位直播真事件:
        * ``{"type": "step", ...}`` — 阶段边界的权威过程帧(analyze → deliver),
          intent 为代码生成中文(ADR-002,非模型文本);
        * ``{"type": "event", "event": <AuditEvent>}`` — create.run.created /
          model.call.* / create.*.generated / validated / fixture_ran 等真审计;
        * 终帧 ``done`` / ``error``(chat 同形:error 带 run,前端读 error_code/message)。
        """
        run, failed = self._begin_run(
            workspace_id, actor_user_id, prompt, kind, agent_id,
            workdir_id=workdir_id, permission_mode=permission_mode,
        )
        watermark = AuditFrameWatermark(run.audit_events)
        if failed is not None:
            for frame in watermark.new_frames():
                yield frame
            yield {"type": "error", "run": failed}
            return
        for frame in watermark.new_frames():
            yield frame
        yield {
            "type": "step",
            "phase": "analyze",
            "intent": "正在理解构建诉求，准备生成草稿",
            "tool": None,
            "turn": 1,
        }
        deliver_step = {
            "type": "step",
            "phase": "deliver",
            "intent": "草稿已写入，正在校验产出",
            "tool": None,
            "turn": 1,
        }
        task = asyncio.create_task(asyncio.to_thread(self._advance_run, run))
        deliver_emitted = False
        try:
            while not task.done():
                for frame in watermark.new_frames():
                    yield frame
                    if not deliver_emitted and _is_generated_event(frame):
                        deliver_emitted = True
                        yield deliver_step
                await asyncio.wait({task}, timeout=0.25)
            final_run = task.result()
        except Exception as exc:  # noqa: BLE001 — 意外异常如实收敛为失败 run
            final_run = self._fail_run(run, "create_stream_failed", str(exc))
        for frame in watermark.new_frames():
            yield frame
            if not deliver_emitted and _is_generated_event(frame):
                deliver_emitted = True
                yield deliver_step
        if final_run.status == "failed":
            yield {"type": "error", "run": final_run}
        else:
            yield {"type": "done", "run": final_run}

    def create_skill_draft(
        self,
        workspace_id: str,
        actor_user_id: str,
        prompt: str,
    ) -> CreateDraftRun:
        return self.create_draft(
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            prompt=prompt,
            kind="skill",
        )

    def _advance_run(self, run: CreateDraftRun) -> CreateDraftRun:
        request = self._build_model_request(run)
        result = self.engine.run_single_call(
            request,
            run.id,
            run.audit_events,
            config_error_message=(
                "model endpoint and API key are required before running Anna Create"
            ),
        )
        if result.error_code is not None:
            # run_single_call always sets a concrete error_code on failure — no fallback needed
            return self._fail_run(run, result.error_code, result.message or "")
        expected_tool_name = _create_tool_name(run.kind)
        draft_call = next(
            (
                tool_call
                for tool_call in result.tool_calls
                if tool_call.name == expected_tool_name
            ),
            None,
        )
        if draft_call is None:
            return self._fail_run(
                run,
                f"{run.kind}_draft_not_emitted",
                f"Create model must emit {expected_tool_name}",
            )

        try:
            if run.kind == "skill":
                self._write_skill_draft(run, draft_call.arguments)
            elif run.kind == "prompt":
                self._write_prompt_draft(run, draft_call.arguments)
            else:
                self._write_python_tool_draft(run, draft_call.arguments)
        except ValueError as exc:
            return self._fail_run(run, f"{run.kind}_draft_invalid", str(exc))
        self.audit.append(
            run.audit_events,
            f"create.{run.kind}.generated",
            run.id,
            {
                "skill_id": run.artifact.skill_id if run.artifact else None,
                "prompt_id": run.artifact.prompt_id if run.artifact else None,
                "tool_id": run.artifact.tool_id if run.artifact else None,
                "artifact_path_hash": self._hash_payload(
                    {"path": run.artifact.path if run.artifact else ""}
                ),
            },
        )
        if run.kind == "skill":
            self._validate_skill_draft(run)
        elif run.kind == "prompt":
            self._validate_prompt_draft(run)
        else:
            self._run_python_tool_fixture(run, draft_call.arguments)
        # L2 write-through: terminal after validation/fixture — "ready_for_review"
        # on success, or a "failed" already persisted by the _fail_run override
        # inside the validators (re-persisting the same terminal is idempotent).
        self._persist_run(run)
        return run

    def save_skill(self, run_id: str, confirmed_by: str) -> CreateDraftRun:
        run = self._runs[run_id]
        if run.status != "ready_for_review" or run.artifact is None or not run.artifact.skill_id:
            return self._fail_run(
                run,
                "skill_not_ready_for_save",
                "skill draft must be ready for review before saving",
            )
        source = Path(run.artifact.path)
        target = (self.project_root / "skills" / run.artifact.skill_id / "SKILL.md").resolve()
        try:
            target.relative_to((self.project_root / "skills").resolve())
        except ValueError:
            return self._fail_run(
                run,
                "skill_path_invalid",
                "skill save path must stay inside the skills directory",
            )
        if target.exists():
            return self._fail_run(
                run,
                "skill_already_exists",
                "a live Skill already exists at this id; replacement requires a separate review path",
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        run.status = "saved"
        self.audit.append(
            run.audit_events,
            "create.skill.saved",
            run.id,
            {
                "skill_id": run.artifact.skill_id,
                "confirmed_by": confirmed_by,
            },
        )
        self._persist_run(run)  # L2 write-through: "saved" terminal
        return run

    def activate_artifact(self, run_id: str, confirmed_by: str) -> CreateDraftRun:
        run = self._runs[run_id]
        if run.artifact is None:
            return self._fail_run(
                run,
                "artifact_not_ready_for_activation",
                "Create draft artifact must exist before activation",
            )
        if run.kind == "skill":
            return self.save_skill(run_id, confirmed_by=confirmed_by)
        if run.kind == "prompt":
            return self._save_prompt(run, confirmed_by=confirmed_by)
        if run.activation_eligibility is None:
            run.activation_eligibility = _python_tool_activation_eligibility(
                run.sandbox_result.passed if run.sandbox_result else False
            )
        return self._fail_run(
            run,
            "python_tool_activation_blocked",
            (
                "Python tool activation requires a hardened sandbox and activation "
                "review path; the current fixture runner is review-only"
            ),
        )

    def _save_prompt(self, run: CreateDraftRun, confirmed_by: str) -> CreateDraftRun:
        if run.status != "ready_for_review" or run.artifact is None or not run.artifact.prompt_id:
            return self._fail_run(
                run,
                "prompt_not_ready_for_save",
                "prompt draft must be ready for review before saving",
            )
        source = Path(run.artifact.path)
        prompts_root = (self.project_root / "prompts").resolve()
        target = (prompts_root / f"{run.artifact.prompt_id}.md").resolve()
        try:
            target.relative_to(prompts_root)
        except ValueError:
            return self._fail_run(
                run,
                "prompt_path_invalid",
                "prompt save path must stay inside the prompts directory",
            )
        if target.exists():
            return self._fail_run(
                run,
                "prompt_already_exists",
                "a live Prompt already exists at this id; replacement requires a separate review path",
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        run.status = "saved"
        self.audit.append(
            run.audit_events,
            "create.prompt.saved",
            run.id,
            {
                "prompt_id": run.artifact.prompt_id,
                "confirmed_by": confirmed_by,
            },
        )
        self._persist_run(run)  # L2 write-through: "saved" terminal
        return run

    def get_run(self, run_id: str) -> CreateDraftRun:
        # L2 read fallback: in-memory registry first (live, authoritative), then
        # the run store on a miss (survives a restart). Registry wins on match.
        run = self._runs.get(run_id)
        if run is not None:
            return run
        if self._run_store is not None:
            payload = self._run_store.get_run(_CREATE_SURFACE, run_id)
            if payload is not None:
                run = _rehydrate_run(payload)
                if run is not None:
                    return run  # a corrupt row falls through to not-found
        raise CreateRunNotFoundError(run_id)

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[CreateDraftRun]:
        """Create runs for one (workspace, actor), NEWEST-FIRST.

        `self._runs` is a dict written exactly once per run.id in creation
        order, so `reversed(...)` yields newest-first. The Artifact Center
        frontend relies on this ordering to keep the newest run per artifact
        key when de-duplicating (see artifactModel.toArtifactCards).

        L2: when a run store is wired, its rows are merged in — de-duped by run
        id with the in-memory version winning — and the result re-sorted into
        newest-first creation order, so restart-restored runs keep the ordering
        the Artifact Center relies on.
        """
        registry_runs = [
            run
            for run in reversed(list(self._runs.values()))
            if run.workspace_id == workspace_id and run.actor_user_id == actor_user_id
        ]
        if self._run_store is None:
            return registry_runs
        seen = {run.id for run in registry_runs}
        merged = list(registry_runs)
        for payload in self._run_store.list_runs(
            _CREATE_SURFACE, workspace_id, actor_user_id
        ):
            if payload.get("id") in seen:
                continue
            seen.add(payload.get("id"))
            run = _rehydrate_run(payload)
            if run is not None:
                merged.append(run)  # skip a corrupt row, keep the rest
        merged.sort(key=_create_run_creation_order_key, reverse=True)
        return merged

    def _build_model_request(self, run: CreateDraftRun) -> ModelRequest:
        system_content = (
            "You are Anna Create. Generate drafts only through the requested "
            "structured output tool: create.emit_skill_draft, "
            "create.emit_prompt_draft, or create.emit_python_tool_draft. "
            "Do not claim a draft is saved or activated."
        )
        # P3 refinement — Boss 附加指令 (Agent 中心);B1:per-run 专家选择可覆盖。
        create_directive = self.settings.agent_directive(run.agent_id or "create")
        if create_directive:
            system_content += "\n\n[Boss 附加指令]\n" + create_directive
        if run.kind == "skill":
            registered = "\n".join(
                f"- {tool_name}" for tool_name in sorted(REGISTERED_MODEL_VISIBLE_TOOLS)
            )
            system_content += (
                "\n\nWhen emitting a Skill draft, allowed_tools must only contain "
                "tool names from this registered Anna tool list (or stay empty). "
                "Never invent tool names that are not in the list:\n"
                f"{registered}"
            )
        # B2:有效工作空间 → [工作空间] 段追加到 system 末尾(create 单次调用
        # 无工具循环,仅上下文注入,不挂 read 工具);失效 → workdir.missing
        # 审计后照常进行(诚实降级)。
        workdir = self._resolve_run_workdir(run)
        if workdir is not None:
            system_content += "\n\n" + workdir_system_context(workdir)
        return ModelRequest(
            messages=[
                {
                    "role": "system",
                    "content": system_content,
                },
                {
                    "role": "user",
                    "content": f"Requested draft kind: {run.kind}\n\n{run.prompt}",
                },
            ],
            tools=self.tool_registry.model_visible_tools(),
        )

    def _resolve_run_workdir(self, run: CreateDraftRun) -> dict | None:
        """B2:解析 run.workdir_id → ``{id,name,path}``,失效诚实降级。

        注册表 miss 或路径失踪 → ``None`` 并审计 ``workdir.missing``
        (payload={workdir_id}),run 照常进行,绝不 fail。
        """
        if not run.workdir_id:
            return None
        workdir = resolve_valid_workdir(run.workdir_id)
        if workdir is None:
            self.audit.append(
                run.audit_events,
                "workdir.missing",
                run.id,
                {"workdir_id": run.workdir_id},
            )
            return None
        return workdir

    def _write_skill_draft(self, run: CreateDraftRun, arguments: dict[str, Any]) -> None:
        skill_id = _required_text(arguments, "skill_id")
        skill_path = self._draft_skill_path(run.id, skill_id)
        skill_path.parent.mkdir(parents=True, exist_ok=True)
        body = _required_text(arguments, "body")
        content = _skill_markdown(
            name=_required_text(arguments, "name"),
            description=_required_text(arguments, "description"),
            version=_required_text(arguments, "version"),
            allowed_tools=_string_list(arguments.get("allowed_tools")),
            forbidden_tools=_string_list(arguments.get("forbidden_tools")),
            body=body,
        )
        skill_path.write_text(content, encoding="utf-8")
        run.artifact = CreateArtifact(
            kind="skill",
            path=str(skill_path),
            preview=content,
            skill_id=skill_id,
        )

    def _write_prompt_draft(self, run: CreateDraftRun, arguments: dict[str, Any]) -> None:
        prompt_id = _required_text(arguments, "prompt_id")
        prompt_path = self._draft_prompt_path(run.id, prompt_id)
        prompt_path.parent.mkdir(parents=True, exist_ok=True)
        title = _required_text(arguments, "title")
        description = _required_text(arguments, "description")
        body = _required_text(arguments, "body")
        variables = _string_list(arguments.get("variables"))
        content = _prompt_markdown(
            title=title,
            description=description,
            variables=variables,
            body=body,
        )
        prompt_path.write_text(content, encoding="utf-8")
        run.artifact = CreateArtifact(
            kind="prompt",
            path=str(prompt_path),
            preview=content,
            prompt_id=prompt_id,
        )

    def _write_python_tool_draft(self, run: CreateDraftRun, arguments: dict[str, Any]) -> None:
        tool_id = _required_text(arguments, "tool_id")
        tool_path = self._draft_python_tool_path(run.id, tool_id)
        tool_path.parent.mkdir(parents=True, exist_ok=True)
        code = _required_text(arguments, "code")
        _required_text(arguments, "name")
        _required_text(arguments, "description")
        _required_text(arguments, "fixture_input")
        tool_path.write_text(code, encoding="utf-8")
        run.artifact = CreateArtifact(
            kind="python_tool",
            path=str(tool_path),
            preview=code,
            tool_id=tool_id,
        )

    def _validate_skill_draft(self, run: CreateDraftRun) -> None:
        if run.artifact is None or run.artifact.skill_id is None:
            self._fail_run(run, "skill_draft_missing", "skill draft artifact is missing")
            return
        run.status = "validating"
        try:
            loaded = self.skill_loader.load_from_path(
                Path(run.artifact.path),
                run.artifact.skill_id,
            )
        except SkillLoaderError as exc:
            run.validation = CreateValidationResult(
                valid=False,
                errors=[exc.message],
            )
            self.audit.append(
                run.audit_events,
                "create.skill.validated",
                run.id,
                {"valid": False, "error_code": exc.error_code},
            )
            self._fail_run(run, exc.error_code, exc.message)
            return
        unknown_tools = self.tool_registry.unknown_allowed_tools(loaded.allowed_tools)
        dangerous_tools = self.tool_registry.dangerous_allowed_tools(loaded.allowed_tools)
        errors = [*unknown_tools, *dangerous_tools]
        run.validation = CreateValidationResult(
            valid=not errors,
            loaded_skill_id=loaded.id,
            allowed_tools=loaded.allowed_tools,
            forbidden_tools=loaded.forbidden_tools,
            errors=errors,
        )
        self.audit.append(
            run.audit_events,
            "create.skill.validated",
            run.id,
            {"valid": not errors, "skill_id": loaded.id, "error_count": len(errors)},
        )
        if dangerous_tools:
            self._fail_run(
                run,
                "dangerous_tool_allowed",
                "draft Skill cannot expose direct write or execution tools in allowed_tools",
            )
            return
        if errors:
            self._fail_run(
                run,
                "tool_not_registered",
                "draft Skill allowed_tools include tools that are not registered",
            )
            return
        run.status = "ready_for_review"

    def _validate_prompt_draft(self, run: CreateDraftRun) -> None:
        if run.artifact is None:
            self._fail_run(run, "prompt_draft_missing", "prompt draft artifact is missing")
            return
        body = run.artifact.preview.strip()
        errors: list[str] = []
        if not body:
            errors.append("prompt body is empty")
        run.validation = CreateValidationResult(valid=not errors, errors=errors)
        self.audit.append(
            run.audit_events,
            "create.prompt.validated",
            run.id,
            {"valid": not errors, "error_count": len(errors)},
        )
        if errors:
            self._fail_run(run, "prompt_draft_invalid", errors[0])
            return
        run.status = "ready_for_review"

    def _run_python_tool_fixture(
        self,
        run: CreateDraftRun,
        arguments: dict[str, Any],
    ) -> None:
        if run.artifact is None:
            self._fail_run(run, "python_tool_draft_missing", "python tool draft artifact is missing")
            return
        run.sandbox_result = self.sandbox.run_python_tool(
            code=run.artifact.preview,
            fixture_input=_required_text(arguments, "fixture_input"),
        )
        self.audit.append(
            run.audit_events,
            "create.python_tool.fixture_ran",
            run.id,
            {
                "passed": run.sandbox_result.passed,
                "exit_code": run.sandbox_result.exit_code,
            },
        )
        run.activation_eligibility = _python_tool_activation_eligibility(
            run.sandbox_result.passed
        )
        if not run.sandbox_result.passed:
            self._fail_run(
                run,
                "python_tool_fixture_failed",
                "Python tool fixture eval must pass before review",
            )
            return
        run.validation = CreateValidationResult(valid=True)
        run.status = "ready_for_review"

    def _draft_skill_path(self, run_id: str, skill_id: str) -> Path:
        run_root = self._safe_run_root(run_id, "skill")
        skill_path = (run_root / skill_id / "SKILL.md").resolve()
        try:
            skill_path.relative_to(run_root)
        except ValueError as exc:
            raise ValueError("skill_id must stay inside the create run directory") from exc
        return skill_path

    def _draft_prompt_path(self, run_id: str, prompt_id: str) -> Path:
        run_root = self._safe_run_root(run_id, "prompt")
        prompt_path = (run_root / f"{prompt_id}.md").resolve()
        try:
            prompt_path.relative_to(run_root)
        except ValueError as exc:
            raise ValueError("prompt_id must stay inside the create run directory") from exc
        return prompt_path

    def _draft_python_tool_path(self, run_id: str, tool_id: str) -> Path:
        run_root = self._safe_run_root(run_id, "python_tool")
        tool_path = (run_root / f"{tool_id}.py").resolve()
        try:
            tool_path.relative_to(run_root)
        except ValueError as exc:
            raise ValueError("tool_id must stay inside the create run directory") from exc
        return tool_path

    def _safe_run_root(self, run_id: str, draft_kind: str) -> Path:
        workspace_root = self.workspace_root.resolve()
        run_root = workspace_root / run_id / draft_kind
        resolved_run_root = run_root.resolve()
        try:
            resolved_run_root.relative_to(workspace_root)
        except ValueError as exc:
            raise ValueError("create run directory must stay inside the workspace root") from exc
        return resolved_run_root


def _skill_markdown(
    name: str,
    description: str,
    version: str,
    allowed_tools: list[str],
    forbidden_tools: list[str],
    body: str,
) -> str:
    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
        f"version: {version}",
        "owner: Anna Create",
        "domain: generated",
        "allowed_tools:",
    ]
    lines.extend(f"  - {tool_name}" for tool_name in allowed_tools)
    lines.append("forbidden_tools:")
    lines.extend(f"  - {tool_name}" for tool_name in forbidden_tools)
    lines.extend(["---", "", body.strip(), ""])
    return "\n".join(lines)


def _prompt_markdown(
    title: str,
    description: str,
    variables: list[str],
    body: str,
) -> str:
    lines = [
        "---",
        f"title: {title}",
        f"description: {description}",
        "owner: Anna Create",
        "variables:",
    ]
    lines.extend(f"  - {variable}" for variable in variables)
    lines.extend(["---", "", body.strip(), ""])
    return "\n".join(lines)


def _create_tool_name(kind: str) -> str:
    return {
        "skill": "create.emit_skill_draft",
        "prompt": "create.emit_prompt_draft",
        "python_tool": "create.emit_python_tool_draft",
    }[kind]


def _is_generated_event(frame: dict[str, Any]) -> bool:
    """审计帧是否为 create.*.generated(草稿写入,deliver step 的触发点)。"""
    event = frame.get("event")
    event_type = getattr(event, "type", None) or (
        event.get("type") if isinstance(event, dict) else None
    )
    return bool(event_type and str(event_type).endswith(".generated"))


def _python_tool_activation_eligibility(fixture_passed: bool) -> CreateActivationEligibility:
    evidence = [
        "fixture_passed" if fixture_passed else "fixture_failed",
        "ast_preflight_policy_recorded",
        "secret_boundary_enforced",
        "timeout_enforced",
        "output_cap_enforced",
    ]
    blocking_reasons = [
        "hardened_sandbox_required",
        "python_tool_activation_review_required",
        "production_tool_registry_binding_required",
    ]
    if not fixture_passed:
        blocking_reasons = ["fixture_eval_required", *blocking_reasons]
    return CreateActivationEligibility(
        activation_allowed=False,
        safe_for_review=fixture_passed,
        blocking_reasons=blocking_reasons,
        evidence=evidence,
    )


def _required_text(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"skill draft missing {key}")
    return value.strip()


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("skill draft tool fields must be string lists")
    items = [str(item).strip() for item in value if str(item).strip()]
    return items
