// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentCore remote-agent worker — the container half of the contract in
 * `docs/request-for-change/rfc-agentcore-remote-agents.md` ("The worker
 * contract"). That section is authoritative; this file implements it and does
 * not re-derive it from the cloud-mode reference worker it was vendored from.
 *
 * Container contract (Bedrock AgentCore Runtime):
 *   - GET  /ping         → health check.
 *   - POST /invocations  → text/event-stream of contract events.
 *
 * Actions        start | rpc | attach | stop
 * Events         acp | status | usage | history_gap | attach_end | error | done
 *                plus a `: ping` comment keepalive; every hub event carries a
 *                monotonic per-session `seq`.
 *
 * The agent is a `kiro-cli acp` CHILD, not an in-process library. The worker is
 * a pipe with a sequence number on it: it reads the child's stdout line by line
 * and carries each parsed JSON-RPC message out verbatim as one `acp` event, and
 * writes messages from `rpc` to the child's stdin. It never parses an ACP
 * payload beyond extracting metering and noticing the child's session id, and it
 * never asserts a protocol version — `initialize` is forwarded like any other
 * message, because the child answers integer `1` where a local Kiro Crew session
 * sends a date string (Spike C).
 *
 * Four defects of the reference implementation are fixed here, each pinned by a
 * test in `test/server.test.mjs`:
 *   (a) `stop` is real: cooperative `session/cancel`, a bounded wait, then
 *       terminate. The reference had no stop action and fell through to a prompt.
 *   (b) finished sessions are deleted from the session map on a TTL, so the map
 *       cannot grow for the life of the container.
 *   (c) a streaming action subscribes to the hub BEFORE it delivers input, so a
 *       turn streams live instead of only after the turn.
 *   (d) every non-streaming action answers ONE result shape, not a union
 *       discriminated by which fields happen to be present.
 *
 * Credential handling (RFC, "Where the credential lives"): `KIRO_API_KEY` is
 * resolved from Secrets Manager by the ORCHESTRATOR identity and reaches exactly
 * one place — the environment of the agent child. It is never logged, never put
 * in an event, and never placed on a command line: `buildAgentSpawn` strips the
 * sandbox's explicit `env -i NAME=VALUE …` argv prologue and hands the same
 * allow-listed environment to `spawn()` instead, because argv is world-readable
 * through /proc while a process environment is not.
 */

import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { purgeStaticCredentialEnvVars } from "./aws-identity.mjs";
import { Hub } from "./hub.mjs";
import { describeSandbox, initSandbox, shellQuote, untrustedCommand } from "./sandbox.mjs";
import { resolveKiroApiKey } from "./secrets.mjs";
import { MAX_ACTIVE_SESSIONS, admitAction, admitStart } from "./session-guard.mjs";
import { archiveTranscript, transcriptArchivingEnabled } from "./transcript-archive.mjs";

/** AgentCore's required listen port. */
export const PORT = Number(process.env.PORT ?? 8080);
/** AgentCore stamps the session id on this request header. */
export const SID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
/** The platform's own minimum; enforced here so a short id fails loudly. */
export const MIN_SESSION_ID_LENGTH = 33;
/** Comment-keepalive interval; prevents idle resets during a quiet model call. */
export const KEEPALIVE_MS = Number(process.env.WORKER_KEEPALIVE_MS ?? 15_000);
/** How long `stop` waits for the child to honour `session/cancel` before SIGTERM. */
export const CANCEL_GRACE_MS = Number(process.env.WORKER_CANCEL_GRACE_MS ?? 2_000);
/** How long SIGTERM is given before SIGKILL. */
export const TERMINATE_GRACE_MS = Number(process.env.WORKER_TERMINATE_GRACE_MS ?? 5_000);
/** Defect (b): how long a FINISHED session stays readable before it is dropped. */
export const SESSION_TTL_MS = Number(process.env.WORKER_SESSION_TTL_MS ?? 15 * 60_000);
/** How often the TTL sweep runs. */
export const SESSION_SWEEP_MS = Number(process.env.WORKER_SESSION_SWEEP_MS ?? 60_000);
/** The agent, as argv. The image places the binary and its `kiro-cli-chat` sibling. */
export const AGENT_ARGV = (process.env.WORKER_AGENT_CMD ?? "kiro-cli acp").split(/\s+/).filter(Boolean);
/** Bounded tail of child stderr kept for diagnostics (never emitted verbatim). */
const STDERR_TAIL_LINES = 20;

process.umask(0o002);

/* ────────────────────────────── credential hygiene ────────────────────────── */

/** Values that must never appear in a log line or an event. */
const secretValues = new Set();

/** Register a resolved secret so `redact` can scrub it. Never stores empties. */
export function guardSecret(value) {
	if (typeof value === "string" && value.length >= 8) secretValues.add(value);
	return value;
}

/** Replace every registered secret with a marker. Applied to ALL outbound text. */
export function redact(text) {
	let out = String(text ?? "");
	for (const secret of secretValues) {
		if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]");
	}
	return out;
}

