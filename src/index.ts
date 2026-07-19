import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INSTALL_SYMBOL = Symbol.for("ai-configs.pi-claude-hooks.installed");

const TOOL_CALL_TIMEOUT_MS = 5000;
const LIFECYCLE_TIMEOUT_MS = 10000;

export type ClaudeEvent = "PreToolUse" | "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "Stop";

interface HookCommand {
	type?: string;
	command?: string;
	timeout?: number;
}

interface HookMatcher {
	matcher?: string;
	hooks?: HookCommand[];
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface PiToolCallEvent {
	toolName?: string;
	input?: Record<string, unknown>;
}

interface BlockDecision {
	block: true;
	reason: string;
}

function isDisabled(): boolean {
	return process.env.PI_CLAUDE_HOOKS_DISABLED === "1";
}

function readHooksFile(path: string): Record<string, HookMatcher[]> | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, HookMatcher[]> };
		return parsed.hooks ?? null;
	} catch {
		return null;
	}
}

// Project settings extend (not replace) global settings, mirroring Claude Code's
// merge order: global first, then the project's .claude/settings.json.
export function matchersFor(
	event: ClaudeEvent,
	cwd: string,
	sources: string[] = [join(homedir(), ".claude", "settings.json"), join(cwd, ".claude", "settings.json")],
): HookMatcher[] {
	const matchers: HookMatcher[] = [];
	for (const source of sources) {
		const hooks = readHooksFile(source);
		if (hooks?.[event]) matchers.push(...hooks[event]);
	}
	return matchers;
}

function matcherApplies(matcher: string | undefined, toolNames: string[]): boolean {
	if (!matcher || matcher === "*") return true;
	let pattern: RegExp;
	try {
		pattern = new RegExp(matcher, "i");
	} catch {
		return toolNames.some((name) => name.toLowerCase() === matcher.toLowerCase());
	}
	return toolNames.some((name) => pattern.test(name));
}

// pi-claude-hooks owns the memory session lifecycle; @vahor/pi-hooks was retired.
export function commandsFor(event: ClaudeEvent, cwd: string, toolNames: string[], sources?: string[]): HookCommand[] {
	const commands: HookCommand[] = [];
	for (const entry of matchersFor(event, cwd, sources)) {
		if (!matcherApplies(entry.matcher, toolNames)) continue;
		for (const hook of entry.hooks ?? []) {
			if (hook.type !== "command" || !hook.command) continue;
			commands.push(hook);
		}
	}
	return commands;
}

function runHookCommand(command: string, stdin: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;
		const finish = (code: number, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (extra) err.push(Buffer.from(extra));
			resolveResult({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(-1, `\n${command} timed out after ${timeoutMs}ms`);
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => finish(-1, String(error)));
		child.on("close", (code) => finish(typeof code === "number" ? code : -1));
		child.stdin?.end(stdin);
	});
}

// Claude's PreToolUse advanced JSON: either {hookSpecificOutput:{permissionDecision:"deny",…}}
// or the legacy {decision:"block", reason}. Parse the last non-empty stdout line as JSON.
function jsonBlockReason(stdout: string): string | null {
	const line = stdout.trim().split("\n").pop()?.trim();
	if (!line || !line.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(line) as {
			decision?: string;
			permissionDecision?: string;
			reason?: string;
			permissionDecisionReason?: string;
			hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
		};
		const decision = parsed.hookSpecificOutput?.permissionDecision ?? parsed.permissionDecision ?? parsed.decision;
		if (decision === "deny" || decision === "block") {
			return parsed.hookSpecificOutput?.permissionDecisionReason ?? parsed.permissionDecisionReason ?? parsed.reason ?? "Blocked by a PreToolUse hook.";
		}
	} catch {
		return null;
	}
	return null;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	const trimmed = message.trim();
	if (!trimmed) return;
	if (ctx.hasUI) ctx.ui.notify(`pi-claude-hooks: ${trimmed}`, level);
}

function bashCommandOf(event: PiToolCallEvent): string {
	const raw = (event.input as { command?: unknown })?.command;
	return typeof raw === "string" ? raw : "";
}

