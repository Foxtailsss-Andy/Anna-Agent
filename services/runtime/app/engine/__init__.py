"""Anna engine layer.

Per ADR-001 ("borrow the engine, not the whole ship"), this package holds the
model-transport pieces adapted from the hermes-agent transport design
(vendor/hermes-agent, MIT) — streaming and error classification — while Anna's
governance layer (tool whitelists, approval, audit, MCP client) stays its own.

This is a pattern adaptation, not a code import: Anna reimplements the minimal
transport behaviour it needs against its own ModelRequest/ModelResponse
contract rather than depending on Hermes at runtime.
"""
