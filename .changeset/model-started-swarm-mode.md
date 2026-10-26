---
"@moonshot-ai/kimi-code": minor
---

When a task splits into items that are independent of each other, the model can now call `AgentSwarm` on its own instead of waiting for you to turn swarm mode on; the call turns swarm mode on for that turn, and the mode turns off when the turn ends, while swarm mode you turn on yourself with `/swarm` still stays on. Previously `AgentSwarm` only ran while swarm mode was on and only you could turn it on, so print mode (`kimi -p`) and ACP clients never got subagent swarms unless they pre-enabled the mode. To keep the old behaviour, add a `deny` rule for `AgentSwarm` in the permission settings.