/** Reset registered secrets — tests only. */
export function _resetSecretsForTests() {
	secretValues.clear();
}

function log(message) {
	// eslint-disable-next-line no-console
	console.log(redact(message));
}

/* ────────────────────────────── one result shape ──────────────────────────── */

/**
 * Defect (d): ONE shape for every non-streaming answer. All four keys are always
 * present, so a client reads fields rather than inferring meaning from which
 * fields exist. `seq` is the sequence number of the `status` event that records
 * the attempt (0 when nothing was recorded), which is what makes an approval
 * locatable in the same sequence space as the transcript it belongs to.
 *
 * @returns {{ action: string, delivered: boolean, seq: number, reason: string|null }}
 */
export function actionResult({ action, delivered = false, seq = 0, reason = null } = {}) {
	return {
		action: String(action ?? "unknown"),
		delivered: Boolean(delivered),
		seq: Number.isFinite(seq) ? Number(seq) : 0,
		reason: reason === null || reason === undefined ? null : redact(String(reason)),
	};
}

/* ────────────────────────────── isolation ─────────────────────────────────── */

/**
 * Establish the execution boundary once per container and report the posture.
 *
 * Unlike the reference worker there is no loopback AWS credential broker: this
 * agent authenticates to its model with `KIRO_API_KEY`, so there is no AWS model
 * traffic to vend a scoped role for. Rung 1 of that design is kept — no static
 * AWS credential is ever left in this process's environment — and Secrets
 * Manager keeps using the orchestrator identity explicitly (secrets.mjs).
 */
let isolationPromise;
export function ensureIsolation() {
	isolationPromise ??= (async () => {
		const purged = purgeStaticCredentialEnvVars({ log });
		const sandbox = await initSandbox({ log });
		return {
			sandboxMode: sandbox.mode,
			sandbox: describeSandbox(sandbox),
			purgedCredentialEnvVars: purged.length,
		};
	})();
	return isolationPromise;
}

/** Reset memoised isolation — tests only. */
export function _resetIsolationForTests() {
	isolationPromise = undefined;
}

/* ────────────────────────────── the agent child ───────────────────────────── */

/**
 * Build the spawn arguments for the agent child.
 *
 * The command goes through `sandbox.mjs`'s `untrustedCommand`, so the child runs
 * as the unprivileged user with an allow-listed environment wherever the
 * platform permits a privilege drop. The one transformation: that helper renders
 * the environment as an explicit `/usr/bin/env -i NAME=VALUE …` argv prologue,
 * which would publish `KIRO_API_KEY` in `/proc/<pid>/cmdline`. The prologue is
 * removed and the identical environment — the helper's own `untrustedEnv()`
 * output — is handed to `spawn()` instead. The privilege-drop wrappers pass an
 * environment through, so the child sees exactly the same names either way.
 *
 * @param {object} opts
 * @param {string} opts.cwd            working directory for the agent
 * @param {string} [opts.apiKey]       model credential; env-only, never argv
 * @param {string[]} [opts.argv]       the agent command
 * @returns {{ file: string, args: string[], env: Record<string,string>, cwd: string, mode: string }}
 */
