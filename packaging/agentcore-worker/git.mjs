// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Git + GitHub helpers for the Cloud Mode AgentCore worker.
 *
 * Mirrors the old entrypoint.sh flow, but in-process so the runtime server can
 * drive it around a live pi AgentSession:
 *   1. Mint a short-lived GitHub App installation token (App creds from env,
 *      injected by AgentCore from Secrets Manager).
 *   2. Configure git + gh to use it.
 *   3. Clone the target repo + create a dedicated worktree/branch per story.
 *   4. After the agent finishes: commit / push / open a PR.
 */

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

import { gitEnv, setGitToken } from "./git-auth.mjs";
import { integrateToMain } from "./integrate.mjs";
import { grantUntrustedAccess } from "./sandbox.mjs";
import { makeValidator } from "./validate.mjs";

const execFileAsync = promisify(execFile);

/** Empty, non-writable hooks path: repository hooks never run for our git calls. */
const NO_HOOKS_DIR = process.env.CLOUD_MODE_NO_HOOKS_DIR ?? "/opt/cloud-mode-nohooks";

/**
 * Build the validation gate for the integration loop. Delegates to the
 * project-agnostic validator in ./validate.mjs: an explicit
 * CLOUD_MODE_VALIDATE_CMD is used verbatim; otherwise the ecosystem is
 * auto-detected from the worktree; an unknown stack is a no-op pass.
 */

/**
 * Attribution trailer for commits and PR bodies (threat model T-009 / M-024).
 *
 * Every GitHub write is made by the shared GitHub App, so a commit on its own
 * cannot say who caused it. Stamping the story id, the AgentCore session id and
 * the delegating principal (as reported by the client) turns
 * "unattributable change" into a one-hop CloudTrail lookup: search
 * `InvokeAgentRuntime` for that session id.
 */
export function attributionTrailer({ storyId, sessionId, delegatedBy } = {}) {
	const lines = [`Cloud-Mode-Story: ${storyId ?? "unknown"}`];
	if (sessionId) lines.push(`Cloud-Mode-Session: ${sessionId}`);
	lines.push(`Cloud-Mode-Delegated-By: ${delegatedBy ?? "unknown"}`);
	return lines.join("\n");
}

function b64url(buf) {
	return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a GitHub App JWT (RS256) signed with the App private key. */
function buildAppJwt(appId, privateKeyPem) {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
	const unsigned = `${header}.${payload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsigned);
	signer.end();
	const sig = b64url(signer.sign(privateKeyPem));
	return `${unsigned}.${sig}`;
}

/** Exchange the App JWT for an installation access token. */
export async function mintInstallationToken({ appId, installationId, privateKey }) {
	const jwt = buildAppJwt(appId, privateKey);
	const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "cloud-mode-worker",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to mint installation token: ${res.status} ${body}`);
	}
	const data = await res.json();
	if (!data.token) throw new Error("Installation token response had no token");
	return data.token;
}

