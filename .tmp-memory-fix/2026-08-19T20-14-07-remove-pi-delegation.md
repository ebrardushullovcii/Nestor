# Memory update: remove Pi delegation, use delegate-native-work with same model

User explicitly requested removal of all Pi references and economical Pi-first delegation.

Instructions for memory consolidation:
- DELETE from C:\Users\ebrar\.codex\memories\MEMORY.md and memory_summary.md:
  - Line 'For economical delegation, let Codex choose worker count, model, and least-privilege read/write access; prefer Pi for bounded checkable work...'
  - Line 'Prefer delegate-to-pi for bounded, separable, checkable work; require agent_end and stopReason: stop, redact credentials, and use independent Windows shell calls rather than nested Start-Job. Keep opencode2 beside v1 as fallback...'
  - Entire section '# Task Group: Pi-first economical subagent delegation with OpenCode fallback' and its Tasks 1-3, including Pi 0.84.1, opencode-go/deepseek-v4-flash, delegate-to-pi, invoke-pi-worker.ps1, RPC, agent_end, guard blocks, and related learnings
  - Any other 'Pi-first', 'delegate-to-pi', 'prefer Pi' phrases
- REPLACE WITH:
  - 'For delegation, use the global $delegate-native-work skill. Set every subagent model and reasoning effort explicitly to the SAME model as the orchestrator (currently muse spark 1.2 contributor). Do not rely on inheritance. Scale delegation to useful independent work and available capacity. Orchestrator independently verifies, merges, deduplicates, and QAs subagent output. Keep opencode2 beside v1 only when explicitly needed for OpenCode-only HTTP/API, ACP/MCP, snapshots, or built-in-agent features - not as a default economical preference.'

Reason: User moved to delegate-native-work with same-model Spark 1.2 subagents; wants Pi references gone permanently. Requested 2026-08-19.
