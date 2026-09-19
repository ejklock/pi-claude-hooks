import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { commandsFor, runCompletedSubagentPostToolUse, runLifecycleDetached, runPostToolUse } from "./index.ts";

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return predicate();
}

function writeSettings(dir: string, hooks: Record<string, unknown>): string {
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ hooks }), "utf8");
	return path;
}

function writeSettingsWithPlugins(dir: string, hooks: Record<string, unknown>, enabledPlugins: Record<string, boolean>): string {
	const path = join(dir, "settings.json");
	writeFileSync(path, JSON.stringify({ hooks, enabledPlugins }), "utf8");
	return path;
}

function writePluginTree(pluginsRoot: string, key: string, installPath: string, hooksObj: Record<string, unknown>): void {
	mkdirSync(join(installPath, "hooks"), { recursive: true });
	writeFileSync(join(installPath, "hooks", "hooks.json"), JSON.stringify({ hooks: hooksObj }), "utf8");
	mkdirSync(pluginsRoot, { recursive: true });
	writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ plugins: { [key]: [{ installPath }] } }), "utf8");
}

describe("commandsFor — memory session hook skip removed", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-hooks-test-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("T1: returns memory-session-start.sh for SessionStart (no longer skipped)", () => {
		const cmd = "/home/user/.claude/hooks/memory-session-start.sh";
		const settingsPath = writeSettings(tmpDir, {
			SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
		});

		const result = commandsFor("SessionStart", tmpDir, [], [settingsPath]);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.command, cmd);
	});

	it("T2: returns memory-session-end.sh for SessionEnd", () => {
		const cmd = "/home/user/.claude/hooks/memory-session-end.sh";
		const settingsPath = writeSettings(tmpDir, {
			SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }],
		});

		const result = commandsFor("SessionEnd", tmpDir, [], [settingsPath]);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.command, cmd);
	});

	it("T3: PreToolUse guard commands are still collected (no regression)", () => {
		const cmd = "/home/user/.claude/hooks/block-dangerous-patterns.sh";
		const settingsPath = writeSettings(tmpDir, {
			PreToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
		});

		const result = commandsFor("PreToolUse", tmpDir, [], [settingsPath]);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.command, cmd);
	});
});

describe("commandsFor — plugin hook parity", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-hooks-plugins-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("T6: returns an enabled plugin's PreToolUse hook alongside a settings hook", () => {
		const settingsCmd = "/home/user/.claude/hooks/settings-guard.sh";
		const pluginCmd = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"';
		const settingsPath = writeSettingsWithPlugins(
			tmpDir,
			{ PreToolUse: [{ hooks: [{ type: "command", command: settingsCmd }] }] },
			{ "living-docs-enforcer@marketplace": true },
		);
		const pluginsRoot = join(tmpDir, "plugins-t6");
		const installPath = join(tmpDir, "plugin-install-t6");
		writePluginTree(pluginsRoot, "living-docs-enforcer@marketplace", installPath, {
			PreToolUse: [{ hooks: [{ type: "command", command: pluginCmd }] }],
		});

		const result = commandsFor("PreToolUse", tmpDir, [], [settingsPath], pluginsRoot);

		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0]!.command, settingsCmd);
		assert.strictEqual(result[1]!.command, pluginCmd);
		assert.strictEqual(result[1]!.pluginRoot, installPath);
	});

	it("T7: a disabled or unlisted plugin contributes no hooks", () => {
		const settingsPath = writeSettingsWithPlugins(tmpDir, {}, {
			"disabled-plugin@marketplace": false,
		});
		const pluginsRoot = join(tmpDir, "plugins-t7");
		writePluginTree(pluginsRoot, "disabled-plugin@marketplace", join(tmpDir, "plugin-install-t7a"), {
			PreToolUse: [{ hooks: [{ type: "command", command: "echo disabled" }] }],
		});
		writePluginTree(pluginsRoot, "unlisted-plugin@marketplace", join(tmpDir, "plugin-install-t7b"), {
			PreToolUse: [{ hooks: [{ type: "command", command: "echo unlisted" }] }],
		});

		const result = commandsFor("PreToolUse", tmpDir, [], [settingsPath], pluginsRoot);

		assert.strictEqual(result.length, 0);
	});

	it("T8: a plugin hook resolves ${CLAUDE_PLUGIN_ROOT} at run time", async () => {
		const marker = join(tmpDir, "t8-marker");
		const settingsPath = writeSettingsWithPlugins(tmpDir, {}, { "warmup-plugin@marketplace": true });
		const pluginsRoot = join(tmpDir, "plugins-t8");
		const installPath = join(tmpDir, "plugin-install-t8");
		writePluginTree(pluginsRoot, "warmup-plugin@marketplace", installPath, {
			SessionStart: [{ hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/mark.sh"' }] }],
		});
		writeFileSync(join(installPath, "hooks", "mark.sh"), `touch ${marker}\n`, "utf8");

		runLifecycleDetached("SessionStart", fakeCtx(tmpDir), "{}", [settingsPath], pluginsRoot);

		assert.ok(await waitFor(() => existsSync(marker), 8000), "plugin hook did not resolve CLAUDE_PLUGIN_ROOT");
	});

	it("T9: malformed or missing installed_plugins.json leaves settings hooks intact", () => {
		const settingsCmd = "/home/user/.claude/hooks/settings-guard.sh";
		const settingsPath = writeSettingsWithPlugins(
			tmpDir,
			{ PreToolUse: [{ hooks: [{ type: "command", command: settingsCmd }] }] },
			{ "broken-plugin@marketplace": true },
		);

		const malformedRoot = join(tmpDir, "plugins-malformed");
		mkdirSync(malformedRoot, { recursive: true });
		writeFileSync(join(malformedRoot, "installed_plugins.json"), "{not valid json", "utf8");
		const malformedResult = commandsFor("PreToolUse", tmpDir, [], [settingsPath], malformedRoot);
		assert.strictEqual(malformedResult.length, 1);
		assert.strictEqual(malformedResult[0]!.command, settingsCmd);

		const missingRoot = join(tmpDir, "plugins-missing");
		const missingResult = commandsFor("PreToolUse", tmpDir, [], [settingsPath], missingRoot);
		assert.strictEqual(missingResult.length, 1);
		assert.strictEqual(missingResult[0]!.command, settingsCmd);
	});
});

