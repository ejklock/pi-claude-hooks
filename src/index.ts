import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
	pluginRoot?: string;
}

interface HookMatcher {
	matcher?: string;
	hooks?: HookCommand[];
}

interface PluginHookSource {
	hooksFile: string;
	pluginRoot: string;
}

interface InstalledPluginRecord {
	installPath?: string;
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

function readJsonFile<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function readHooksFile(path: string): Record<string, HookMatcher[]> | null {
	const parsed = readJsonFile<{ hooks?: Record<string, HookMatcher[]> }>(path);
	return parsed?.hooks ?? null;
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

function defaultSettingsSources(cwd: string): string[] {
	return [join(homedir(), ".claude", "settings.json"), join(cwd, ".claude", "settings.json")];
}

// enabledPlugins maps "name@marketplace" -> boolean; later sources (project settings)
// override earlier ones (global settings), mirroring Claude Code's own merge order.
export function enabledPluginKeys(sources: string[]): Set<string> {
	const merged: Record<string, boolean> = {};
	for (const source of sources) {
		const parsed = readJsonFile<{ enabledPlugins?: Record<string, boolean> }>(source);
		if (parsed?.enabledPlugins) Object.assign(merged, parsed.enabledPlugins);
	}
	const enabled = new Set<string>();
	for (const [key, value] of Object.entries(merged)) {
		if (value === true) enabled.add(key);
	}
	return enabled;
}

function pluginHookSources(sources: string[], pluginsRoot: string): PluginHookSource[] {
	const manifest = readJsonFile<{ plugins?: Record<string, InstalledPluginRecord[]> }>(
		join(pluginsRoot, "installed_plugins.json"),
	);
	if (!manifest?.plugins) return [];
	const result: PluginHookSource[] = [];
	for (const key of enabledPluginKeys(sources)) {
		const record = (manifest.plugins[key] ?? []).find(
			(candidate) => candidate.installPath && existsSync(join(candidate.installPath, "hooks", "hooks.json")),
		);
		if (!record?.installPath) continue;
		result.push({ hooksFile: join(record.installPath, "hooks", "hooks.json"), pluginRoot: record.installPath });
	}
	return result;
}

// Every HookCommand a plugin declares is stamped with its install directory so
// runHookCommand can resolve ${CLAUDE_PLUGIN_ROOT} in the command string at run time.
function pluginMatchersFor(event: ClaudeEvent, sources: string[], pluginsRoot: string): HookMatcher[] {
	const matchers: HookMatcher[] = [];
	for (const { hooksFile, pluginRoot } of pluginHookSources(sources, pluginsRoot)) {
		const hooks = readHooksFile(hooksFile);
		for (const entry of hooks?.[event] ?? []) {
			matchers.push({
				matcher: entry.matcher,
				hooks: (entry.hooks ?? []).map((hook) => ({ ...hook, pluginRoot })),
			});
		}
	}
	return matchers;
}

function collectMatchingCommands(matchers: HookMatcher[], toolNames: string[]): HookCommand[] {
	const commands: HookCommand[] = [];
	for (const entry of matchers) {
		if (!matcherApplies(entry.matcher, toolNames)) continue;
		for (const hook of entry.hooks ?? []) {
			if (hook.type !== "command" || !hook.command) continue;
			commands.push(hook);
		}
	}
	return commands;
}

// pi-claude-hooks owns the memory session lifecycle; @vahor/pi-hooks was retired.
// Settings hooks (~/.claude/settings.json) are collected first, then enabled-plugin
// hooks (installed_plugins.json -> <installPath>/hooks/hooks.json) are appended.
export function commandsFor(
	event: ClaudeEvent,
	cwd: string,
	toolNames: string[],
	sources?: string[],
	pluginsRoot: string = join(homedir(), ".claude", "plugins"),
): HookCommand[] {
	const settingsCommands = collectMatchingCommands(matchersFor(event, cwd, sources), toolNames);
	const pluginCommands = collectMatchingCommands(
		pluginMatchersFor(event, sources ?? defaultSettingsSources(cwd), pluginsRoot),
		toolNames,
	);
	return [...settingsCommands, ...pluginCommands];
}

function runHookCommand(
	command: string,
	stdin: string,
	cwd: string,
	timeoutMs: number,
	pluginRoot?: string,
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}) },
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