export function buildAgentSpawn({ cwd, apiKey, argv = AGENT_ARGV }) {
	if (!Array.isArray(argv) || argv.length === 0) throw new Error("agent argv is empty");
	const command = `exec ${argv.map(shellQuote).join(" ")}`;
	const built = untrustedCommand(command);
	const env = { ...built.env };
	if (apiKey) {
		guardSecret(apiKey);
		env.KIRO_API_KEY = apiKey;
	}
	return {
		file: built.file,
		args: stripEnvPrologue(built.args),
		env,
		cwd,
		mode: built.mode,
		strategy: built.strategy,
	};
}

/**
 * Drop a `/usr/bin/env -i NAME=VALUE …` prologue from a sandbox argv, keeping
 * the privilege-drop prefix and the `/bin/bash -c <script>` tail. A no-op on the
 * same-uid argv, which carries no prologue.
 */
export function stripEnvPrologue(args) {
	const i = args.findIndex((a) => a === "/usr/bin/env" || a === "env");
	if (i === -1 || args[i + 1] !== "-i") return [...args];
	let j = i + 2;
	while (j < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j])) j += 1;
	return [...args.slice(0, i), ...args.slice(j)];
}

/**
 * One `kiro-cli acp` child, wrapped so the worker can carry its traffic.
 *
 * Deliberately thin: stdout lines become `acp` events verbatim, metering becomes
 * a derived `usage` event, and the child's own `session/new` result is watched
 * for a session id so `stop` has something to cancel. Nothing else is
 * interpreted, so the ACP vocabulary can move without touching this file.
 */
export class AgentChild {
	/**
	 * @param {object} opts
	 * @param {import("./hub.mjs").Hub} opts.hub
	 * @param {string} opts.cwd
	 * @param {string} [opts.apiKey]
	 * @param {(file: string, args: string[], options: object) => any} [opts.spawn]  test seam
	 * @param {(event: object) => void} [opts.onTerminal]
	 */
	constructor({ hub, cwd, apiKey, argv, spawn = spawnProcess, onTerminal = () => {} }) {
		this.hub = hub;
		this.cwd = cwd;
		this.apiKey = apiKey;
		this.argv = argv;
		this._spawn = spawn;
		this._onTerminal = onTerminal;
		this.proc = undefined;
		/** The child's own ACP session id, learned from its `session/new` result. */
		this.acpSessionId = undefined;
		this.exitCode = undefined;
		this.exited = false;
		this.stderrTail = [];
		this._nextId = 10_000;
	}

	get pid() {
		return this.proc?.pid;
	}

	get alive() {
		return Boolean(this.proc) && !this.exited;
	}

	/** Spawn the child and wire its streams to the hub. */
	start() {
		const spec = buildAgentSpawn({ cwd: this.cwd, apiKey: this.apiKey, argv: this.argv });
		this.hub.emit({
			type: "status",
			phase: "launching",
			// The credential is NOT in argv — see buildAgentSpawn. Naming the file is
			// safe and is the only way an operator can tell which posture ran.
			command: spec.file,
			sandboxMode: spec.mode,
		});
		this.proc = this._spawn(spec.file, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.hub.emit({ type: "status", phase: "child_started", pid: this.proc.pid });

		if (this.proc.stdout) {
			createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on("line", (line) =>
				this._onLine(line),
			);
		}
		if (this.proc.stderr) {
			createInterface({ input: this.proc.stderr, crlfDelay: Infinity }).on("line", (line) => {
				this.stderrTail.push(redact(line));
				if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
				log(`[worker] agent stderr: ${line}`);
			});
		}
		this.proc.on("error", (err) => {
			this.hub.emit({ type: "error", fatal: true, message: redact(`agent spawn failed: ${err?.message ?? err}`) });
			this._onTerminal({ type: "done", stopReason: "spawn_failed", exitCode: null });
		});
		this.proc.on("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code ?? null;
			this.hub.emit({ type: "status", phase: "child_exit", exitCode: this.exitCode, signal: signal ?? null });
			this._onTerminal({ type: "done", stopReason: "child_exit", exitCode: this.exitCode, signal: signal ?? null });
		});
		return this;
	}