async function run(cmd, args, opts = {}) {
	const { stdout, stderr } = await execFileAsync(cmd, args, {
		maxBuffer: 32 * 1024 * 1024,
		...opts,
		env: gitEnv(opts.env ?? {}),
	});
	return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Configure git + `gh` to authenticate with the installation token.
 *
 * The token is never written into git configuration or a credential file. It is
 * held in this process's memory and handed to git through a `GIT_ASKPASS` helper
 * (a tiny script that echoes an env var), so it exists only in the environment of
 * the specific git child processes the orchestrator spawns. Untrusted code runs
 * as another OS user with an allow-listed environment (sandbox.mjs), so it can
 * neither read the helper's env nor invoke it usefully.
 *
 * This replaces the previous `url.https://x-access-token:<token>@github.com/.insteadOf`
 * rewrite in `~/.gitconfig` — world-readable ambient configuration that any
 * process in the container could read (threat model T-012 / M-012c, M-026).
 *
 * Also pins `core.hooksPath` to an empty directory so a repository-supplied git
 * hook can never execute in the orchestrator's context (threat model T-018).
 */
export async function configureGitAuth(token, { tokenDir, hooksDir = NO_HOOKS_DIR } = {}) {
	// `gh` reads GH_TOKEN from this process's environment only; untrusted children
	// get an allow-listed environment that excludes it (sandbox.mjs).
	process.env.GH_TOKEN = token;
	process.env.GIT_TERMINAL_PROMPT = "0";
	setGitToken(token, tokenDir ? { tokenDir } : {});

	await removeTokenBearingUrlRewrites();
	// Drop credential helpers a previous image may have configured.
	await run("git", ["config", "--global", "--unset-all", "credential.helper"]).catch(() => {});
	mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
	await run("git", ["config", "--global", "core.hooksPath", hooksDir]);
	await run("git", ["config", "--global", "user.name", "god-agent[bot]"]);
	await run("git", ["config", "--global", "user.email", "god-agent[bot]@users.noreply.github.com"]);
}

/**
 * Drop any `url.<...>.insteadOf` rewrites left in the global config (e.g. by an
 * earlier image that embedded the token there). Best-effort: a missing section
 * is not an error.
 */
async function removeTokenBearingUrlRewrites() {
	const { stdout } = await run("git", ["config", "--global", "--get-regexp", "^url\\."]).catch(() => ({ stdout: "" }));
	const sections = new Set(
		stdout
			.split("\n")
			.map((line) => /^(url\..*)\.insteadof\b/i.exec(line.trim())?.[1])
			.filter(Boolean),
	);
	for (const section of sections) {
		await run("git", ["config", "--global", "--remove-section", section]).catch(() => {});
	}
}

/**
 * Clone the repo and add a dedicated worktree/branch for the story.
 *
 * The clone (`workdir`, which holds `.git` and therefore the hooks) stays
 * private to the orchestrator user; only the worktree is opened up to the
 * untrusted user, and the worktree's `.git` pointer file is kept non-writable so
 * untrusted code cannot redirect the git directory (threat model T-018).
 *
 * Returns { workdir, worktree, branch }.
 */
export async function prepareWorktree({ repoUrl, repoNwo, baseBranch, storyId, root }) {
	const repoName = repoNwo.split("/").pop();
	const workdir = `${root}/${repoName}`;
	const worktree = `${root}/story-${storyId}`;
	const branch = `feature/${storyId}`;

	await run("git", ["clone", "--branch", baseBranch, repoUrl, workdir]);
	await run("git", ["worktree", "add", "-b", branch, worktree, baseBranch], { cwd: workdir });
	await grantUntrustedAccess({
		// mkdtemp creates the session root as 0700; the untrusted user needs to
		// traverse it (but not list it) to reach the worktree.
		traverse: [root],
		paths: [worktree],
		deny: [`${worktree}/.git`],
		log: (m) => console.log(m),
	});
	return { workdir, worktree, branch };
}

/**
 * Commit any leftover changes, push, and open a PR.
 * Returns { pushed, prUrl?, ahead } — pushed is false when the branch produced
 * no commits (nothing to open a PR for).
 */
/**
 * Commit any leftover changes and push HEAD to the target branch. Returns
 * { pushed, ahead }. Safe to call repeatedly (once per CI fix iteration):
 * subsequent pushes update the already-open PR in place.
 */
export async function commitAndPush({ worktree, branch, baseBranch, title, trailer }) {
	const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: worktree });
	if (status.trim()) {
		await run("git", ["add", "-A"], { cwd: worktree });
		await run("git", ["commit", "-m", trailer ? `${title}\n\n${trailer}` : title], { cwd: worktree });
	} else {
		// Nothing left to commit. If the branch tip is a `wip:` checkpoint (see
		// checkpointPush), the branch would otherwise be delivered under a
		// checkpoint message. Put a properly titled (empty) commit on top instead of
		// rewriting history: it keeps the push fast-forward and leaves the
		// checkpoints intact as the audit trail of the run.
		const { stdout: subject } = await run("git", ["log", "-1", "--format=%s"], { cwd: worktree });
		if (/^wip\(/.test(subject.trim())) {
			await run("git", ["commit", "--allow-empty", "-m", trailer ? `${title}\n\n${trailer}` : title], {
				cwd: worktree,
			});
		}
	}

	// Count commits on the worktree's actual HEAD relative to the base branch.
	// We deliberately compare HEAD (not the named branch): a misbehaving agent may
	// have checked out its own branch and committed there, in which case the named
	// `branch` ref still points at base. Using HEAD ensures we detect that work.
	const { stdout: aheadOut } = await run("git", ["rev-list", "--count", `${baseBranch}..HEAD`], { cwd: worktree });
	const ahead = Number(aheadOut.trim() || "0");
	if (ahead === 0) return { pushed: false, ahead: 0 };

	// Push the worktree's HEAD explicitly to the target branch (HEAD:branch) so the
	// commits land on `branch` regardless of which local branch HEAD is on. This
	// avoids the "No commits between base and branch" PR failure when the agent
	// committed on a branch other than the pipeline's feature branch.
	await run("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd: worktree });
	return { pushed: true, ahead };
}

/**
 * Push whatever the agent has produced *so far* to the feature branch, as a
 * `wip:` commit. Called on a timer while the agent is still running.
 *
 * Why: until this existed, a run that died mid-flight left no branch, no PR and
 * no error — the coordinator could not tell "slow" from "dead", and the work of
 * an aborted run was lost with the container (friction class 4: 4 of 15 runs).
 * With a checkpoint push, liveness is observable from outside (the branch moves)
 * and a killed run leaves its partial work behind to be picked up.
 *
 * Deliberately tolerant: a checkpoint is a convenience, never a gate. Any
 * failure (dirty index race with the agent, transient network) is reported to
 * `log` and swallowed — the final `commitAndPush` remains the authority.
 *
 * Returns { pushed, sha? }.
 */
export async function checkpointPush({ worktree, branch, baseBranch, storyId, seq = 1, runner = run }) {
	const { stdout: status } = await runner("git", ["status", "--porcelain"], { cwd: worktree });
	if (status.trim()) {
		await runner("git", ["add", "-A"], { cwd: worktree });
		// `--no-verify`: repo hooks are the delivery gate's business, not the
		// checkpoint's — a failing pre-commit hook must not cost us liveness.
		// The message carries no flag markers on purpose: plinth-style guards read
		// the *range* of messages, so a neutral wip line can neither satisfy nor
		// violate a dark-launch claim.
		await runner(
			"git",
			["commit", "--no-verify", "-m", `wip(${storyId}): checkpoint ${seq} [skip ci]`],
			{ cwd: worktree },
		);
	}

	const { stdout: aheadOut } = await runner("git", ["rev-list", "--count", `${baseBranch}..HEAD`], { cwd: worktree });
	if (Number(aheadOut.trim() || "0") === 0) return { pushed: false };

	// Fast-forward-only: if something else already advanced the feature branch we
	// do not fight it from a background timer.
	await runner("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd: worktree });
	const { stdout: sha } = await runner("git", ["rev-parse", "HEAD"], { cwd: worktree });
	return { pushed: true, sha: sha.trim() };
}

/**
 * Run `checkpointPush` every `intervalMs` until stopped. Returns { stop() },
 * which awaits an in-flight checkpoint so it cannot race the final commit.
 */
export function startCheckpointPusher({
	worktree,
	branch,
	baseBranch,
	storyId,
	intervalMs = 3 * 60_000,
	log = () => {},
	push = checkpointPush,
}) {
	let stopped = false;
	let seq = 0;
	let inFlight = Promise.resolve();
	let timer;

	const tick = async () => {
		if (stopped) return;
		inFlight = (async () => {
			try {
				const r = await push({ worktree, branch, baseBranch, storyId, seq: seq + 1 });
				if (r?.pushed) log({ event: "checkpoint", seq: ++seq, branch, sha: r.sha });
			} catch (err) {
				log({ event: "checkpoint-failed", reason: errText(err) });
			}
		})();
		await inFlight;
		if (!stopped) timer = setTimeout(tick, intervalMs).unref?.() ?? undefined;
	};

	timer = setTimeout(tick, intervalMs);
	timer.unref?.();

	return {
		async stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			await inFlight;
		},
	};
}

/**
 * Wait for the PR's CI checks to conclude, polling `gh pr checks` until nothing
 * is pending or the timeout elapses. Returns:
 *   { state: "pass" | "fail" | "none" | "timeout", failing?, failingLogs? }
 */
export async function waitForChecks({ worktree, branch, timeoutMs = 15 * 60_000, pollMs = 15_000 }) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { stdout } = await run(
			"gh",
			["pr", "checks", branch, "--json", "state,bucket,name,link"],
			{ cwd: worktree },
		)
			// `gh pr checks` exits non-zero while pending/failing; keep its stdout.
			.catch((e) => ({ stdout: e.stdout?.toString?.() ?? "" }));
		let checks = [];
		try {
			checks = JSON.parse(stdout || "[]");
		} catch {
			/* no parseable checks yet */
		}
		if (checks.length === 0) return { state: "none" };
		const pending = checks.some((c) => c.bucket === "pending");
		if (!pending) {
			const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
			if (failing.length === 0) return { state: "pass" };
			return { state: "fail", failing, failingLogs: await collectFailingLogs(worktree, failing) };
		}
		if (Date.now() > deadline) return { state: "timeout" };
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

/** Pull the failed-step logs for the runs behind the failing checks (capped). */
async function collectFailingLogs(worktree, failing, maxChars = 8000) {
	const runIds = new Set();
	for (const c of failing) {
		const m = /\/actions\/runs\/(\d+)/.exec(c.link ?? "");
		if (m) runIds.add(m[1]);
	}
	let out = "";
	for (const id of runIds) {
		const { stdout } = await run("gh", ["run", "view", id, "--log-failed"], { cwd: worktree }).catch(() => ({
			stdout: "",
		}));
		out += stdout;
		if (out.length >= maxChars) break;
	}
	return out.slice(0, maxChars) || failing.map((c) => `- ${c.name}: ${c.state}`).join("\n");
}

/**
 * Commit any leftover changes, push, and open a PR.
 * Returns { pushed, prUrl?, ahead } — pushed is false when the branch produced
 * no commits (nothing to open a PR for).
 */
export async function finalizeAndOpenPr({
	workdir,
	worktree,
	branch,
	baseBranch,
	storyId,
	userStory,
	/** attribution metadata (M-024) */
	sessionId,
	delegatedBy,
	/** merge strategy for auto-merge: squash | merge | rebase */
	mergeMethod = process.env.CLOUD_MODE_MERGE_METHOD ?? "squash",
	/** set false to open the PR without arming auto-merge (human merges) */
	autoMerge = (process.env.CLOUD_MODE_AUTO_MERGE ?? "1") !== "0",
	runner = run,
}) {
	const title = `feat(${storyId}): ${userStory.slice(0, 72)}`;
	const trailer = attributionTrailer({ storyId, sessionId, delegatedBy });

	const { pushed, ahead } = await commitAndPush({ worktree, branch, baseBranch, title, trailer });
	if (!pushed) return { pushed: false, ahead: 0 };

	const body = `Automated PR by Cloud Mode for story **${storyId}**.

## User Story
${userStory}

_Generated headlessly by a pi sub-agent running on Bedrock AgentCore._

<!-- attribution: correlate with CloudTrail InvokeAgentRuntime on the session id -->
\`\`\`
${trailer}
\`\`\``;

	const { stdout } = await runner(
		"gh",
		["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body", body],
		{ cwd: worktree },
	).catch(async (err) => {
		// A PR for this head may already exist (e.g. retry, or the agent opened one).
		// Fall back to looking it up rather than failing the whole pipeline.
		const { stdout: existing } = await runner(
			"gh",
			["pr", "view", branch, "--json", "url", "--jq", ".url"],
			{ cwd: worktree },
		).catch(() => ({ stdout: "" }));
		if (existing.trim()) return { stdout: existing };
		throw err;
	});
	const prUrl = (stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) ?? [])[0];

	// Arm GitHub auto-merge so the PR lands by itself the moment the required
	// checks are green and the branch is up to date. This is the safe equivalent
	// of "direct merge": review-free, but a red or stale result can never land
	// because the server-side branch protection still gates it.
	let auto = { armed: false };
	if (autoMerge) auto = await enableAutoMerge({ worktree, branch, mergeMethod, runner });

	return { pushed: true, ahead, prUrl, autoMerge: auto.armed, autoMergeError: auto.error };
}

