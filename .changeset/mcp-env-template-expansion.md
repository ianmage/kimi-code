---
'@moonshot-ai/kimi-code': minor
---

Add environment variable template expansion for MCP server configs: `${VAR}` placeholders in stdio `command`/`args`/`env`/`cwd` and remote `headers` values are resolved from the environment at connection time, so secrets stay out of `mcp.json`.
