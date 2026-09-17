// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * integrateToMain tests (worker/integrate.mjs).
 *
 * Covers the acceptance criteria for the decentralized, optimistic
 * "rebase + fast-forward push" integration loop:
 *
 *   - clean fast-forward                          → lands, one attempt
 *   - timing-race retry (#1)                      → loser re-pushes without re-resolving
 *   - same-region conflict resolution (#2)        → both sides preserved
 *   - unresolvable (semantic contradiction) abort → loud, precise failure
 *   - validation failure blocks the push          → never lands a broken tree
 *   - retry exhaustion                            → bounded, fails loudly
 *   - N-way contention                            → provably terminates, no livelock
 *   - non-ff retries vs auth/hook fail-fast       → classified correctly
 *
 * Loop-shape unit tests inject a fake git runner (fast, deterministic); the
 * conflict-resolution and race tests run against real local git repositories.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	integrateToMain,
	resolveConflictedContent,
	resolveRegion,
	conflictKey,
	backoffMs,
	makeGit,
} from "../integrate.mjs";

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** origin (bare) on main + a working clone whose HEAD carries the agent's commit. */
function repo({ baseFiles = { "shared.txt": "l1\nl2\nl3\n" } } = {}) {
	const root = mkdtempSync(join(tmpdir(), "integrate-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	git(root, "init", "--bare", "--initial-branch=main", origin);
	git(root, "clone", origin, work);
	git(work, "config", "user.email", "a@a.com");
	git(work, "config", "user.name", "Agent A");
	for (const [f, c] of Object.entries(baseFiles)) writeFileSync(join(work, f), c);
	git(work, "add", "-A");
	git(work, "commit", "-m", "base");
	git(work, "push", "origin", "main");
	return { root, origin, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Clone `origin`, mutate, commit, and push straight to main (a "winning" agent). */
function otherAgentPush(origin, parent, name, mutate) {
	const dir = join(parent, `other-${name}`);
	git(parent, "clone", origin, dir);
	git(dir, "config", "user.email", `${name}@x.com`);
	git(dir, "config", "user.name", name);
	mutate(dir);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", `change by ${name}`);
	git(dir, "push", "origin", "main");
	rmSync(dir, { recursive: true, force: true });
}

const noSleep = async () => {};
const silent = () => {};

// ── pure resolution unit tests ───────────────────────────────────────────────

test("conflictKey: structured vs plain lines", () => {
	assert.equal(conflictKey('  "alpha": handler,').key, '"alpha":');
	assert.equal(conflictKey("version = 1").key, "version=");
	assert.equal(conflictKey("import x from 'x'").key, "import x from 'x'");
	assert.equal(conflictKey("   ").kind, "blank");
});

test("resolveRegion: additive edits keep BOTH sides", () => {
	const r = resolveRegion(['  "alpha": aH,'], ['  "beta": bH,']);
	assert.ok(r.lines, "resolved");
	const text = r.lines.join("\n");
	assert.match(text, /alpha/);
	assert.match(text, /beta/);
});

test("resolveRegion: identical additions de-duplicate", () => {
	const r = resolveRegion(["- item"], ["- item"]);
	assert.deepEqual(
		r.lines.map((l) => l.trim()),
		["- item"],
	);
});

test("resolveRegion: same key, different value → contradiction", () => {
	const r = resolveRegion(['version = "1.2.0"'], ['version = "1.3.0"']);
	assert.ok(r.conflict, "flagged contradiction");
	assert.equal(r.conflict.reason, "value-contradiction");
});

test("resolveRegion: delete-vs-modify → contradiction", () => {
	const r = resolveRegion([], ["  changed()"]);
	assert.ok(r.conflict);
	assert.equal(r.conflict.reason, "delete-vs-modify");
});

test("resolveConflictedContent: union of two additions in one file (diff3 aware)", () => {
	const content = [
		"registry = {",
		"<<<<<<< HEAD",
		'  "alpha": alphaHandler,',
		"||||||| base",
		"=======",
		'  "beta": betaHandler,',
		">>>>>>> ours",
		"}",
	].join("\n");
	const r = resolveConflictedContent(content);
	assert.ok(r.resolved, "resolved");
	assert.match(r.resolved, /alpha/);
	assert.match(r.resolved, /beta/);
	assert.ok(!r.resolved.includes("<<<<<<<"), "no markers remain");
});

test("backoffMs: bounded by exponential cap and jittered within [0, exp)", () => {
	// Deterministic rng at the max returns just under the exponential bound.
	const almost1 = () => 0.999999;
	assert.ok(backoffMs(1, { base: 500, cap: 5000, random: almost1 }) < 500);
	assert.ok(backoffMs(2, { base: 500, cap: 5000, random: almost1 }) < 1000);
	// Capped: attempt 10 would be 500*2^9 but is clamped to 5000.
	assert.ok(backoffMs(10, { base: 500, cap: 5000, random: almost1 }) < 5000);
	assert.equal(backoffMs(3, { base: 500, cap: 5000, random: () => 0 }), 0);
});

// ── loop behavior with a fake git (fast, deterministic) ──────────────────────

/**
 * A scripted git double. `push` outcomes are pulled from `pushScript` in order;
 * everything else succeeds. `unmerged` toggles whether a rebase "conflicts".
 */
function fakeGit(pushScript) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		git: async (args) => {
			calls.push(args.join(" "));
			const cmd = args[0];
			if (cmd === "rev-parse" && args.includes("--git-path")) return { stdout: "/nonexistent", stderr: "" };
			if (cmd === "rev-parse") return { stdout: "deadbeef".padEnd(40, "0"), stderr: "" };
			if (cmd === "diff") return { stdout: "", stderr: "" }; // no unmerged files
			if (cmd === "push") {
				const outcome = pushScript[idx++] ?? "success";
				if (outcome === "success") return { stdout: "", stderr: "" };
				const err = new Error("push failed");
				err.stderr = outcome;
				throw err;
			}
			return { stdout: "", stderr: "" };
		},
	};
}

test("clean fast-forward: succeeds on the first attempt", async () => {
	const { git, calls } = fakeGit(["success"]);
	const res = await integrateToMain({ cwd: "/x", git, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
	assert.equal(res.ok, true);
	assert.equal(res.status, "success");
	assert.equal(res.attemptsUsed, 1);
	assert.ok(calls.some((c) => c.startsWith("push origin HEAD:main")));
});

test("timing race #1: non-ff rejection retries (with backoff) then succeeds; no re-resolution", async () => {
	const nonFf = "! [rejected] HEAD -> main (fetch first)\nerror: failed to push some refs";
	const { git } = fakeGit([nonFf, "success"]);
	const waited = [];
	const res = await integrateToMain({
		cwd: "/x",
		git,
		validate: async () => ({ ok: true }),
		log: silent,
		sleep: async (ms) => waited.push(ms),
		random: () => 0.5,
	});
	assert.equal(res.ok, true);
	assert.equal(res.attemptsUsed, 2);
	assert.equal(waited.length, 1, "backed off exactly once between attempts");
	assert.equal(res.attempts[0].push, "rejected-nonff");
});

test("auth/hook rejection fails fast (non-retryable, terminal)", async () => {
	const authErr = "remote: Permission to org/repo.git denied to bot.\nfatal: unable to access";
	const { git } = fakeGit([authErr, "success"]);
	const res = await integrateToMain({ cwd: "/x", git, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
	assert.equal(res.ok, false);
	assert.equal(res.status, "push-failed");
	assert.equal(res.attemptsUsed, 1, "did not retry a terminal error");
	assert.match(res.pushStderr, /Permission/);
});

test("retry exhaustion: bounded attempts, fails loudly with history", async () => {
	const nonFf = "(non-fast-forward)";
	const { git } = fakeGit(Array(20).fill(nonFf));
	const res = await integrateToMain({
		cwd: "/x",
		git,
		maxAttempts: 4,
		validate: async () => ({ ok: true }),
		log: silent,
		sleep: noSleep,
		random: () => 0,
	});
	assert.equal(res.ok, false);
	assert.equal(res.status, "exhausted");
	assert.equal(res.attemptsUsed, 4);
	assert.equal(res.attempts.length, 4);
	assert.ok(res.attempts.every((a) => a.push === "rejected-nonff"));
});

test("N-way sustained contention terminates (bounded) and does not livelock", async () => {
	// Every push loses forever → the loop must still terminate at maxAttempts.
	const { git } = fakeGit(Array(100).fill("(fetch first)"));
	let logs = 0;
	const res = await integrateToMain({
		cwd: "/x",
		git,
		maxAttempts: 8,
		validate: async () => ({ ok: true }),
		log: () => logs++,
		sleep: noSleep,
		random: Math.random, // real jitter
	});
	assert.equal(res.status, "exhausted");
	assert.equal(res.attemptsUsed, 8);
	assert.ok(logs > 0, "emitted an audit trail");
	assert.ok(res.wallMs >= 0);
});

test("validation failure blocks the push (never lands a broken tree)", async () => {
	const pushCalls = [];
	const git = async (args) => {
		if (args[0] === "push") pushCalls.push(args);
		if (args[0] === "rev-parse" && args.includes("--git-path")) return { stdout: "/nonexistent", stderr: "" };
		if (args[0] === "diff") return { stdout: "", stderr: "" };
		return { stdout: "sha", stderr: "" };
	};
	const res = await integrateToMain({
		cwd: "/x",
		git,
		validate: async () => ({ ok: false, output: "3 tests failed" }),
		log: silent,
		sleep: noSleep,
	});
	assert.equal(res.ok, false);
	assert.equal(res.status, "validation-failed");
	assert.equal(pushCalls.length, 0, "push must never be attempted on a failing tree");
	assert.match(res.reason, /3 tests failed/);
});

// ── real-git integration: conflicts & races end-to-end ───────────────────────

test("validation failure is repaired by the agent, then the tree lands", async () => {
	let repaired = false;
	let repairAttempt = 0;
	const pushCalls = [];
	const git = async (args) => {
		if (args[0] === "push") {
			pushCalls.push(args);
			return { stdout: "", stderr: "" };
		}
		return { stdout: "sha", stderr: "" };
	};
	const res = await integrateToMain({
		cwd: "/x",
		git,
		// Fails until the repair runs, then passes (mirrors a duplicate-import fix).
		validate: async () => (repaired ? { ok: true } : { ok: false, output: "Duplicate identifier 'x'" }),
		repairValidation: async ({ attempt }) => {
			repairAttempt = attempt;
			repaired = true;
		},
		maxRepairAttempts: 3,
		log: silent,
		sleep: noSleep,
	});
	assert.equal(res.ok, true);
	assert.equal(res.status, "success");
	assert.equal(repairAttempt, 1, "fixed on the first repair attempt");
	assert.equal(pushCalls.length, 1, "pushes once the repaired tree validates");
});

test("repair that never fixes validation aborts after maxRepairAttempts", async () => {
	let calls = 0;
	const pushCalls = [];
	const git = async (args) => {
		if (args[0] === "push") pushCalls.push(args);
		return { stdout: "sha", stderr: "" };
	};
	const res = await integrateToMain({
		cwd: "/x",
		git,
		validate: async () => ({ ok: false, output: "still broken" }),
		repairValidation: async () => {
			calls++;
		},
		maxRepairAttempts: 3,
		log: silent,
		sleep: noSleep,
	});
	assert.equal(res.ok, false);
	assert.equal(res.status, "validation-failed");
	assert.equal(calls, 3, "tried exactly maxRepairAttempts times");
	assert.equal(pushCalls.length, 0, "never pushes a tree that still fails");
	assert.match(res.reason, /after 3 repair attempt/);
});

test("same-region conflict (#2): both agents' additions land, auto-resolved", async () => {
	const { origin, root, work, cleanup } = repo({
		baseFiles: { "registry.txt": "entries = {\n}\n" },
	});
	try {
		// Winner adds "alpha" inside the block and pushes to main first.
		otherAgentPush(origin, root, "winner", (dir) => {
			writeFileSync(join(dir, "registry.txt"), 'entries = {\n  "alpha": alphaHandler,\n}\n');
		});
		// Our agent adds "beta" in the SAME region on a stale base.
		writeFileSync(join(work, "registry.txt"), 'entries = {\n  "beta": betaHandler,\n}\n');
		git(work, "add", "-A");
		git(work, "commit", "-m", "add beta");

		const res = await integrateToMain({
			cwd: work,
			validate: async () => ({ ok: true }),
			log: silent,
			sleep: noSleep,
		});
		assert.equal(res.ok, true, res.reason);
		assert.ok(res.attempts.some((a) => a.conflict), "a content conflict was resolved");

		git(work, "fetch", "origin", "main");
		const landed = execFileSync("git", ["show", "origin/main:registry.txt"], { cwd: work, encoding: "utf-8" });
		assert.match(landed, /alpha/, "winner's entry preserved");
		assert.match(landed, /beta/, "our entry preserved");
	} finally {
		cleanup();
	}
});

test("disjoint files: two agents integrate concurrently; loser retries without re-resolving", async () => {
	const { origin, root, work, cleanup } = repo({ baseFiles: { "base.txt": "x\n" } });
	try {
		otherAgentPush(origin, root, "winner", (dir) => writeFileSync(join(dir, "winner.txt"), "w\n"));
		writeFileSync(join(work, "loser.txt"), "l\n");
		git(work, "add", "-A");
		git(work, "commit", "-m", "loser file");

		const res = await integrateToMain({ cwd: work, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
		assert.equal(res.ok, true, res.reason);
		// Disjoint files never conflict — the rebase was clean on every attempt.
		assert.ok(res.attempts.every((a) => a.conflict === false), "no content conflict for disjoint files");

		git(work, "fetch", "origin", "main");
		const files = git(work, "ls-tree", "--name-only", "origin/main").split("\n");
		assert.ok(files.includes("winner.txt") && files.includes("loser.txt"));
	} finally {
		cleanup();
	}
});

test("unresolvable contradiction aborts loudly with a precise explanation", async () => {
	const { origin, root, work, cleanup } = repo({ baseFiles: { "config.txt": 'version = "1.0.0"\n' } });
	try {
		otherAgentPush(origin, root, "winner", (dir) => writeFileSync(join(dir, "config.txt"), 'version = "2.0.0"\n'));
		writeFileSync(join(work, "config.txt"), 'version = "3.0.0"\n');
		git(work, "add", "-A");
		git(work, "commit", "-m", "bump to 3");

		const res = await integrateToMain({ cwd: work, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
		assert.equal(res.ok, false);
		assert.equal(res.status, "unresolvable-conflict");
		assert.match(res.reason, /config\.txt/);
		assert.match(res.reason, /version/);
		// The working tree is left clean (rebase aborted), not mid-rebase.
		assert.equal(git(work, "status", "--porcelain"), "");
	} finally {
		cleanup();
	}
});

test("validation gate runs on the resolved tree and blocks a broken auto-resolution", async () => {
	const { origin, root, work, cleanup } = repo({ baseFiles: { "list.txt": "- a\n" } });
	try {
		otherAgentPush(origin, root, "winner", (dir) => writeFileSync(join(dir, "list.txt"), "- a\n- b\n"));
		writeFileSync(join(work, "list.txt"), "- a\n- c\n");
		git(work, "add", "-A");
		git(work, "commit", "-m", "add c");

		let validated = 0;
		const res = await integrateToMain({
			cwd: work,
			validate: async () => {
				validated++;
				return { ok: false, output: "lint failed on merged list" };
			},
			log: silent,
			sleep: noSleep,
		});
		assert.equal(res.ok, false);
		assert.equal(res.status, "validation-failed");
		assert.ok(validated >= 1, "validation actually ran on the resolved tree");
		// Nothing landed on the shared branch.
		git(work, "fetch", "origin", "main");
		const landed = execFileSync("git", ["show", "origin/main:list.txt"], { cwd: work, encoding: "utf-8" });
		assert.ok(!landed.includes("- c"), "broken tree never pushed");
	} finally {
		cleanup();
	}
});