/**
 * Arm GitHub's auto-merge for the PR of `branch`.
 *
 * Best-effort by design: auto-merge must be enabled in the repository settings
 * and the branch must be protected, otherwise `gh` fails. A failure is NOT
 * fatal — `ensurePrMerged()` then merges explicitly once CI is green.
 *
 * Returns { armed: boolean, error?: string }.
 */
export async function enableAutoMerge({ worktree, branch, mergeMethod = "squash", runner = run }) {
	try {
		await runner("gh", ["pr", "merge", branch, "--auto", `--${mergeMethod}`], { cwd: worktree });
		return { armed: true };
	} catch (err) {
		return { armed: false, error: errText(err) };
	}
}

/**
 * Make sure the PR actually lands, without ever forcing a red or stale merge.
 *
 * Landing a PR under "require green checks + require branch up to date"
 * (`strict`) is a read-modify-write against a branch other agents keep moving,
 * so it needs the same optimistic retry shape as the direct-merge CAS loop:
 *
 *   - MERGED                    → done (auto-merge may have won the race).
 *   - CLEAN / HAS_HOOKS         → merge now.
 *   - BEHIND                    → the base moved: `gh pr update-branch`, then the
 *                                 caller re-waits for CI on the new merge result.
 *   - BLOCKED / UNSTABLE / UNKNOWN → checks still settling or protection not yet
 *                                 satisfied: poll again (bounded).
 *   - DIRTY                     → genuine conflict with the base; report, never force.
 *
 * Returns { merged, state, updatedBranch, reason? }. `updatedBranch: true` tells
 * the caller "I rebased onto the new base — wait for CI again, then call me".
 */
