// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker delivery-adapter tests (worker/git.mjs).
 *
 * Exercises both delivery paths against real local git repositories (a bare
 * repo standing in for the GitHub remote — no network, no `gh`):
 *   - direct-merge happy path       → commit lands on the default branch, SHA returned
 *   - direct-merge no-changes       → pushed:false
 *   - direct-merge blocked push     → fails loudly with an actionable message
 *   - direct-merge non-ff race      → re-fetch + rebase + retry, then succeeds
 *   - pull-request push primitive   → HEAD lands on the feature branch (commitAndPush)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	finalizeDirectMerge,
	commitAndPush,
	ensurePrMerged,
	enableAutoMerge,
	checkpointPush,
	startCheckpointPusher,
} from "../git.mjs";

// These fixtures are bare git repos with no ecosystem markers. Since the
// validation gate now FAILS CLOSED on "no gate could be determined"
// (threat model M-008 / Test-020), delivery tests must state their gate
// explicitly — otherwise they would be testing the gate, not the delivery path.
// `validate.test.mjs` owns the fail-closed behaviour itself.
process.env.CLOUD_MODE_VALIDATE_CMD = process.env.CLOUD_MODE_VALIDATE_CMD ?? "true";

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Build a bare "origin" with an initial commit on `main`, a working clone, and
 * a per-story worktree branched off main. Returns paths + a cleanup fn.
 */
