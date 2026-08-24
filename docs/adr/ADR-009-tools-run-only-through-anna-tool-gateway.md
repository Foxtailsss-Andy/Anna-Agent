---
status: accepted
---

# Tools run only through Anna ToolGateway

Pi built-in execution and mutation tools are disabled. Every Tool call passes through Anna ToolGateway for schema validation, channel scope, policy, approval, Sandbox, effect recording and audit; local preview development writes are limited to an approved isolated Git worktree and are never pushed or merged automatically.
