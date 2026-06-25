import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsFor } from "./index.ts";

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
