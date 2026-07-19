import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { commandsFor, runLifecycleDetached } from "./index.ts";

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