	/** Carry one raw child line out, and derive the two things the worker needs. */
	_onLine(raw) {
		const line = String(raw).trim();
		if (!line) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			// Non-fatal: the session stays live. A single unparsable line is a child
			// diagnostic, not a protocol failure, and the raw text is redacted and
			// truncated rather than dropped so an operator can still see it.
			this.hub.emit({
				type: "error",
				fatal: false,
				message: "unparsable line from the agent child",
				raw: redact(line).slice(0, 500),
			});
			return;
		}

		// The contract carries ACP verbatim. Nothing below rewrites the payload.
		this.hub.emit({ type: "acp", payload: msg });

		const params = msg && typeof msg.params === "object" && msg.params ? msg.params : {};
		const result = msg && typeof msg.result === "object" && msg.result ? msg.result : undefined;

		const usage = deriveUsage(params);
		if (usage) this.hub.emit(usage);

		if (result && typeof result.sessionId === "string") this.acpSessionId = result.sessionId;

		if (result && "stopReason" in result) {
			this.hub.emit({ type: "status", phase: "turn_end", stopReason: result.stopReason });
			this._onTerminal({ type: "done", stopReason: String(result.stopReason) });
		}
	}

	/**
	 * Write one JSON-RPC message to the child's stdin.
	 * @returns {{ ok: boolean, reason: string|null }}
	 */
	write(message) {
		if (!this.proc?.stdin || this.exited || this.proc.stdin.destroyed) {
			return { ok: false, reason: "the agent child is not accepting input" };
		}
		try {
			this.proc.stdin.write(`${JSON.stringify(message)}\n`);
			return { ok: true, reason: null };
		} catch (err) {
			return { ok: false, reason: `stdin write failed: ${err?.message ?? err}` };
		}
	}

	/**
	 * Defect (a): a REAL stop. Cooperative cancel first so the child can unwind a
	 * tool call, then a bounded wait, then SIGTERM, then SIGKILL. Never a prompt,
	 * and never a silent no-op: the caller gets a reason back either way.
	 */
	async cancelAndTerminate({ cancelGraceMs = CANCEL_GRACE_MS, terminateGraceMs = TERMINATE_GRACE_MS, wait = waitFor } = {}) {
		if (!this.proc) return { cancelled: false, terminated: false, reason: "no child" };
		let cancelled = false;
		if (this.alive && this.acpSessionId) {
			const sent = this.write({
				jsonrpc: "2.0",
				id: ++this._nextId,
				method: "session/cancel",
				params: { sessionId: this.acpSessionId },
			});
			cancelled = sent.ok;
			if (sent.ok) await wait(() => this.exited, cancelGraceMs);
		}
		if (this.exited) return { cancelled, terminated: false, exitCode: this.exitCode, reason: null };

		this.proc.kill("SIGTERM");
		await wait(() => this.exited, terminateGraceMs);
		if (!this.exited) this.proc.kill("SIGKILL");
		return { cancelled, terminated: true, exitCode: this.exitCode, reason: null };
	}
}

/**
 * Derive the advisory `usage` event from a child metering frame.
 *
 * The RFC is explicit that `usage` is advisory and NEVER the billing record —
 * the same credits are already inside the `acp` frame this is derived from, so a
 * client that sums both double-counts. `advisory: true` is on the wire so that
 * property is visible to a client that never read the RFC.
 */
export function deriveUsage(params) {
	const metering = params?.meteringUsage;
	if (!Array.isArray(metering) || metering.length === 0) return undefined;
	let credits = 0;
	for (const entry of metering) {
		const value = Number(entry && typeof entry === "object" ? entry.value : entry);
		if (Number.isFinite(value)) credits += value;
	}
	return {
		type: "usage",
		advisory: true,
		credits: Math.round(credits * 1e6) / 1e6,
		entries: metering.length,
		contextUsagePercentage: params.contextUsagePercentage ?? null,
	};
}

