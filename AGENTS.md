# Shared Agent Instructions

Shared durable context for Codex, Claude Code, and future coding agents lives in:

```text
/Users/chris/.agents
```

Use this directory for runbooks, environment notes, conventions, inventories, handoff context, and shared workflow source. Agent-specific directories such as `/Users/chris/.codex` should contain runtime state, installed app machinery, or compatibility symlinks only.

At the start of a task, check this file first, then open the relevant shared memory, runbook, convention, or skill under `/Users/chris/.agents` before relying on agent-specific state.

## Required Defaults

- Store canonical durable context under `/Users/chris/.agents`.
- Keep private keys, passwords, tokens, recovery codes, and secret values out of this directory.
- Reference credentials by 1Password item name, Vault path, or purpose only.
- Prefer practical runbooks and concise memory over transcript-style notes.
- When an agent-specific path still matters, leave a pointer or symlink back to `/Users/chris/.agents`.

## Important Starting Points

- SSH and 1Password: `/Users/chris/.agents/runbooks/ssh-1password.md`
- Agent credential access: `/Users/chris/.agents/runbooks/agent-credentials.md`
- GitHub push fallback with 1Password PAT: `/Users/chris/.agents/runbooks/github-push.md`
- Secret handling default: `/Users/chris/.agents/conventions/secret-management.md`
- Cross-session memory: `/Users/chris/.agents/memories/MEMORY.md`
- Per-project agent memories: `/Users/chris/.agents/memories/projects/` (see its `README.md`)
- Shared skills: `/Users/chris/.agents/skills`
- Migration audits: `/Users/chris/.agents/inventories/codex-migration.md`, `/Users/chris/.agents/inventories/claude-migration.md`
- Claude Code integration: `/Users/chris/.agents/conventions/claude-integration.md`