export async function ensurePrMerged({
	worktree,
	branch,
	mergeMethod = process.env.CLOUD_MODE_MERGE_METHOD ?? "squash",
	maxAttempts = Number(process.env.CLOUD_MODE_MERGE_MAX_ATTEMPTS ?? 8),
	pollMs = Number(process.env.CLOUD_MODE_MERGE_POLL_MS ?? 15_000),
	runner = run,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	log = () => {},
}) {
	let lastState = "UNKNOWN";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const pr = await prStatus({ worktree, branch, runner });
		lastState = pr.mergeStateStatus ?? "UNKNOWN";
		log({ event: "merge-poll", attempt, state: pr.state, mergeStateStatus: lastState });

		if (pr.state === "MERGED") return { merged: true, state: lastState, updatedBranch: false };
		if (pr.state === "CLOSED") {
			return { merged: false, state: lastState, updatedBranch: false, reason: "pull request was closed" };
		}

		if (lastState === "DIRTY") {
			return {
				merged: false,
				state: lastState,
				updatedBranch: false,
				reason: "pull request conflicts with the base branch; a human must reconcile it",
			};
		}

		if (lastState === "BEHIND") {
			// The base advanced. Update the PR branch and hand control back so the
			// caller re-runs the CI gate against the new merge result.
			try {
				await runner("gh", ["pr", "update-branch", branch], { cwd: worktree });
				log({ event: "merge-branch-updated", attempt });
				return { merged: false, state: lastState, updatedBranch: true };
			} catch (err) {
				log({ event: "merge-update-failed", attempt, reason: errText(err) });
				await sleep(pollMs);
				continue;
			}
		}

		if (lastState === "CLEAN" || lastState === "HAS_HOOKS") {
			try {
				await runner("gh", ["pr", "merge", branch, `--${mergeMethod}`], { cwd: worktree });
				log({ event: "merged", attempt, mergeMethod });
				return { merged: true, state: lastState, updatedBranch: false };
			} catch (err) {
				// Lost the race (base moved between status and merge) or protection not
				// satisfied yet → re-poll rather than force.
				log({ event: "merge-rejected", attempt, reason: errText(err) });
			}
		}

		if (attempt < maxAttempts) await sleep(pollMs);
	}
	return {
		merged: false,
		state: lastState,
		updatedBranch: false,
		reason: `pull request did not become mergeable within ${maxAttempts} attempts (last state: ${lastState})`,
	};
}