/** Poll `predicate` until true or the budget is spent. Injectable for tests. */
export async function waitFor(predicate, timeoutMs, { intervalMs = 25 } = {}) {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	for (;;) {
		if (predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/* ────────────────────────────── session registry ──────────────────────────── */

/**
 * @typedef {{
 *   id: string, hub: Hub, child?: AgentChild, ownerToken?: string,
 *   done: boolean, finishedAt: number|null, terminal: boolean, meta: object,
 *   workspace?: string,
 * }} SessionEntry
 */

/** @type {Map<string, SessionEntry>} */
export const sessions = new Map();

export function createSession(id, { ownerToken, maxHistory } = {}) {
	/** @type {SessionEntry} */
	const entry = {
		id,
		hub: new Hub(maxHistory ? { maxHistory } : undefined),
		child: undefined,
		ownerToken,
		done: false,
		finishedAt: null,
		terminal: false,
		meta: {},
	};
	sessions.set(id, entry);
	return entry;
}

/**
 * Defect (b): drop finished sessions once their history has had a fair chance to
 * be collected. The reference never deleted an entry, so a container that served
 * a thousand short sessions held a thousand bounded histories for its whole life
 * — the per-session bound was there, the per-container one was not. A session
 * that is still running is never swept, whatever its age.
 *
 * @returns {string[]} the ids that were dropped
 */
export function sweepSessions({ now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
	const dropped = [];
	for (const [id, entry] of sessions) {
		if (!entry.done || entry.finishedAt === null) continue;
		if (now - entry.finishedAt < ttlMs) continue;
		entry.hub.close();
		sessions.delete(id);
		dropped.push(id);
	}
	if (dropped.length > 0) log(`[worker] swept ${dropped.length} finished session(s) past their ${ttlMs}ms TTL`);
	return dropped;
}

/** Reset the registry — tests only. */
export function _resetSessionsForTests() {
	for (const entry of sessions.values()) entry.hub.close();
	sessions.clear();
}

/**
 * The single funnel for a terminal event, so a session ends exactly once.
 *
 * A fatal `error` and a `done` are equally final (RFC), so both come through
 * here and whichever arrives first wins. A fatal error also TERMINATES the child
 * before the stream closes — otherwise the container keeps running, and keeps
 * costing, with nobody attached.
 */
export function finishSession(entry, event, { now = Date.now } = {}) {
	if (entry.terminal) return false;
	entry.terminal = true;
	entry.hub.emit(event);
	entry.done = true;
	entry.finishedAt = now();
	return true;
}

/** Emit a fatal error, terminate the child, and close the session. */
export async function failSession(entry, message, { code, terminate = true } = {}) {
	const emitted = finishSession(entry, { type: "error", fatal: true, code: code ?? null, message: redact(message) });
	if (terminate && entry.child?.alive) await entry.child.cancelAndTerminate();
	return emitted;
}

/** Archive the transcript (when configured) and close the hub. */
async function closeSession(entry) {
	if (transcriptArchivingEnabled()) {
		try {
			const result = await archiveTranscript({
				sessionId: entry.id,
				meta: { ...entry.meta, finishedAt: Date.now() },
				events: entry.hub.history,
				log,
			});
			if (result?.archived) entry.hub.emit({ type: "status", phase: "transcript_archived", uri: result.uri });
		} catch (err) {
			log(`[worker] transcript archive failed: ${err?.message ?? err}`);
		}
	}
	entry.hub.close();
}

/* ────────────────────────────── SSE plumbing ──────────────────────────────── */

export function writeSse(res, event) {
	if (res.writableEnded) return;
	try {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	} catch {
		/* response already closed */
	}
}

function writeKeepalive(res) {
	if (res.writableEnded) return;
	try {
		res.write(": ping\n\n");
	} catch {
		/* response already closed */
	}
}

function openSse(res, sid) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		[SID_HEADER]: sid,
	});
}

function isTerminal(event) {
	return event.type === "done" || (event.type === "error" && event.fatal === true);
}

/**
 * Stream a session's events to one response until a terminal event.
 *
 * Defect (c): `deliver` runs AFTER the subscription is in place. The reference
 * awaited a whole turn's delivery and only then subscribed, so a client saw
 * nothing at all until the turn was over — the events were replayed from history
 * afterwards, which is not the same thing as streaming. Subscribing first also
 * closes the race where an event emitted during delivery lands between the two
 * steps.
 */
export async function streamTo(res, { entry, sid, sinceSeq = 0, deliver, keepaliveMs = KEEPALIVE_MS }) {
	openSse(res, sid);

	const ping = setInterval(() => writeKeepalive(res), keepaliveMs);
	ping.unref?.();

	let unsubscribe = () => {};
	const cleanup = () => {
		clearInterval(ping);
		unsubscribe();
	};
	// `let` + no-op default: subscribe() replays history synchronously, so a
	// session that has already finished fires the listener DURING subscribe and
	// reaches cleanup before the assignment lands.
	unsubscribe = entry.hub.subscribe((event) => {
		writeSse(res, event);
		if (isTerminal(event)) {
			cleanup();
			if (!res.writableEnded) res.end();
		}
	}, sinceSeq);

	res.on?.("close", cleanup);

	if (deliver && !res.writableEnded) {
		try {
			await deliver();
		} catch (err) {
			// Non-fatal by default: the delivery failed, the session did not.
			entry.hub.emit({ type: "error", fatal: false, message: redact(`action failed: ${err?.message ?? err}`) });
		}
	}
	return { cleanup };
}

/* ────────────────────────────── actions ───────────────────────────────────── */

/**
 * Prepare the agent's working directory. A repository is cloned only when the
 * caller names one — the default is a scratch workspace, so the common
 * remote-subagent case needs no GitHub credential at all. Repository delivery
 * (branching, pushing, opening a pull request) is WP6's, not this file's.
 */
async function prepareWorkspace(entry, payload) {
	const { repoUrl, repoNwo, baseBranch = "main", storyId } = payload;
	if (!repoUrl || !repoNwo) {
		const workspace = mkdtempSync(join(tmpdir(), "agentcore-worker-"));
		entry.workspace = workspace;
		return { cwd: workspace, cloned: false };
	}
	entry.hub.emit({ type: "status", phase: "authenticating" });
	const [{ resolveGitHubAppCreds }, git] = await Promise.all([import("./secrets.mjs"), import("./git.mjs")]);
	const creds = await resolveGitHubAppCreds();
	const token = await git.mintInstallationToken(creds);
	guardSecret(token);
	await git.configureGitAuth(token);
	entry.hub.emit({ type: "status", phase: "cloning", repoNwo, baseBranch });
	const root = mkdtempSync(join(tmpdir(), "agentcore-worker-"));
	const info = await git.prepareWorktree({ repoUrl, repoNwo, baseBranch, storyId: storyId ?? entry.id, root });
	entry.workspace = info.worktree;
	entry.meta.branch = info.branch;
	return { cwd: info.worktree, cloned: true, worktreeInfo: info };
}

/**
 * `start`: launch the agent child, then stream. The handshake is NOT performed
 * here — the client drives `initialize`, `session/new` and `session/prompt`
 * through `rpc`, and the worker forwards them, so no protocol version is
 * asserted anywhere in this container.
 */
export async function startSession(entry, payload, { spawn, resolveApiKey = resolveKiroApiKey } = {}) {
	Object.assign(entry.meta, {
		startedAt: Date.now(),
		sessionId: entry.id,
		repoNwo: payload.repoNwo,
		delegatedBy: typeof payload.delegatedBy === "string" ? payload.delegatedBy.slice(0, 256) : undefined,
	});
	try {
		const isolation = await ensureIsolation();
		entry.meta.sandboxMode = isolation.sandboxMode;
		entry.hub.emit({ type: "status", phase: "isolation", ...isolation });

		const { cwd } = await prepareWorkspace(entry, payload);
		// Resolved here and handed straight to the child's env. Not returned, not
		// logged, not stored on the entry, not in any event.
		const apiKey = await resolveApiKey();
		const child = new AgentChild({
			hub: entry.hub,
			cwd,
			apiKey,
			spawn,
			onTerminal: (event) => {
				if (finishSession(entry, event)) void closeSession(entry);
			},
		});
		entry.child = child;
		child.start();
		entry.hub.emit({ type: "status", phase: "agent_ready", cwd });
	} catch (err) {
		await failSession(entry, `start failed: ${err?.message ?? err}`, { code: "start_failed" });
		await closeSession(entry);
	}
}

/**
 * `rpc`: deliver ONE JSON-RPC message to the child's stdin.
 *
 * Answers the one result shape with `delivered` and the `seq` of the status
 * event that records the attempt, so a client that reconnects mid-approval can
 * tell a delivered message from a dropped one. A failed delivery is also
 * recorded in the sequence space — a silent drop is exactly the case the RFC
 * says a client must be able to detect.
 */
export function deliverRpc(entry, message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) {
		return actionResult({ action: "rpc", delivered: false, reason: "rpc requires a JSON-RPC `message` object" });
	}
	if (!entry.child) {
		return actionResult({ action: "rpc", delivered: false, reason: "the agent child has not been started" });
	}
	const outcome = entry.child.write(message);
	const status = {
		type: "status",
		phase: outcome.ok ? "rpc_delivered" : "rpc_dropped",
		rpcId: message.id ?? null,
		method: typeof message.method === "string" ? message.method : null,
		delivered: outcome.ok,
	};
	if (!outcome.ok) status.reason = redact(outcome.reason ?? "unknown");
	// A closed hub (the session already reached a terminal event) accepts nothing,
	// so `seq` must be 0 rather than the sequence number of somebody else's event:
	// a client using it to locate its own delivery would otherwise be misled.
	const seqBefore = entry.hub.seq;
	entry.hub.emit(status);
	const seq = entry.hub.seq > seqBefore ? entry.hub.seq : 0;
	if (!outcome.ok) {
		entry.hub.emit({ type: "error", fatal: false, message: redact(`rpc not delivered: ${outcome.reason}`) });
	}
	return actionResult({
		action: "rpc",
		delivered: outcome.ok,
		seq,
		reason: outcome.ok ? null : (outcome.reason ?? "the session has ended"),
	});
}

