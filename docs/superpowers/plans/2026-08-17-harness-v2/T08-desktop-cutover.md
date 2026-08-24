# T08 · Desktop cutover and legacy deletion

## Depends on

T07 release gate.

## Goal

Expose the accepted Harness v2 surface in Electron and remove its replaced Python execution path.

## Scope

- spawn/supervise the local Harness v2 service from Electron;
- runtime health, restart and failure UI;
- Channel event/Trace cursor integration;
- clear local-preview limitations;
- differential test against frozen behavior contract;
- remove replaced Python model/loop/registry/trace code for the migrated surface.

## Red tests

1. desktop cannot report ready before Harness v2 health;
2. service crash is visible and restartable;
3. stale runtime-info cannot attach to another instance;
4. Channel isolation holds through UI/API;
5. legacy and v2 execution cannot both run for the migrated surface;
6. packaged macOS smoke passes with the Node service included.

## Acceptance

- local developer preview starts from one documented command;
- accepted scenario is reproducible from the desktop;
- source package contains no secrets or local state;
- deleted legacy modules have no remaining imports or fallback configuration;
- release notes state that app-closed cross-day execution is not supported.