function setup() {
	const root = mkdtempSync(join(tmpdir(), "cloud-mode-git-"));
	const origin = join(root, "origin.git");
	const workdir = join(root, "work");
	const worktree = join(root, "story");

	git(root, "init", "--bare", "--initial-branch=main", origin);
	git(root, "clone", origin, workdir);
	git(workdir, "config", "user.email", "t@example.com");
	git(workdir, "config", "user.name", "Tester");
	writeFileSync(join(workdir, "README.md"), "base\n");
	git(workdir, "add", "-A");
	git(workdir, "commit", "-m", "init");
	git(workdir, "push", "origin", "main");
	git(workdir, "worktree", "add", "-b", "feature/S1", worktree, "main");

	return { root, origin, workdir, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("direct-merge: lands commit on the default branch and returns the SHA", async () => {
	const { origin, workdir, worktree, cleanup } = setup();
	try {
		writeFileSync(join(worktree, "feature.txt"), "hello\n");
		const res = await finalizeDirectMerge({ worktree, baseBranch: "main", storyId: "S1", userStory: "add feature" });
		assert.equal(res.pushed, true);
		assert.match(res.commitSha, /^[0-9a-f]{40}$/);
		// The commit is now the tip of `main` on the origin.
		const originMain = git(workdir, "ls-remote", origin, "refs/heads/main").split(/\s+/)[0];
		assert.equal(originMain, res.commitSha);
	} finally {
		cleanup();
	}
});

test("direct-merge: no changes → pushed:false", async () => {
	const { worktree, cleanup } = setup();
	try {
		const res = await finalizeDirectMerge({ worktree, baseBranch: "main", storyId: "S1", userStory: "noop" });
		assert.equal(res.pushed, false);
		assert.equal(res.ahead, 0);
	} finally {
		cleanup();
	}
});

test("direct-merge: blocked push fails loudly with an actionable message", async () => {
	// A non-bare origin checked out on `main` rejects a push to its current
	// branch (receive.denyCurrentBranch) — standing in for a branch-protection /
	// required-check rejection. The adapter must fail loudly, never fall back.
	const root = mkdtempSync(join(tmpdir(), "cloud-mode-git-blk-"));
	try {
		const origin = join(root, "origin");
		const workdir = join(root, "work");
		const worktree = join(root, "story");
		git(root, "init", "--initial-branch=main", origin);
		git(origin, "config", "user.email", "o@example.com");
		git(origin, "config", "user.name", "Origin");
		writeFileSync(join(origin, "README.md"), "base\n");
		git(origin, "add", "-A");
		git(origin, "commit", "-m", "init");
		git(root, "clone", origin, workdir);
		git(workdir, "config", "user.email", "t@example.com");
		git(workdir, "config", "user.name", "Tester");
		git(workdir, "worktree", "add", "-b", "feature/S1", worktree, "origin/main");

		writeFileSync(join(worktree, "feature.txt"), "hello\n");
		await assert.rejects(
			finalizeDirectMerge({ worktree, baseBranch: "main", storyId: "S1", userStory: "add feature", maxRetries: 2 }),
			(err) => {
				assert.match(err.message, /direct-merge to 'main' was rejected/);
				assert.match(err.message, /pull-request/);
				return true;
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("direct-merge: non-fast-forward race is re-fetched, rebased, and retried", async () => {
	const { origin, workdir, worktree, cleanup } = setup();
	try {
		// Another story advances `main` on the origin behind our back.
		const other = join(workdir, "..", "other");
		git(join(workdir, ".."), "clone", origin, other);
		git(other, "config", "user.email", "o@example.com");
		git(other, "config", "user.name", "Other");
		writeFileSync(join(other, "other.txt"), "other\n");
		git(other, "add", "-A");
		git(other, "commit", "-m", "concurrent change");
		git(other, "push", "origin", "main");

		// Our story commits and merges; the first push is non-ff, so it must
		// re-fetch + rebase on the new base and retry to success.
		writeFileSync(join(worktree, "feature.txt"), "hello\n");
		const res = await finalizeDirectMerge({ worktree, baseBranch: "main", storyId: "S1", userStory: "add feature" });
		assert.equal(res.pushed, true);

		// Origin main now contains BOTH the concurrent change and our feature.
		git(workdir, "fetch", "origin", "main");
		const files = git(workdir, "ls-tree", "--name-only", "origin/main").split("\n");
		assert.ok(files.includes("other.txt"), "concurrent change survived");
		assert.ok(files.includes("feature.txt"), "our feature landed");
	} finally {
		cleanup();
	}
});

test("pull-request path: commitAndPush lands HEAD on the feature branch", async () => {
	const { origin, workdir, worktree, cleanup } = setup();
	try {
		writeFileSync(join(worktree, "feature.txt"), "hello\n");
		const res = await commitAndPush({ worktree, branch: "feature/S1", baseBranch: "main", title: "feat: x" });
		assert.equal(res.pushed, true);
		assert.equal(res.ahead, 1);
		// The feature branch exists on origin; main is untouched.
		const featureRef = git(workdir, "ls-remote", origin, "refs/heads/feature/S1");
		assert.ok(featureRef, "feature branch pushed to origin");
		const headSha = git(worktree, "rev-parse", "HEAD");
		assert.equal(featureRef.split(/\s+/)[0], headSha);
	} finally {
		cleanup();
	}
});

// ── PR landing (auto-merge + explicit merge-on-green) ────────────────────────
//
// These exercise the landing logic against a stubbed `gh` runner: no network.
// The invariant under test is "the PR lands, but only when GitHub says it may" —
// a stale base is rebased and re-gated, a conflicting base is reported, and a
// rejected merge is retried instead of forced.

/** Build a `gh` stub that answers `pr view` from a scripted state sequence. */
function ghStub(script) {
	const calls = [];
	return {
		calls,
		runner: async (cmd, args) => {
			calls.push(args.join(" "));
			const sub = `${args[0]} ${args[1]}`;
			if (sub === "pr view") {
				// The last scripted state is sticky: further polls see the same status.
				const next = script.states.length > 1 ? script.states.shift() : (script.states[0] ?? {});
				return { stdout: JSON.stringify(next), stderr: "" };
			}
			const handler = script[sub];
			if (typeof handler === "function") return handler(args);
			return { stdout: "", stderr: "" };
		},
	};
}

test("landing: merges the PR as soon as GitHub reports it CLEAN", async () => {
	const stub = ghStub({ states: [{ state: "OPEN", mergeStateStatus: "CLEAN" }] });
	const res = await ensurePrMerged({
		worktree: "/tmp",
		branch: "feature/S1",
		runner: stub.runner,
		sleep: async () => {},
	});
	assert.equal(res.merged, true);
	assert.ok(stub.calls.some((c) => c === "pr merge feature/S1 --squash"), stub.calls.join(" | "));
});

test("landing: a BEHIND PR is updated onto the new base and handed back for re-gating", async () => {
	const stub = ghStub({ states: [{ state: "OPEN", mergeStateStatus: "BEHIND" }] });
	const res = await ensurePrMerged({
		worktree: "/tmp",
		branch: "feature/S1",
		runner: stub.runner,
		sleep: async () => {},
	});
	assert.equal(res.merged, false);
	assert.equal(res.updatedBranch, true, "caller must re-run CI on the new merge result");
	assert.ok(stub.calls.includes("pr update-branch feature/S1"));
	assert.ok(!stub.calls.some((c) => c.startsWith("pr merge")), "never merge a stale branch");
});

test("landing: a rejected merge is retried (never forced) and then succeeds", async () => {
	let mergeCalls = 0;
	const stub = ghStub({
		states: [
			{ state: "OPEN", mergeStateStatus: "BLOCKED" },
			{ state: "OPEN", mergeStateStatus: "CLEAN" },
		],
		"pr merge": () => {
			mergeCalls += 1;
			if (mergeCalls === 1) throw Object.assign(new Error("not mergeable"), { stderr: "base moved" });
			return { stdout: "", stderr: "" };
		},
	});
	const res = await ensurePrMerged({
		worktree: "/tmp",
		branch: "feature/S1",
		runner: stub.runner,
		sleep: async () => {},
		maxAttempts: 4,
	});
	assert.equal(res.merged, true);
	assert.ok(!stub.calls.some((c) => c.includes("--force")), "a merge is never forced");
});

test("landing: a PR that conflicts with the base is reported, not forced", async () => {
	const stub = ghStub({ states: [{ state: "OPEN", mergeStateStatus: "DIRTY" }] });
	const res = await ensurePrMerged({
		worktree: "/tmp",
		branch: "feature/S1",
		runner: stub.runner,
		sleep: async () => {},
	});
	assert.equal(res.merged, false);
	assert.equal(res.updatedBranch, false);
	assert.match(res.reason, /conflicts with the base/);
	assert.ok(!stub.calls.some((c) => c.startsWith("pr merge")));
});

test("landing: already-merged PR (auto-merge won the race) is a success", async () => {
	const stub = ghStub({ states: [{ state: "MERGED", mergeStateStatus: "UNKNOWN" }] });
	const res = await ensurePrMerged({ worktree: "/tmp", branch: "feature/S1", runner: stub.runner, sleep: async () => {} });
	assert.equal(res.merged, true);
	assert.ok(!stub.calls.some((c) => c.startsWith("pr merge")), "no redundant merge attempt");
});

test("auto-merge: a repo without auto-merge enabled is non-fatal", async () => {
	const res = await enableAutoMerge({
		worktree: "/tmp",
		branch: "feature/S1",
		runner: async () => {
			throw Object.assign(new Error("x"), { stderr: "Auto-merge is not allowed for this repository" });
		},
	});
	assert.equal(res.armed, false);
	assert.match(res.error, /Auto-merge is not allowed/);
});

// ── checkpoint pushes (liveness, friction class 4) ───────────────────────────
// Until these existed, an interrupted run left no branch, no PR and no error:
// the coordinator could not distinguish "slow" from "dead" and lost the work.

test("checkpoint: pushes work-in-progress to the feature branch mid-run", async () => {
	const { origin, workdir, worktree, cleanup } = setup();
	try {
		writeFileSync(join(worktree, "half-done.txt"), "partial work\n");
		const r = await checkpointPush({ worktree, branch: "feature/S1", baseBranch: "main", storyId: "S1", seq: 1 });

		assert.equal(r.pushed, true);
		const remote = git(workdir, "ls-remote", origin, "refs/heads/feature/S1").split(/\s+/)[0];
		assert.equal(remote, r.sha, "the branch must exist on the remote while the agent still runs");
		assert.match(git(worktree, "log", "-1", "--format=%s"), /^wip\(S1\): checkpoint 1/);
	} finally {
		cleanup();
	}
});

test("checkpoint: no-op on a clean tree (nothing to prove liveness with yet)", async () => {
	const { worktree, cleanup } = setup();
	try {
		const r = await checkpointPush({ worktree, branch: "feature/S1", baseBranch: "main", storyId: "S1" });
		assert.equal(r.pushed, false);
	} finally {
		cleanup();
	}
});

test("checkpoint: final commit carries the real title, not a wip subject", async () => {
	const { origin, workdir, worktree, cleanup } = setup();
	try {
		writeFileSync(join(worktree, "half-done.txt"), "partial\n");
		await checkpointPush({ worktree, branch: "feature/S1", baseBranch: "main", storyId: "S1" });
		// Agent finishes without further edits → tree is clean at finalization time.
		const r = await commitAndPush({
			worktree,
			branch: "feature/S1",
			baseBranch: "main",
			title: "feat(S1): the real title",
		});

		assert.equal(r.pushed, true);
		assert.equal(git(worktree, "log", "-1", "--format=%s"), "feat(S1): the real title");
		const remote = git(workdir, "ls-remote", origin, "refs/heads/feature/S1").split(/\s+/)[0];
		assert.equal(remote, git(worktree, "rev-parse", "HEAD"));
	} finally {
		cleanup();
	}
});

test("checkpoint pusher: a failing checkpoint is logged, never thrown", async () => {
	const events = [];
	const pusher = startCheckpointPusher({
		worktree: "/nonexistent",
		branch: "feature/S1",
		baseBranch: "main",
		storyId: "S1",
		intervalMs: 5,
		log: (e) => events.push(e),
		push: async () => {
			throw new Error("index.lock held");
		},
	});
	await new Promise((r) => setTimeout(r, 60));
	await pusher.stop();

	assert.ok(events.length > 0, "failures must be observable");
	assert.equal(events[0].event, "checkpoint-failed");
	assert.match(events[0].reason, /index\.lock/);
});

test("checkpoint pusher: stop() awaits the in-flight checkpoint (no race with the final commit)", async () => {
	let finished = false;
	const pusher = startCheckpointPusher({
		worktree: "/x",
		branch: "feature/S1",
		baseBranch: "main",
		storyId: "S1",
		intervalMs: 5,
		push: async () => {
			await new Promise((r) => setTimeout(r, 40));
			finished = true;
			return { pushed: true, sha: "deadbeef" };
		},
	});
	await new Promise((r) => setTimeout(r, 20));
	await pusher.stop();
	assert.equal(finished, true, "stop() must not return while a checkpoint is still writing");
});