/**
 * `attach`: read-only replay of everything after `sinceSeq`, then the
 * `attach_end` sentinel, then end.
 *
 * The sentinel carries `live` and `lastSeq` because "the response ended"
 * otherwise cannot be told apart from "the session is over" — a client would
 * either poll a dead session forever or stop polling a live one. It is written
 * to this response only and is deliberately NOT hub-stamped: it describes this
 * attach, not the session, so putting it in the shared sequence space would
 * corrupt every other client's watermark.
 */
export function attachSession(entry, res, { sid, sinceSeq = 0 }) {
	openSse(res, sid);
	entry.hub.replaySince((event) => writeSse(res, event), sinceSeq);
	writeSse(res, {
		type: "attach_end",
		seq: null,
		live: !entry.terminal,
		lastSeq: entry.hub.seq,
	});
	res.end();
}

/** `stop`: cancel the turn, then terminate the child. Streams until terminal. */
export async function stopSession(entry, res, { sid, sinceSeq }) {
	const from = Number.isFinite(sinceSeq) ? Number(sinceSeq) : entry.hub.seq;
	return streamTo(res, {
		entry,
		sid,
		sinceSeq: from,
		deliver: async () => {
			entry.hub.emit({ type: "status", phase: "stopping" });
			if (!entry.child) {
				finishSession(entry, { type: "done", stopReason: "stopped", exitCode: null });
				await closeSession(entry);
				return;
			}
			const outcome = await entry.child.cancelAndTerminate();
			entry.hub.emit({ type: "status", phase: "stopped", ...outcome });
			// The child's own `exit` handler normally supplies the terminal event; if
			// there was no live process at all, close the session here so the stream
			// cannot hang waiting for one.
			if (!entry.child.alive && !entry.terminal) {
				finishSession(entry, { type: "done", stopReason: "stopped", exitCode: entry.child.exitCode ?? null });
				await closeSession(entry);
			}
		},
	});
}