/** Read the PR's state + mergeability for `branch`. */
async function prStatus({ worktree, branch, runner = run }) {
	const { stdout } = await runner(
		"gh",
		["pr", "view", branch, "--json", "state,mergeStateStatus,mergeable,url,number"],
		{ cwd: worktree },
	).catch((e) => ({ stdout: e.stdout?.toString?.() ?? "" }));
	try {
		return JSON.parse(stdout || "{}");
	} catch {
		return {};
	}
}

function errText(err) {
	return (err?.stderr?.toString?.() || err?.message || String(err)).trim();
}

/**
 * Build the actionable error surfaced when a direct-merge push is rejected
 * (branch protection, a required status check, or a protected default branch).
 * We never silently fall back to a PR — the operator must see why it was blocked.
 */
function directMergeBlockedError(baseBranch, detail) {
	return (
		`direct-merge to '${baseBranch}' was rejected by GitHub.\n` +
		`${(detail || "").trim()}\n` +
		`This usually means branch protection or a required status check is still enforced on ` +
		`'${baseBranch}'. Either exempt the Cloud Mode GitHub App from that rule, or set ` +
		`"deliveryMode": "pull-request" in .pi/cloud-mode.json.`
	);
}

/**
 * Deliver the story by landing its commit(s) directly on the repo's default
 * branch — no PR (deliveryMode: "direct-merge").
 *
 * Delegates to the optimistic, decentralized `integrateToMain()` CAS-retry loop
 * (see integrate.mjs): commit any leftover changes, then rebase HEAD onto the
 * latest `origin/baseBranch` and `git push --ff-only`. Concurrent stories
 * racing the same branch collide two ways — a timing race (non-ff push, retried
 * with backoff) or a content conflict (resolved intent-preservingly, then
 * re-validated). Pass `resolveConflict` to plug in a resolver (the worker
 * injects an LLM-backed one); omitted, the deterministic union resolver is used.
 * A validation failure or a genuine semantic contradiction aborts loudly;
 * branch-protection / required-check rejections are surfaced via
 * directMergeBlockedError, never downgraded to a PR.
 *
 * Returns { pushed, ahead, commitSha? } — pushed is false when there were no
 * commits to land.
 */
