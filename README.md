# pi-claude-hooks

Original ai-configs extension (not vendored). Runs **Claude Code-style `settings.json` hooks**
under the pi coding agent, giving Pi behavior parity with Claude Code for hook-driven guards.

## What it does

Pi's `@vahor/pi-hooks` runner is fire-and-forget — it receives no event payload and **cannot block**
a tool call. The blocking PreToolUse guards (force-push, branch-name, commit-message) therefore had no
Pi equivalent. This extension closes that gap using Pi's **native** `pi.on("tool_call")` event, which
*can* deny a call by returning `{ block: true, reason }`.

It reads hook definitions from the **same source Claude Code uses** — `~/.claude/settings.json`
(plus the project's `.claude/settings.json`, merged after) — so any project that installs hooks there
(e.g. Planet Argon's `pa-dev-skills`) gets them on Pi for free, with no PA-specific coupling.

| Claude hook event | Pi event | Blocks? | Synthesized stdin |
|---|---|---|---|
| `PreToolUse` | `tool_call` | **yes** — exit 2 / `permissionDecision:"deny"` / `decision:"block"` | `{tool_name, tool_input:{command}}` |
| `SessionStart` | `session_start` | no (notifies) | `{hook_event_name, source, cwd}` |
| `UserPromptSubmit` | `input` | no (notifies) | `{prompt, input, cwd}` |
| `Stop` | `turn_end` | no (notifies) | `{hook_event_name, cwd}` |

Hook commands run via `sh -c <command>` with `cwd` and `CLAUDE_PROJECT_DIR` set to the project dir,
exactly as Claude Code runs them. Non-blocking hook stdout is surfaced via `ctx.ui.notify`.

The `memory-session-(start|end).sh` scripts are skipped by default — Pi already runs them through the
`@vahor/pi-hooks` memory wiring (`install_pi_memory_hooks`), so running them here would double-fire the
handoff digest and the session_end observation.

## Plugin hooks

Hooks are not only read from `settings.json` — hooks declared by **enabled Claude Code plugins** are
bridged too, giving full hook parity (e.g. a plugin like `living-docs-enforcer` reaches Pi the same way
a `settings.json` hook does). Resolution works the same way Claude Code resolves it:

1. `enabledPlugins` (`"name@marketplace" -> boolean`) is read from the same settings sources
   (global then project, later overriding earlier) — only keys whose final value is `true` count.
2. Each enabled key is looked up in `~/.claude/plugins/installed_plugins.json` for an install record
   whose `<installPath>/hooks/hooks.json` exists.
3. That plugin's hooks for the current event are appended **after** the `settings.json` hooks.

A plugin hook command may reference `${CLAUDE_PLUGIN_ROOT}` — it is resolved at run time to that
plugin's `installPath`, exactly as Claude Code sets it, so plugin hook commands work unchanged.

## Config

- `PI_CLAUDE_HOOKS_DISABLED=1` — disable the extension entirely.

## Install

```sh
pi install git:github.com/ejklock/pi-claude-hooks
```

The extension has **zero runtime dependencies** (Node builtins only); Pi loads `src/index.ts`
directly (TS at runtime, no build step), so there is nothing to compile or `npm install`.

## Provenance

Original work. Built to give the [pi coding agent](https://github.com/earendil-works) behavior
parity with Claude Code's hook system. Decision rationale lives in the `ai-configs` repo as
ADR `0015-pi-claude-hooks-blocking-parity`.