/* ────────────────────────────── HTTP contract ─────────────────────────────── */

export function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function sendJson(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

/**
 * POST /invocations. Every action carries an owner token, so knowing a session
 * id is not enough to drive it, and a rejected action answers the one result
 * shape with an HTTP status rather than a half-opened event stream.
 */
export async function handleInvocation(req, res, { spawn, resolveApiKey } = {}) {
	sweepSessions();

	let payload = {};
	try {
		const raw = await readBody(req);
		payload = raw ? JSON.parse(raw) : {};
	} catch {
		sendJson(res, 400, actionResult({ action: "unknown", reason: "invalid JSON payload" }));
		return;
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

	const action = typeof payload.action === "string" ? payload.action : "start";
	const headerSid = req.headers?.[SID_HEADER];
	const sid = typeof headerSid === "string" && headerSid ? headerSid : String(payload.runtimeSessionId ?? "");
	const sinceSeq = Number(payload.sinceSeq ?? 0) || 0;

	if (sid.length < MIN_SESSION_ID_LENGTH) {
		sendJson(
			res,
			400,
			actionResult({
				action,
				reason: `missing or too-short session id (need >= ${MIN_SESSION_ID_LENGTH} chars, got ${sid.length})`,
			}),
		);
		return;
	}

	let entry = sessions.get(sid);

	if (action === "start") {
		if (entry) {
			sendJson(res, 409, actionResult({ action, seq: entry.hub.seq, reason: `session ${sid} already started` }));
			return;
		}
		const admit = admitStart({ sessions, payload });
		if (!admit.ok) {
			log(`[worker] rejected start: ${admit.code} (active=${sessions.size}, max=${MAX_ACTIVE_SESSIONS})`);
			sendJson(res, admit.code === "concurrency_limit" ? 429 : 400, actionResult({ action, reason: admit.message }));
			return;
		}
		entry = createSession(sid, {
			ownerToken: typeof payload.ownerToken === "string" ? payload.ownerToken : undefined,
			maxHistory: Number(payload.maxHistory) || undefined,
		});
		await streamTo(res, {
			entry,
			sid,
			sinceSeq,
			// Subscribed first (defect c): the launch emits `launching`,
			// `child_started` and the child's first frames, and they must reach this
			// response as they happen rather than only once start() returns.
			deliver: () => startSession(entry, payload, { spawn, resolveApiKey }),
		});
		return;
	}

	if (!entry) {
		sendJson(res, 404, actionResult({ action, reason: `unknown session; send action "start" first` }));
		return;
	}
	const owner = admitAction({ entry, payload });
	if (!owner.ok) {
		log(`[worker] rejected ${action}: ${owner.code}`);
		sendJson(res, 403, actionResult({ action, reason: owner.message }));
		return;
	}

	if (action === "rpc") {
		const result = deliverRpc(entry, payload.message);
		sendJson(res, result.delivered ? 200 : 409, result);
		return;
	}
	if (action === "attach") {
		attachSession(entry, res, { sid, sinceSeq });
		return;
	}
	if (action === "stop") {
		await stopSession(entry, res, { sid, sinceSeq: payload.sinceSeq === undefined ? undefined : sinceSeq });
		return;
	}
	sendJson(res, 400, actionResult({ action, reason: `unknown action "${action}"` }));
}

export function createWorkerServer({ spawn, resolveApiKey } = {}) {
	return createServer((req, res) => {
		if (req.method === "GET" && (req.url === "/ping" || req.url === "/ping/")) {
			const live = [...sessions.values()].filter((e) => !e.done).length;
			sendJson(res, 200, { status: "Healthy", sessions: live });
			return;
		}
		if (req.method === "POST" && (req.url === "/invocations" || req.url === "/invocations/")) {
			void handleInvocation(req, res, { spawn, resolveApiKey }).catch((err) => {
				log(`[worker] invocation failed: ${err?.message ?? err}`);
				if (!res.headersSent) sendJson(res, 500, actionResult({ action: "unknown", reason: "internal error" }));
				else if (!res.writableEnded) res.end();
			});
			return;
		}
		sendJson(res, 404, { error: "Not found" });
	});
}

export function main() {
	const server = createWorkerServer();
	const sweep = setInterval(() => sweepSessions(), SESSION_SWEEP_MS);
	sweep.unref();
	server.listen(PORT, "0.0.0.0", () => {
		log(`[worker] listening on :${PORT} (agent=${AGENT_ARGV.join(" ")})`);
		// Establish the execution boundary at boot rather than on the first session,
		// so a misconfigured runtime is visible in the logs immediately.
		void ensureIsolation().catch((err) => {
			log(`[worker] isolation setup failed: ${err?.message ?? err}`);
			process.exitCode = 1;
			server.close();
		});
	});
	return server;
}

// Only listen when executed directly, so `node --test` can import this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
