from __future__ import annotations


class ExecutionKernelError(RuntimeError):
    pass


class ExecutionNotFoundError(ExecutionKernelError):
    pass


class IdempotencyConflictError(ExecutionKernelError):
    pass


class ActiveExecutionConflictError(ExecutionKernelError):
    def __init__(self, subject_ref: str, existing_execution_id: str | None = None) -> None:
        self.subject_ref = subject_ref
        self.existing_execution_id = existing_execution_id
        detail = subject_ref
        if existing_execution_id is not None:
            detail = f"{subject_ref}: {existing_execution_id}"
        super().__init__(detail)


class ToolEffectConflictError(ExecutionKernelError):
    pass


class ToolEffectTransitionError(ExecutionKernelError):
    def __init__(self, effect_key: str, from_status: str, to_status: str) -> None:
        self.effect_key = effect_key
        self.from_status = from_status
        self.to_status = to_status
        super().__init__(f"{effect_key}: {from_status} -> {to_status}")


class QueueOverflowError(ExecutionKernelError):
    pass


class TerminalStateError(ExecutionKernelError):
    pass


class FencingError(ExecutionKernelError):
    pass