export async function finalizeDirectMerge({
	worktree,
	baseBranch,
	storyId,
	userStory,
	/** attribution metadata (M-024) */
	sessionId,
	delegatedBy,
	// Back-compat: callers/tests may pass `maxRetries`; `maxAttempts` is preferred.
	maxRetries,
	maxAttempts,
	validate,
	resolveConflict,
	repairValidation,
	maxRepairAttempts,
	log,
}) {
	const title = `feat(${storyId}): ${userStory.slice(0, 72)}`;
	const trailer = attributionTrailer({ storyId, sessionId, delegatedBy });

	const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: worktree });
	if (status.trim()) {
		await run("git", ["add", "-A"], { cwd: worktree });
		await run("git", ["commit", "-m", `${title}\n\n${trailer}`], { cwd: worktree });
	}

	const { stdout: aheadOut } = await run("git", ["rev-list", "--count", `${baseBranch}..HEAD`], { cwd: worktree });
	const ahead = Number(aheadOut.trim() || "0");
	if (ahead === 0) return { pushed: false, ahead: 0 };

	const attempts =
		maxAttempts ?? maxRetries ?? Number(process.env.CLOUD_MODE_MAX_INTEGRATION_ATTEMPTS ?? 8);

	// The decentralized, optimistic CAS-retry integration loop resolves same-line
	// conflicts intent-preservingly, gates on validation before pushing, and
	// retries only non-fast-forward races (never force-pushes).
	const result = await integrateToMain({
		cwd: worktree,
		remote: "origin",
		branch: baseBranch,
		maxAttempts: attempts,
		validate: validate ?? makeValidator(worktree, log ? { log } : {}),
		...(resolveConflict ? { resolveConflict } : {}),
		...(repairValidation ? { repairValidation } : {}),
		...(maxRepairAttempts != null ? { maxRepairAttempts } : {}),
		...(log ? { log } : {}),
	});

	if (result.ok) {
		return { pushed: true, ahead, commitSha: result.commitSha, attempts: result.attemptsUsed };
	}

	// Map the structured failure onto the operator-facing message.
	if (result.status === "unresolvable-conflict" || result.status === "validation-failed") {
		throw new Error(
			`direct-merge to '${baseBranch}' aborted after ${result.attemptsUsed} attempt(s): ${result.reason}`,
		);
	}
	if (result.status === "exhausted") {
		throw new Error(
			`direct-merge to '${baseBranch}' failed after ${result.attemptsUsed} attempts (non-fast-forward race did not settle). ` +
				`Details: ${(result.reason ?? "").trim()}`,
		);
	}
	// push-failed: protected branch / required check / auth / hook / network.
	throw new Error(directMergeBlockedError(baseBranch, result.pushStderr ?? result.reason ?? ""));
}

/** Best-effort worktree cleanup so the container leaves nothing behind. */
export async function cleanupWorktree({ workdir, worktree }) {
	try {
		await run("git", ["worktree", "remove", "--force", worktree], { cwd: workdir });
	} catch {
		/* best effort */
	}
}
