---
status: accepted
---

# Local preview before cloud long-running runtime

The first Harness v2 release is a macOS local developer preview whose background service runs with the desktop app. Cross-day execution after the app closes requires a later cloud Runtime; the local preview must not claim that capability before remote scheduling, durable workers and operational governance exist.