describe("commandsFor — PostToolUse parity", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-hooks-post-tool-use-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns a matching PostToolUse hook", () => {
		const cmd = "/home/user/.claude/hooks/post-tool-use.sh";
		const settingsPath = writeSettings(tmpDir, {
			PostToolUse: [{ matcher: "Agent|Bash", hooks: [{ type: "command", command: cmd }] }],
		});

		const result = commandsFor("PostToolUse", tmpDir, ["Agent"], [settingsPath]);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.command, cmd);
	});

	it("passes a completed Bash result with Claude-shaped stdin", async () => {
		const marker = join(tmpDir, "bash-post-tool-use.json");
		const settingsPath = writeSettings(tmpDir, {
			PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `cat > ${marker}` }] }],
		});

		await runPostToolUse(
			{ toolName: "bash", toolCallId: "tool-17", input: { command: "printf done" }, content: [{ type: "text", text: "done" }], details: { code: 0 }, isError: false },
			fakeCtx(tmpDir),
			[settingsPath],
		);

		assert.deepStrictEqual(JSON.parse(readFileSync(marker, "utf8")), {
			session_id: "",
			transcript_path: "",
			cwd: tmpDir,
			hook_event_name: "PostToolUse",
			tool_use_id: "tool-17",
			tool_name: "Bash",
			tool_input: { command: "printf done" },
			tool_response: { content: [{ type: "text", text: "done" }], details: { code: 0 }, isError: false },
		});
	});

	it("defers Agent PostToolUse until the background subagent completes", async () => {
		const marker = join(tmpDir, "agent-post-tool-use.json");
		const settingsPath = writeSettings(tmpDir, {
			PostToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: `cat > ${marker}` }] }],
		});
		const ctx = fakeCtx(tmpDir);

		await runPostToolUse({ toolName: "Agent", input: { subagent_type: "coder" }, content: [] }, ctx, [settingsPath]);
		assert.strictEqual(existsSync(marker), false);

		await runCompletedSubagentPostToolUse({ id: "agent-42", type: "coder", result: { status: "done" } }, ctx, [settingsPath]);
		assert.deepStrictEqual(JSON.parse(readFileSync(marker, "utf8")), {
			session_id: "",
			transcript_path: "",
			cwd: tmpDir,
			hook_event_name: "PostToolUse",
			tool_use_id: "agent-42",
			tool_name: "Agent",
			tool_input: { subagent_type: "coder" },
			tool_response: { status: "done" },
		});
	});
});

describe("runLifecycleDetached — session_start does not block", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-hooks-detached-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("T4: returns synchronously while the hook still runs to completion", async () => {
		const marker = join(tmpDir, "t4-marker");
		const settingsPath = writeSettings(tmpDir, {
			SessionStart: [{ hooks: [{ type: "command", command: `sleep 0.3; touch ${marker}` }] }],
		});

		const started = Date.now();
		const result = runLifecycleDetached("SessionStart", fakeCtx(tmpDir), "{}", [settingsPath]);
		const elapsed = Date.now() - started;

		assert.strictEqual(result, undefined);
		assert.ok(elapsed < 150, `expected sync return, took ${elapsed}ms`);
		assert.ok(await waitFor(() => existsSync(marker), 8000), "hook did not run to completion in background");
	});

	it("T5: PI_CLAUDE_HOOKS_DISABLED=1 runs no hooks", async () => {
		const marker = join(tmpDir, "t5-marker");
		const settingsPath = writeSettings(tmpDir, {
			SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }],
		});

		process.env.PI_CLAUDE_HOOKS_DISABLED = "1";
		try {
			runLifecycleDetached("SessionStart", fakeCtx(tmpDir), "{}", [settingsPath]);
			await sleep(2000);
			assert.strictEqual(existsSync(marker), false, "hook ran despite kill switch");
		} finally {
			delete process.env.PI_CLAUDE_HOOKS_DISABLED;
		}
	});
});