// Pi tool names are lowercase ("bash"); Claude matchers and tool_name are
// PascalCase ("Bash"). Match against both so a Claude "Bash" matcher applies.
function claudeToolName(piToolName: string): string {
	if (piToolName.toLowerCase() === "bash") return "Bash";
	return piToolName.charAt(0).toUpperCase() + piToolName.slice(1);
}

function preToolUsePayload(toolName: string, toolInput: Record<string, unknown>, cwd: string): string {
	return JSON.stringify({
		session_id: "",
		transcript_path: "",
		cwd,
		hook_event_name: "PreToolUse",
		tool_name: toolName,
		tool_input: toolInput,
	});
}

async function handleToolCall(event: PiToolCallEvent, ctx: ExtensionContext): Promise<BlockDecision | undefined> {
	if (isDisabled()) return undefined;
	const piTool = typeof event.toolName === "string" ? event.toolName : "";
	if (!piTool) return undefined;
	const claudeTool = claudeToolName(piTool);
	const commands = commandsFor("PreToolUse", ctx.cwd, [claudeTool, piTool]);
	if (commands.length === 0) return undefined;

	const toolInput = piTool.toLowerCase() === "bash" ? { command: bashCommandOf(event) } : (event.input ?? {});
	const stdin = preToolUsePayload(claudeTool, toolInput, ctx.cwd);

	const notes: string[] = [];
	for (const hook of commands) {
		const result = await runHookCommand(hook.command!, stdin, ctx.cwd, hook.timeout ? hook.timeout * 1000 : TOOL_CALL_TIMEOUT_MS);
		const jsonReason = jsonBlockReason(result.stdout);
		if (result.code === 2 || jsonReason) {
			return { block: true, reason: (jsonReason || result.stderr || result.stdout).trim() || "Blocked by a PreToolUse hook." };
		}
		if (result.stdout.trim()) notes.push(result.stdout.trim());
	}
	if (notes.length > 0) notify(ctx, notes.join("\n"), "warning");
	return undefined;
}

// Routine hook stdout is intentionally NOT surfaced — only failures and PreToolUse
// guard output notify, so recurring status chatter never floods the UI.
async function runLifecycle(event: ClaudeEvent, ctx: ExtensionContext, stdin: string, sources?: string[]): Promise<void> {
	if (isDisabled()) return;
	for (const hook of commandsFor(event, ctx.cwd, [], sources)) {
		await runHookCommand(hook.command!, stdin, ctx.cwd, hook.timeout ? hook.timeout * 1000 : LIFECYCLE_TIMEOUT_MS);
	}
}

// SessionStart hooks (git fetch, daemon warmup) can take tens of seconds; running
// them detached keeps pi startup instant while their output still surfaces via notify.
export function runLifecycleDetached(event: ClaudeEvent, ctx: ExtensionContext, stdin: string, sources?: string[]): void {
	runLifecycle(event, ctx, stdin, sources).catch((error) => {
		// The ctx may be stale by the time a slow background hook fails (session
		// already replaced or exited); touching it then throws, so guard the notify.
		try {
			notify(ctx, `${event} hooks failed: ${String(error)}`, "warning");
		} catch {}
	});
}

function userPromptText(event: unknown): string {
	const candidate = event as { text?: unknown; input?: unknown; prompt?: unknown; message?: unknown };
	for (const value of [candidate.text, candidate.input, candidate.prompt, candidate.message]) {
		if (typeof value === "string") return value;
	}
	return "";
}

export default function piClaudeHooks(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	pi.on("tool_call", (event, ctx: ExtensionContext) => handleToolCall(event as PiToolCallEvent, ctx));

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		runLifecycleDetached("SessionStart", ctx, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: ctx.cwd }));
	});

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) =>
		runLifecycle("SessionEnd", ctx, JSON.stringify({ hook_event_name: "SessionEnd", reason: "other", cwd: ctx.cwd })),
	);

	pi.on("input", (event, ctx: ExtensionContext) => {
		const text = userPromptText(event);
		return runLifecycle("UserPromptSubmit", ctx, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: text, input: text, cwd: ctx.cwd }));
	});

	pi.on("turn_end", (_event, ctx: ExtensionContext) =>
		runLifecycle("Stop", ctx, JSON.stringify({ hook_event_name: "Stop", cwd: ctx.cwd })),
	);
}
