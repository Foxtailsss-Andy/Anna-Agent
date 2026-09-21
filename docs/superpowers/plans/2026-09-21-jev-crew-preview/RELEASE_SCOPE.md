# Release scope amendment · 2026-09-22

The user authorized a focused GitHub source-preview release, including the PR, merge to main, bilingual homepage and Release, after necessary checks. This amendment takes precedence over the earlier JEV-03 release prerequisites; product safety and data/label constraints remain unchanged.

- Primary comparison: A (real role rules), C (the configured DeepSeek model, one constrained JSON decision, no tools or loop), D (the production Jev adapter through its protected Host endpoint).
- Freeze the same semantic fields, candidate order, versions and parameters before the final round. Use the original 24 heldout cases once as the main quality sample; report the 8 development cases separately. Never relabel or tune against heldout output.
- B (the previous complete Crew matcher/Host/OMP path) is optional representative evidence. Its absence must be stated, and C must never be presented as measured latency/cost of that earlier product path. New B budget infrastructure and new Worker demo work are not release prerequisites.
- Report requested/returned model IDs, actual reasoning settings, sample and eligibility counts, correct/wrong/abstained/error/not-run denominators, latency p50/p95 at a consistent measurement boundary, actual usage or null, estimated cost with dated price assumptions, and D versus C percentage changes. Include quality and cost together; no production-accuracy or full-workflow speedup claim.
- Keep explicit adoption, atomic receipt/revalidation, cancellation, no automatic fallback, and existing permissions/Worker policy. Prior AC15 evidence remains separate from real Worker terminal evidence.
- Reuse completed checks where their source hashes remain unchanged; rerun affected gates. Perform one final independent Standards/Spec review. Fix blockers; record non-blocking recommendations.
- Preserve original logs, local capsules and private Git history outside the public tree. Publish portable guidance, synthetic fixtures, sanitized JSON and check summaries without weakening the public boundary gate.
- Publish only the reviewed candidate. Record the PR and Release and verify actual CI on the final main commit. No force push.

Original SPEC contract SHA256: `abf20417288899f17358800e39d61e30a95d8b56396013cbf5549eeae8f9f91d`. Original ACCEPTANCE SHA256: `3802f461e3a909f4b6eb3bebd2b64d9014d304ba696363299d646e8af078c7f6`. The originals are archived; public copies only replace local paths. The 8/24 fixture bytes and labels are unchanged. See [publication provenance](../../../../evals/jev-crew/publication-provenance.json).
