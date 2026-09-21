# Jev Crew Preview: portable launch guide

Run from the repository root. See [DEVELOPMENT](../../../../DEVELOPMENT.md#optional-jev-crew-suggestions) for installation, model configuration and state isolation.

- `ANNA_JEV_ENABLED=1` opts in to explicit single-task suggestions.
- `ANNA_JEV_API_KEY_FILE` points to a protected UTF-8 TypeSafe key file, outside the checkout and Agent-readable workdirs. Use file mode 0600 and parent mode 0700.
- `ANNA_HARNESS_HOST_CONFIG_PATH` points to the separately protected generation-model configuration. Jev suggestions do not require that model; the C comparison and Worker execution do.
- Keep the evaluation ledger and raw output in a private local state directory. Continue the same ledger across runs; never reset a used ledger to regain budget.
- Use synthetic data. Preserve the frozen development/heldout fixtures and labels. See [release scope](RELEASE_SCOPE.md) for the final A/C/D comparison and publication requirements.

The original machine-specific launch capsule, execution logs and private commit history are preserved in the operator archive. This public guide contains no machine path or secret. Credential values must never appear in commands, task prompts, browser state or published evidence.