interface AdvancedJsonHookOutput {
	decision?: string;
	permissionDecision?: string;
	reason?: string;
	permissionDecisionReason?: string;
	hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

function resolveDecision(parsed: AdvancedJsonHookOutput): string | undefined {
	return parsed.hookSpecificOutput?.permissionDecision ?? parsed.permissionDecision ?? parsed.decision;
}

function resolveReason(parsed: AdvancedJsonHookOutput): string {
	return (
		parsed.hookSpecificOutput?.permissionDecisionReason ??
		parsed.permissionDecisionReason ??
		parsed.reason ??
		"Blocked by a PreToolUse hook."
	);
}

// Claude's PreToolUse advanced JSON: either {hookSpecificOutput:{permissionDecision:"deny",…}}
// or the legacy {decision:"block", reason}. Parse the last non-empty stdout line as JSON.
function jsonBlockReason(stdout: string): string | null {
	const line = stdout.trim().split("\n").pop()?.trim();
	if (!line || !line.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(line) as AdvancedJsonHookOutput;
		const decision = resolveDecision(parsed);
		if (decision === "deny" || decision === "block") {
			return resolveReason(parsed);
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

interface HookEvaluation {
	block?: BlockDecision;
	note?: string;
}

// Exit code 2, or Claude's advanced-JSON deny/block decision, blocks the tool
// call; any other non-empty stdout becomes a note surfaced via notify.
async function evaluatePreToolUseHook(hook: HookCommand, stdin: string, cwd: string): Promise<HookEvaluation> {
	const result = await runHookCommand(
		hook.command!,
		stdin,
		cwd,
		hook.timeout ? hook.timeout * 1000 : TOOL_CALL_TIMEOUT_MS,
		hook.pluginRoot,
	);
	const jsonReason = jsonBlockReason(result.stdout);
	if (result.code === 2 || jsonReason) {
		const reason = (jsonReason || result.stderr || result.stdout).trim() || "Blocked by a PreToolUse hook.";
		return { block: { block: true, reason } };
	}
	const note = result.stdout.trim();
	return note ? { note } : {};
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
		const { block, note } = await evaluatePreToolUseHook(hook, stdin, ctx.cwd);
		if (block) return block;
		if (note) notes.push(note);
	}
	if (notes.length > 0) notify(ctx, notes.join("\n"), "warning");
	return undefined;
}

// Routine hook stdout is intentionally NOT surfaced — only failures and PreToolUse
// guard output notify, so recurring status chatter never floods the UI.
async function runLifecycle(
	event: ClaudeEvent,
	ctx: ExtensionContext,
	stdin: string,
	sources?: string[],
	pluginsRoot?: string,
): Promise<void> {
	if (isDisabled()) return;
	for (const hook of commandsFor(event, ctx.cwd, [], sources, pluginsRoot)) {
		await runHookCommand(
			hook.command!,
			stdin,
			ctx.cwd,
			hook.timeout ? hook.timeout * 1000 : LIFECYCLE_TIMEOUT_MS,
			hook.pluginRoot,
		);
	}
}

// SessionStart hooks (git fetch, daemon warmup) can take tens of seconds; running
// them detached keeps pi startup instant while their output still surfaces via notify.
export function runLifecycleDetached(
	event: ClaudeEvent,
	ctx: ExtensionContext,
	stdin: string,
	sources?: string[],
	pluginsRoot?: string,
): void {
	runLifecycle(event, ctx, stdin, sources, pluginsRoot).catch((error) => {
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
