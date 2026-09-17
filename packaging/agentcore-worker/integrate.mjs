// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * integrateToMain — decentralized, optimistic "rebase + fast-forward push"
 * integration for multiple autonomous agents landing work on a shared branch.
 *
 * Multiple agents each produce commit(s) on their own local branch and must
 * integrate them into the shared default branch of the SAME repo. "Rebase onto
 * latest, then push" is a non-atomic read-modify-write, so concurrent agents
 * collide in two distinct ways that are handled differently here:
 *
 *   1. Coordination race (timing): we rebased onto a tip another agent advanced
 *      before we could push. The change still applies cleanly; only the push is
 *      stale. → git rejects the push as non-fast-forward; we back off and retry.
 *
 *   2. Content conflict (same bytes): two agents edited overlapping lines, so
 *      the rebase itself conflicts. → we resolve intent-preservingly (keep BOTH
 *      sides' additions), re-validate, and push. A genuine semantic
 *      contradiction aborts loudly rather than guessing.
 *
 * Conflict resolution is pluggable via the `resolveConflict` option. The default
 * is a deterministic intent-preserving union (used by tests and any caller that
 * doesn't supply one); the worker injects an LLM-backed resolver in production
 * (worker/llm-resolver.mjs) so it can understand both sides' intent from the
 * surrounding code. Either way the resolver must return a fully merged file or
 * declare the conflict unresolvable — it must never silently drop a side.
 *
 * There is NO merge queue, global mutex, or external coordinator: this is a
 * purely optimistic per-agent compare-and-swap loop. The push is the CAS — a
 * plain `git push` is fast-forward-only by default (git rejects a
 * non-fast-forward update to the remote ref unless forced), so it succeeds iff
 * the branch did not move. A rejected push means "someone won the race", and we
 * retry rather than force it through.
 *
 * Safety: after every successful rebase/resolution and BEFORE the push, the
 * caller-supplied validation gate runs on the resolved tree. A tree that fails
 * validation is NEVER pushed — this is what stops a fallible auto-resolution
 * from landing on the shared branch.
 *
 * Everything project-specific (validation command, branch name, remote, attempt
 * budget, backoff) is configuration with sensible defaults.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { gitEnv } from "./git-auth.mjs";

const execFileAsync = promisify(execFile);

// A push is only retryable when it was rejected because the ref moved (a #1
// coordination race). Match ONLY genuine non-fast-forward markers — not the
// generic "failed to push some refs" / "[remote rejected]" trailers that also
// accompany terminal rejections (denyCurrentBranch, branch protection, hooks).
const NON_FF_RE = /\(non-fast-forward\)|\(fetch first\)|tip of your current branch is behind|remote contains work that you do|cannot lock ref/i;

// ── git runner ───────────────────────────────────────────────────────────────

/**
 * Build a git runner bound to `cwd`. Injectable so tests can stub it.
 * Resolves to { stdout, stderr }; rejects with an Error carrying { stdout,
 * stderr, code } on non-zero exit. GIT_EDITOR/SEQUENCE_EDITOR are neutralized so
 * `rebase --continue` never blocks on an interactive editor.
 *
 * The GitHub installation token is injected per command through the askpass
 * helper (see git.mjs `gitEnv`) rather than living in git configuration — the
 * push in this loop is the one place that needs it (M-026).
 */
export function makeGit(cwd) {
	return async function git(args) {
		const env = gitEnv({ GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", EDITOR: "true" });
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			env,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { stdout: stdout.toString(), stderr: stderr.toString() };
	};
}

// ── intent-preserving conflict resolution (#2) ───────────────────────────────

/**
 * Derive a stability key for a conflicted line so we can tell "both sides added
 * different things" (union-safe) from "both sides set the same thing to
 * different values" (a genuine contradiction).
 *
 *   - blank line          → { kind: "blank" }         (never a contradiction)
 *   - "key: value" / "k = v" (structured) → { kind: "kv", key }  (keyed by lhs)
 *   - anything else       → { kind: "line", key: trimmed }       (keyed by text)
 */
export function conflictKey(line) {
	const t = line.trim();
	if (t === "") return { kind: "blank", key: "" };
	const m = t.match(/^(.*?)([:=])(.*)$/);
	if (m && m[1].trim() !== "") return { kind: "kv", key: `${m[1].trim()}${m[2]}` };
	return { kind: "line", key: t };
}

/**
 * Resolve a single conflict region (the lines between the markers) by
 * PRESERVING BOTH sides' intent. Returns { lines } on success or { conflict }
 * when the two changes are genuinely mutually exclusive.
 *
 * Rules:
 *   - Identical lines are de-duplicated (kept once).
 *   - Both sides adding distinct content in the same region → union, ours first
 *     then theirs' unique lines, order preserved (registry entries, list items,
 *     imports, functions all "keep both").
 *   - A structured line whose key appears on BOTH sides with a DIFFERENT value
 *     is a contradiction (e.g. the same config set two ways) → abort.
 *   - One side empty vs the other non-empty is a delete-vs-modify contradiction
 *     → abort (we must not silently drop the other side's change).
 */
export function resolveRegion(ours, theirs, ctx = {}) {
	const oursTrim = ours.map((l) => l.trim()).filter((l) => l !== "");
	const theirsTrim = theirs.map((l) => l.trim()).filter((l) => l !== "");

	// Identical (ignoring blank-line noise) — trivially resolved.
	if (oursTrim.join("\n") === theirsTrim.join("\n")) return { lines: ours.length >= theirs.length ? ours : theirs };

	// Delete-vs-modify: one side removed everything the other side changed.
	if (oursTrim.length === 0 || theirsTrim.length === 0) {
		return {
			conflict: {
				reason: "delete-vs-modify",
				message:
					"one side removed the region while the other modified it — preserving both is impossible",
				ours,
				theirs,
				...ctx,
			},
		};
	}

	// Contradiction: same structured key set to different values on each side.
	const oursByKey = new Map();
	for (const l of ours) {
		const k = conflictKey(l);
		if (k.kind === "kv") oursByKey.set(k.key, l.trim());
	}
	for (const l of theirs) {
		const k = conflictKey(l);
		if (k.kind === "kv" && oursByKey.has(k.key) && oursByKey.get(k.key) !== l.trim()) {
			return {
				conflict: {
					reason: "value-contradiction",
					message: `both sides set '${k.key}' to different values ("${oursByKey.get(k.key)}" vs "${l.trim()}") — cannot keep both`,
					ours,
					theirs,
					...ctx,
				},
			};
		}
	}

	// Union: keep both sides, ours first, then theirs' lines we haven't already
	// emitted (exact-trim de-dupe). Blank lines are collapsed to a single
	// separator so we never accumulate noise across repeated resolutions.
	const out = [];
	const seen = new Set();
	const push = (line) => {
		const t = line.trim();
		if (t === "") {
			if (out.length && out[out.length - 1].trim() === "") return;
			out.push(line);
			return;
		}
		if (seen.has(t)) return;
		seen.add(t);
		out.push(line);
	};
	for (const l of ours) push(l);
	for (const l of theirs) push(l);
	return { lines: out };
}

/**
 * Resolve every conflict region in a file's content. Handles both 2-way and
 * diff3 (with a `|||||||` base section) conflict markers. Returns
 * { resolved } or the first { conflict } encountered.
 */
export function resolveConflictedContent(content, ctx = {}) {
	const lines = content.split("\n");
	const out = [];
	const resolvedRegions = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith("<<<<<<<")) {
			out.push(line);
			i++;
			continue;
		}
		// Enter a conflict region.
		i++;
		const ours = [];
		const theirs = [];
		while (i < lines.length && !lines[i].startsWith("|||||||") && !lines[i].startsWith("=======")) {
			ours.push(lines[i]);
			i++;
		}
		// Skip the optional diff3 base section — union preserves both current
		// sides regardless of the common ancestor.
		if (i < lines.length && lines[i].startsWith("|||||||")) {
			i++;
			while (i < lines.length && !lines[i].startsWith("=======")) i++;
		}
		if (i >= lines.length || !lines[i].startsWith("=======")) {
			return { conflict: { reason: "malformed-markers", message: "missing '=======' separator", ...ctx } };
		}
		i++; // consume '======='
		while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
			theirs.push(lines[i]);
			i++;
		}
		if (i >= lines.length || !lines[i].startsWith(">>>>>>>")) {
			return { conflict: { reason: "malformed-markers", message: "missing '>>>>>>>' terminator", ...ctx } };
		}
		i++; // consume '>>>>>>>'

		const region = resolveRegion(ours, theirs, ctx);
		if (region.conflict) return { conflict: region.conflict };
		out.push(...region.lines);
		resolvedRegions.push({ ours: ours.length, theirs: theirs.length, merged: region.lines.length });
	}
	return { resolved: out.join("\n"), regions: resolvedRegions };
}

// ── backoff ──────────────────────────────────────────────────────────────────

/** Exponential backoff with full jitter, capped. De-correlates competing agents. */
export function backoffMs(attempt, { base = 500, cap = 5000, random = Math.random } = {}) {
	const exp = Math.min(cap, base * 2 ** (attempt - 1));
	return Math.floor(random() * exp); // full jitter in [0, exp)
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the integration loop ─────────────────────────────────────────────────────

/**
 * @typedef {Object} IntegrateResult
 * @property {boolean} ok
 * @property {"success"|"unresolvable-conflict"|"validation-failed"|"push-failed"|"exhausted"} status
 * @property {string=} commitSha        landed tip on success
 * @property {string=} reason           human-readable failure explanation
 * @property {string=} pushStderr       raw stderr for a terminal push failure
 * @property {Array}   attempts         per-attempt audit records
 * @property {number}  attemptsUsed
 * @property {number}  wallMs
 */

/**
 * Integrate the current HEAD's commit(s) onto `remote/branch` via the optimistic
 * rebase + `--ff-only` push CAS loop described at the top of this file.
 *
 * @returns {Promise<IntegrateResult>}
 */
export async function integrateToMain({
	cwd,
	remote = "origin",
	branch = "main",
	maxAttempts = 8,
	backoff = {},
	/** async () => ({ ok: boolean, output?: string }); default: no-op pass. */
	validate = async () => ({ ok: true }),
	/**
	 * Conflict resolver: async ({ file, content, cwd }) => ({ resolved } | { conflict }).
	 * Default is the deterministic intent-preserving union resolver; the worker
	 * injects an LLM-backed resolver for production (see worker/llm-resolver.mjs).
	 */
	resolveConflict = async ({ file, content }) => resolveConflictedContent(content, { file }),
	/**
	 * Optional LLM repair for a tree that fails validation after a *clean* merge
	 * (no git conflict) — e.g. a duplicate import from two independent additions.
	 * async ({ output, attempt, maxAttempts }) => void; edits the working tree.
	 * When set, a validation failure is repaired-and-re-validated up to
	 * `maxRepairAttempts` times before it becomes terminal.
	 */
	repairValidation,
	maxRepairAttempts = 3,
	git = makeGit(cwd),
	sleep = defaultSleep,
	random = Math.random,
	/** structured audit sink; receives one object per logged event. */
	log = (e) => console.error(`[integrate] ${JSON.stringify(e)}`),
	now = Date.now,
} = {}) {
	const startedAt = now();
	const attempts = [];

	const emit = (event) => {
		try {
			log({ t: now(), ...event });
		} catch {
			/* a broken logger must never break integration */
		}
	};

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const rec = { attempt, conflict: false, resolvedFiles: [], validation: null, push: null, backoffMs: 0 };
		attempts.push(rec);

		await git(["fetch", remote, branch]);
		const tip = (await git(["rev-parse", `${remote}/${branch}`])).stdout.trim();
		rec.baseTip = tip;
		emit({ event: "fetched", attempt, baseTip: tip });

		// ── rebase onto latest tip ──────────────────────────────────────────
		try {
			await git(["rebase", `${remote}/${branch}`]);
		} catch (err) {
			const unmerged = await unmergedFiles(git);
			if (unmerged.length === 0) {
				// A rebase failure that is NOT a content conflict (e.g. corrupt
				// state) is terminal. Leave no rebase in progress.
				await git(["rebase", "--abort"]).catch(() => {});
				const reason = `rebase failed without conflicts: ${errText(err)}`;
				emit({ event: "rebase-error", attempt, reason });
				return finish({ ok: false, status: "push-failed", reason });
			}
			// ── content conflict (#2): resolve intent-preservingly ──────────
			rec.conflict = true;
			emit({ event: "conflict", attempt, files: unmerged });
			const resolution = await resolveRebaseConflicts({ git, cwd, resolveConflict, emit, attempt });
			if (!resolution.ok) {
				await git(["rebase", "--abort"]).catch(() => {});
				emit({ event: "unresolvable", attempt, detail: resolution.conflict });
				return finish({
					ok: false,
					status: "unresolvable-conflict",
					reason: describeConflict(resolution.conflict),
				});
			}
			rec.resolvedFiles = resolution.files;
		}

		// ── validation gate (safety) — MUST pass before we push ─────────────
		let v = await validate();
		rec.validation = v.ok ? "pass" : "fail";
		emit({ event: "validation", attempt, ok: v.ok });

		if (!v.ok && repairValidation && maxRepairAttempts > 0) {
			// The deterministic checker (compiler/linter/tests) failed on the merged
			// tree. A clean git merge can still produce a broken tree — e.g. two
			// independent additions yielding a duplicate import — without ever raising
			// a conflict for the resolver. Let the agent read the error and fix it,
			// up to maxRepairAttempts, re-validating after each attempt.
			let repairsUsed = 0;
			for (let r = 1; r <= maxRepairAttempts && !v.ok; r++) {
				repairsUsed = r;
				emit({ event: "repair-attempt", attempt, repair: r });
				try {
					await repairValidation({ output: v.output ?? "", attempt: r, maxAttempts: maxRepairAttempts });
				} catch (e) {
					emit({ event: "repair-error", attempt, repair: r, reason: errText(e) });
					break;
				}
				await git(["add", "-A"]).catch(() => {});
				v = await validate();
				emit({ event: "repair-validation", attempt, repair: r, ok: v.ok });
			}
			rec.repairsUsed = repairsUsed;
			rec.validation = v.ok ? "pass-after-repair" : "fail";
		}

		if (!v.ok) {
			// Still broken (after repair, or with no repairer): never reach the
			// shared branch. Loud terminal failure.
			return finish({
				ok: false,
				status: "validation-failed",
				reason:
					"validation gate failed on the resolved tree" +
					(repairValidation ? ` after ${maxRepairAttempts} repair attempt(s)` : "") +
					"; refusing to push. " +
					`Output:\n${(v.output ?? "").trim()}`,
			});
		}

		// Fold any tree changes made by the validation gate into a commit so the
		// push includes them: this covers both the formatter normalizing the tree
		// (e.g. prettier --write) and any LLM repair edits. A no-op when the gate
		// left the tree untouched.
		{
			const { stdout: dirty } = await git(["status", "--porcelain"]);
			if (dirty.trim()) {
				await git(["add", "-A"]);
				await git(["commit", "-m", "chore(integrate): normalize/repair tree before push"]);
				emit({ event: "repair-committed", attempt });
			}
		}

		// ── push as compare-and-swap (#1) ──────────────────────────────────
		// A plain push is already the CAS: git rejects a non-fast-forward update to
		// the remote ref unless forced, so the push succeeds iff the branch did not
		// move since our fetch. We deliberately do NOT pass --force/--force-with-lease
		// ("win the race") — a rejected push must trigger a retry, never an overwrite.
		try {
			await git(["push", remote, `HEAD:${branch}`]);
			const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
			rec.push = "success";
			emit({ event: "push-success", attempt, commitSha: sha });
			return finish({ ok: true, status: "success", commitSha: sha });
		} catch (err) {
			const stderr = errText(err);
			if (NON_FF_RE.test(stderr)) {
				// #1 coordination race: someone advanced the ref between our fetch
				// and our push. Back off (jittered) and retry — re-fetch, re-rebase,
				// re-resolve if needed. NEVER force.
				const wait = backoffMs(attempt, { ...backoff, random });
				rec.push = "rejected-nonff";
				rec.backoffMs = wait;
				emit({ event: "push-rejected", attempt, reason: "non-fast-forward", backoffMs: wait });
				if (attempt < maxAttempts) await sleep(wait);
				continue;
			}
			// Auth / network / pre-receive-hook rejection → terminal.
			rec.push = "terminal-error";
			emit({ event: "push-error", attempt, reason: stderr });
			return finish({ ok: false, status: "push-failed", reason: stderr, pushStderr: stderr });
		}
	}

	emit({ event: "exhausted", attemptsUsed: maxAttempts });
	return finish({
		ok: false,
		status: "exhausted",
		reason: `exhausted ${maxAttempts} attempts; the shared branch kept moving (sustained contention)`,
	});

	function finish(partial) {
		const result = {
			...partial,
			attempts,
			attemptsUsed: attempts.length,
			wallMs: now() - startedAt,
		};
		emit({ event: "summary", status: result.status, ok: result.ok, attemptsUsed: result.attemptsUsed, wallMs: result.wallMs });
		return result;
	}
}

/**
 * Drive a possibly multi-commit rebase to completion, resolving each conflict
 * region intent-preservingly. Returns { ok:true, files } or { ok:false, conflict }.
 */
async function resolveRebaseConflicts({ git, cwd, resolveConflict, emit, attempt }) {
	const touched = [];
	// A rebase of N commits can stop with conflicts N times; loop until the
	// rebase is no longer in progress. The guard bounds pathological loops.
	for (let step = 0; step < 1000; step++) {
		const unmerged = await unmergedFiles(git);
		if (unmerged.length === 0) {
			// No conflicts pending. If a rebase is still in progress, continue it;
			// if `--continue` surfaces new conflicts we loop, otherwise we're done.
			if (!(await rebaseInProgress(git))) return { ok: true, files: dedupe(touched) };
			try {
				await git(["rebase", "--continue"]);
				if (!(await rebaseInProgress(git))) return { ok: true, files: dedupe(touched) };
				continue;
			} catch (err) {
				if ((await unmergedFiles(git)).length === 0 && !(await rebaseInProgress(git))) {
					return { ok: true, files: dedupe(touched) };
				}
				// fall through to resolve the freshly-surfaced conflicts
			}
		}
		for (const file of unmerged) {
			const abs = join(cwd, file);
			const content = readFileSync(abs, "utf8");
			let r;
			try {
				r = await resolveConflict({ file, content, cwd });
			} catch (err) {
				// A resolver that throws (e.g. the LLM call failed) must abort loudly,
				// never silently drop a side or push an unresolved tree.
				return {
					ok: false,
					conflict: { reason: "resolver-error", message: errText(err), file },
				};
			}
			if (!r || r.conflict) return { ok: false, conflict: r?.conflict ?? { reason: "resolver-empty", message: "resolver returned nothing", file } };
			if (typeof r.resolved !== "string" || r.resolved.includes("<<<<<<<") || r.resolved.includes(">>>>>>>")) {
				return { ok: false, conflict: { reason: "markers-remain", message: "resolver left conflict markers in the file", file } };
			}
			writeFileSync(abs, r.resolved);
			await git(["add", "--", file]);
			touched.push(file);
			emit({ event: "resolved", attempt, file, regions: r.regions });
		}
		try {
			await git(["rebase", "--continue"]);
		} catch {
			// More conflicts (next commit) or nothing left — the loop re-checks.
		}
		if (!(await rebaseInProgress(git)) && (await unmergedFiles(git)).length === 0) {
			return { ok: true, files: dedupe(touched) };
		}
	}
	return { ok: false, conflict: { reason: "rebase-did-not-terminate", message: "too many conflict steps" } };
}

// ── small git/state helpers ──────────────────────────────────────────────────

async function unmergedFiles(git) {
	const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"]).catch(() => ({ stdout: "" }));
	return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function rebaseInProgress(git) {
	for (const p of ["rebase-merge", "rebase-apply"]) {
		const { stdout } = await git(["rev-parse", "--git-path", p]).catch(() => ({ stdout: "" }));
		const path = stdout.trim();
		if (path && existsSync(path)) return true;
	}
	return false;
}

function dedupe(arr) {
	return [...new Set(arr)];
}

function errText(err) {
	return (err?.stderr?.toString?.() || err?.message || String(err)).trim();
}

function describeConflict(conflict) {
	if (!conflict) return "unresolvable conflict";
	const where = conflict.file ? ` in ${conflict.file}` : "";
	return (
		`unresolvable conflict${where} (${conflict.reason}): ${conflict.message}. ` +
		`The two changes are genuinely mutually exclusive; a human must reconcile them.`
	);
}
