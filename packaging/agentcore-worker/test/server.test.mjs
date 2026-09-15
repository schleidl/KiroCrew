// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker-contract tests.
 *
 * Every test here drives the real server module. The agent child is faked at the
 * ONE seam that needs faking — `spawn` — so the JSON-RPC pump, the sequence
 * space, the stop path and the credential handling are all the production code
 * paths. No AWS call is made and no `kiro-cli` binary is required.
 *
 * The four inherited defects are pinned by name:
 *   (a) "stop cancels then terminates …"        — a real stop, never a prompt
 *   (b) "finished sessions are swept …"         — bounded session map
 *   (c) "a streaming action subscribes before …" — live streaming during delivery
 *   (d) "every non-streaming action answers …"  — one result shape
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import test, { after, beforeEach } from "node:test";

import { Hub } from "../hub.mjs";
import { _resetSandboxForTests, initSandbox } from "../sandbox.mjs";
import {
	AgentChild,
	MIN_SESSION_ID_LENGTH,
	SID_HEADER,
	_resetIsolationForTests,
	_resetSecretsForTests,
	_resetSessionsForTests,
	actionResult,
	attachSession,
	buildAgentSpawn,
	createSession,
	deliverRpc,
	deriveUsage,
	failSession,
	finishSession,
	handleInvocation,
	redact,
	sessions,
	startSession,
	stopSession,
	streamTo,
	stripEnvPrologue,
	sweepSessions,
} from "../server.mjs";

const SID = "a".repeat(40);
const API_KEY = "ksk_unit_test_credential_value_0001";
const workspaces = [];

/** Force the portable same-uid sandbox so no test depends on setpriv/sudo. */
async function forceSameUidSandbox() {
	_resetSandboxForTests();
	await initSandbox({
		exec: async () => {
			throw new Error("force same-uid for a portable test");
		},
	});
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for the `kiro-cli acp` child: records stdin, signals and exit. */
class FakeChild extends EventEmitter {
	constructor({ exitOnSignal = true } = {}) {
		super();
		this.pid = 4242;
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.written = [];
		this.signals = [];
		this.exited = false;
		this.exitOnSignal = exitOnSignal;
		const written = this.written;
		this.stdin = {
			destroyed: false,
			write(chunk) {
				written.push(String(chunk));
				return true;
			},
		};
	}

	/** Every JSON-RPC message the worker wrote to stdin, parsed. */
	messages() {
		return this.written.map((line) => JSON.parse(line));
	}

	methods() {
		return this.messages().map((m) => m.method);
	}

	/** Emit one JSON-RPC line as the child would. */
	say(message) {
		this.stdout.write(`${JSON.stringify(message)}\n`);
		return delay(5);
	}

	kill(signal) {
		this.signals.push(signal);
		if (this.exitOnSignal) this.exit(null, signal);
		return true;
	}

	exit(code = 0, signal = null) {
		if (this.exited) return;
		this.exited = true;
		setImmediate(() => this.emit("exit", code, signal));
	}
}

function fakeSpawnFor(child) {
	const calls = [];
	const spawn = (file, args, options) => {
		calls.push({ file, args, options });
		return child;
	};
	spawn.calls = calls;
	return spawn;
}

class FakeRes {
	constructor() {
		this.chunks = [];
		this.status = null;
		this.headers = null;
		this.headersSent = false;
		this.writableEnded = false;
	}

	writeHead(status, headers) {
		this.status = status;
		this.headers = headers ?? null;
		this.headersSent = true;
		return this;
	}

	write(chunk) {
		if (this.writableEnded) return false;
		this.chunks.push(String(chunk));
		return true;
	}

	end(chunk) {
		if (chunk !== undefined) this.write(chunk);
		this.writableEnded = true;
	}

	on() {
		return this;
	}

	body() {
		return this.chunks.join("");
	}

	json() {
		return JSON.parse(this.body());
	}

	/** Parsed SSE data frames, in order. Comment keepalives are ignored. */
	events() {
		return this.body()
			.split("\n\n")
			.filter((frame) => frame.startsWith("data: "))
			.map((frame) => JSON.parse(frame.slice(6)));
	}

	keepalives() {
		return this.chunks.filter((c) => c === ": ping\n\n").length;
	}
}

function fakeReq(body, { sid = SID, method = "POST", url = "/invocations" } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = sid === null ? {} : { [SID_HEADER]: sid };
	setImmediate(() => {
		req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}

/** Start a session with a fake child, through the real start path. */
async function startWithFakeChild(payload = {}, { child = new FakeChild(), id = SID } = {}) {
	const entry = createSession(id, { ownerToken: payload.ownerToken });
	const spawn = fakeSpawnFor(child);
	await startSession(entry, payload, { spawn, resolveApiKey: async () => API_KEY });
	if (entry.workspace) workspaces.push(entry.workspace);
	return { entry, child, spawn };
}

beforeEach(async () => {
	_resetSessionsForTests();
	_resetIsolationForTests();
	_resetSecretsForTests();
	await forceSameUidSandbox();
});

after(() => {
	for (const dir of workspaces) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/* ───────────────────────── the child is a pipe, not a parser ──────────────── */

test("each stdout line becomes exactly one acp event carrying the payload verbatim", async () => {
	const { entry, child } = await startWithFakeChild();
	const payload = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "Kiro CLI Agent" } } };
	await child.say(payload);
	await child.say({ jsonrpc: "2.0", method: "_kiro.dev/session/update", params: { sessionUpdate: "tool_call" } });

	const acp = entry.hub.history.filter((e) => e.type === "acp");
	assert.equal(acp.length, 2);
	assert.deepEqual(acp[0].payload, payload, "the payload is carried through unrewritten");
	assert.equal(acp[1].payload.method, "_kiro.dev/session/update", "vendor-prefixed methods pass through");
});

test("the worker asserts no protocol version and performs no handshake of its own", async () => {
	const { child } = await startWithFakeChild();
	assert.deepEqual(child.written, [], "start must not send initialize, session/new or a prompt");
});

test("initialize is forwarded byte-for-byte rather than rewritten to the worker's own version", async () => {
	const { entry, child } = await startWithFakeChild();
	// KiroCrew sends a date string; the child answers integer 1. The worker must
	// not reconcile them — it forwards, and the two ends negotiate.
	const initialize = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-08-22", clientCapabilities: { fs: { readTextFile: false } } },
	};
	const result = deliverRpc(entry, initialize);
	assert.equal(result.delivered, true);
	assert.deepEqual(child.messages()[0], initialize);
});

test("an unparsable child line is a non-fatal error and the session stays live", async () => {
	const { entry, child } = await startWithFakeChild();
	child.stdout.write("this is not json\n");
	await delay(10);
	const err = entry.hub.history.find((e) => e.type === "error");
	assert.equal(err.fatal, false);
	assert.equal(entry.terminal, false);
	assert.equal(entry.done, false);
});

/* ───────────────────────── defect (a): a real stop ────────────────────────── */

test("stop cancels then terminates the child, and never falls through to a prompt", async () => {
	const { entry, child } = await startWithFakeChild();
	await child.say({ jsonrpc: "2.0", id: 2, result: { sessionId: "acp-session-1" } });
	assert.equal(entry.child.acpSessionId, "acp-session-1");

	const res = new FakeRes();
	await stopSession(entry, res, { sid: SID });
	await delay(20);

	assert.deepEqual(child.methods(), ["session/cancel"], "cooperative cancel first, and nothing else");
	assert.equal(child.messages()[0].params.sessionId, "acp-session-1");
	assert.ok(!child.methods().includes("session/prompt"), "the reference's fall-through to a prompt must not survive");
	assert.equal(child.exited, true, "the child is really gone, not merely asked to stop");

	const phases = entry.hub.history.filter((e) => e.type === "status").map((e) => e.phase);
	assert.ok(phases.includes("stopping"));
	assert.ok(phases.includes("child_exit"));
	const done = entry.hub.history.filter((e) => e.type === "done");
	assert.equal(done.length, 1, "exactly one terminal event");
	assert.equal(entry.done, true);
});

test("stop terminates a child that ignores the cooperative cancel", async () => {
	const child = new FakeChild({ exitOnSignal: false });
	const { entry } = await startWithFakeChild({}, { child });
	await child.say({ jsonrpc: "2.0", id: 2, result: { sessionId: "acp-session-2" } });

	// The child neither honours session/cancel nor dies on SIGTERM.
	const outcome = await entry.child.cancelAndTerminate({ cancelGraceMs: 30, terminateGraceMs: 30 });
	assert.equal(outcome.cancelled, true, "cancel was still attempted first");
	assert.equal(outcome.terminated, true);
	assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "escalates rather than hanging");
});

test("stop on a session whose child never started still reaches a terminal event", async () => {
	const entry = createSession(SID);
	const res = new FakeRes();
	await stopSession(entry, res, { sid: SID });
	assert.equal(entry.terminal, true);
	assert.equal(res.events().at(-1).type, "done");
});

/* ───────────────────────── defect (b): bounded session map ────────────────── */

test("finished sessions are swept on a TTL and running ones never are", async () => {
	const finished = createSession(`finished-${"x".repeat(40)}`);
	const running = createSession(`running-${"y".repeat(40)}`);
	finishSession(finished, { type: "done", stopReason: "end_turn" }, { now: () => 1_000 });

	assert.deepEqual(sweepSessions({ now: 1_000 + 60_000, ttlMs: 15 * 60_000 }), [], "not yet past the TTL");
	assert.equal(sessions.size, 2);

	const dropped = sweepSessions({ now: 1_000 + 16 * 60_000, ttlMs: 15 * 60_000 });
	assert.deepEqual(dropped, [finished.id]);
	assert.equal(sessions.has(finished.id), false, "the map does not grow for the container's lifetime");
	assert.equal(sessions.has(running.id), true, "a live session is never swept, whatever its age");
	assert.equal(sweepSessions({ now: Number.MAX_SAFE_INTEGER, ttlMs: 15 * 60_000 }).length, 0);
});

test("a session that finished on its own is marked with the time it finished", async () => {
	const { entry, child } = await startWithFakeChild();
	await child.say({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
	await delay(20);
	assert.equal(entry.done, true);
	assert.equal(typeof entry.finishedAt, "number", "without this the TTL sweep has nothing to compare");
});

/* ───────────────────────── defect (c): subscribe before delivering ────────── */

test("a streaming action subscribes before it delivers, so a turn streams live", async () => {
	const entry = createSession(SID);
	const res = new FakeRes();
	let writesDuringDelivery = -1;

	await streamTo(res, {
		entry,
		sid: SID,
		deliver: async () => {
			// Events emitted WHILE the action is still running. With the reference's
			// order (deliver, then subscribe) the response would still be empty here
			// and the client would see the whole turn only after it ended.
			entry.hub.emit({ type: "status", phase: "one" });
			entry.hub.emit({ type: "status", phase: "two" });
			await delay(10);
			writesDuringDelivery = res.chunks.length;
		},
	});

	assert.equal(writesDuringDelivery, 2, "both events reached the client before the delivery returned");
});

test("a start invocation streams progress while start is still blocked", async () => {
	const child = new FakeChild();
	const res = new FakeRes();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});

	const pending = handleInvocation(fakeReq({ action: "start" }), res, {
		spawn: fakeSpawnFor(child),
		resolveApiKey: async () => {
			await gate;
			return API_KEY;
		},
	});

	await delay(40);
	const phasesSoFar = res.events().map((e) => e.phase);
	assert.ok(phasesSoFar.includes("isolation"), `expected live progress while start is blocked, got ${phasesSoFar}`);
	assert.equal(res.writableEnded, false);

	release();
	await pending;
	const entry = sessions.get(SID);
	if (entry?.workspace) workspaces.push(entry.workspace);
	assert.ok(res.events().some((e) => e.phase === "child_started"));
});

/* ───────────────────────── defect (d): one result shape ───────────────────── */

test("every non-streaming action answers one result shape, not a field-presence union", async () => {
	const { entry, child } = await startWithFakeChild();
	const KEYS = ["action", "delivered", "seq", "reason"];

	const ok = deliverRpc(entry, { jsonrpc: "2.0", id: 1, method: "session/cancel", params: {} });
	const badMessage = deliverRpc(entry, "not an object");
	child.stdin.destroyed = true;
	const undeliverable = deliverRpc(entry, { jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} });

	for (const result of [ok, badMessage, undeliverable, actionResult({ action: "attach" })]) {
		assert.deepEqual(Object.keys(result).sort(), [...KEYS].sort(), "identical key set on success and failure");
		assert.equal(typeof result.delivered, "boolean");
		assert.equal(typeof result.seq, "number");
		assert.ok(result.reason === null || typeof result.reason === "string");
	}
	assert.equal(ok.delivered, true);
	assert.equal(ok.reason, null);
	assert.equal(undeliverable.delivered, false);
	assert.match(undeliverable.reason, /not accepting input/);
});

/* ───────────────────────── contract rule 1: rpc answers {delivered, seq} ──── */

test("rpc answers delivered:true with the seq the delivery was observed at", async () => {
	const { entry, child } = await startWithFakeChild();
	const before = entry.hub.seq;
	const result = deliverRpc(entry, { jsonrpc: "2.0", id: 7, method: "session/prompt", params: {} });

	assert.equal(result.delivered, true);
	assert.equal(result.seq, before + 1, "the seq names the status event that records the delivery");
	const status = entry.hub.history.find((e) => e.seq === result.seq);
	assert.equal(status.type, "status");
	assert.equal(status.phase, "rpc_delivered");
	assert.equal(status.rpcId, 7);
	assert.equal(child.messages()[0].id, 7);
});

test("a dropped rpc on a live session is stamped in the same sequence space", async () => {
	const { entry, child } = await startWithFakeChild();
	// The child is alive but no longer accepting stdin — the race a client hits
	// when it fires an approval into a session that is on its way out.
	child.stdin.destroyed = true;
	const before = entry.hub.seq;

	const result = deliverRpc(entry, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: {} });
	assert.equal(result.delivered, false);
	assert.equal(result.seq, before + 1, "the attempt is stamped, so a reconnecting client can find it");
	const status = entry.hub.history.find((e) => e.seq === result.seq);
	assert.equal(status.phase, "rpc_dropped");
	assert.equal(status.delivered, false);
	assert.ok(entry.hub.history.some((e) => e.type === "error" && e.fatal === false), "and reported as non-fatal");
});

test("an rpc after the session has ended reports seq 0 rather than naming another event", async () => {
	const { entry, child } = await startWithFakeChild();
	child.exit(0, null);
	await delay(20);
	assert.equal(entry.terminal, true);

	const result = deliverRpc(entry, { jsonrpc: "2.0", id: 9, method: "session/prompt", params: {} });
	assert.equal(result.delivered, false);
	assert.equal(result.seq, 0, "a closed hub stamps nothing; pointing at the terminal event would mislead");
	assert.match(result.reason, /not accepting input/);
});

test("an rpc against a session with no child is refused rather than queued", async () => {
	const entry = createSession(SID);
	const result = deliverRpc(entry, { jsonrpc: "2.0", id: 1, method: "initialize" });
	assert.equal(result.delivered, false);
	assert.match(result.reason, /has not been started/);
});

/* ───────────────────────── contract rule 2: attach_end sentinel ───────────── */

test("attach replays then ends with an attach_end sentinel carrying live and lastSeq", async () => {
	const entry = createSession(SID);
	entry.hub.emit({ type: "status", phase: "one" });
	entry.hub.emit({ type: "status", phase: "two" });

	const res = new FakeRes();
	attachSession(entry, res, { sid: SID, sinceSeq: 1 });

	const events = res.events();
	assert.equal(events.length, 2, "one replayed event after sinceSeq, plus the sentinel");
	assert.equal(events[0].seq, 2);
	assert.deepEqual(events[1], { type: "attach_end", seq: null, live: true, lastSeq: 2 });
	assert.equal(res.writableEnded, true, "attach is read-only: replay, then end");
});

test("attach_end reports live:false once the session is over, so a client stops polling", async () => {
	const entry = createSession(SID);
	finishSession(entry, { type: "done", stopReason: "end_turn" });
	const res = new FakeRes();
	attachSession(entry, res, { sid: SID, sinceSeq: 0 });

	const sentinel = res.events().at(-1);
	assert.equal(sentinel.type, "attach_end");
	assert.equal(sentinel.live, false);
	assert.equal(sentinel.lastSeq, entry.hub.seq);
});

test("attach announces a pruning gap rather than letting a client believe it saw everything", () => {
	const entry = { id: SID, hub: new Hub({ maxHistory: 20 }), terminal: false };
	for (let i = 0; i < 100; i += 1) entry.hub.emit({ type: "status", phase: `p${i}` });
	const res = new FakeRes();
	attachSession(entry, res, { sid: SID, sinceSeq: 0 });

	const events = res.events();
	assert.equal(events[0].type, "history_gap");
	assert.equal(events[0].throughSeq, entry.hub.prunedThroughSeq);
	assert.equal(events.at(-1).type, "attach_end");
});

/* ───────────────────────── contract rule 3: fatal error kills the child ───── */

test("a fatal error terminates the child before the stream closes", async () => {
	const { entry, child } = await startWithFakeChild();
	const res = new FakeRes();
	await streamTo(res, { entry, sid: SID });

	await failSession(entry, "the orchestrator lost the plot", { code: "test_fatal" });
	await delay(20);

	const fatal = entry.hub.history.find((e) => e.type === "error" && e.fatal === true);
	assert.equal(fatal.code, "test_fatal");
	assert.equal(child.exited, true, "otherwise the container keeps running, and costing, with nobody attached");
	assert.deepEqual(child.signals, ["SIGTERM"]);
	assert.equal(res.writableEnded, true, "a fatal error is as final as a done");
	assert.equal(entry.done, true);
	assert.equal(entry.finishedAt !== null, true, "and it becomes sweepable like any finished session");
});

test("a fatal error is the session's only terminal event", async () => {
	const { entry } = await startWithFakeChild();
	await failSession(entry, "first and only");
	const emittedSecond = finishSession(entry, { type: "done", stopReason: "end_turn" });
	assert.equal(emittedSecond, false);
	assert.equal(entry.hub.history.filter((e) => e.type === "done").length, 0);
});

/* ───────────────────────── contract rule 4: usage is advisory ─────────────── */

test("usage is derived, marked advisory, and never replaces the raw acp frame", async () => {
	const { entry, child } = await startWithFakeChild();
	await child.say({
		jsonrpc: "2.0",
		method: "_kiro.dev/metadata",
		params: {
			meteringUsage: [{ value: 0.0293 }, { value: 0.671428 }],
			contextUsagePercentage: 12.5,
		},
	});

	const usage = entry.hub.history.find((e) => e.type === "usage");
	assert.equal(usage.advisory, true, "a client that sums usage AND acp double-counts; say so on the wire");
	assert.equal(usage.credits, 0.700728);
	assert.equal(usage.entries, 2);
	assert.equal(usage.contextUsagePercentage, 12.5);

	const raw = entry.hub.history.find((e) => e.type === "acp");
	assert.deepEqual(raw.payload.params.meteringUsage.length, 2, "the raw frame is still carried verbatim");
	assert.ok(raw.seq < usage.seq, "usage follows the frame it was derived from");
});

test("a frame without metering produces no usage event", () => {
	assert.equal(deriveUsage({ sessionUpdate: "tool_call" }), undefined);
	assert.equal(deriveUsage({ meteringUsage: [] }), undefined);
	assert.equal(deriveUsage(undefined), undefined);
});

/* ───────────────────────── deduplication is the client's job ──────────────── */

test("two concurrent readers each get the whole range: the worker suppresses nothing", async () => {
	const entry = createSession(SID);
	entry.hub.emit({ type: "status", phase: "one" });

	const live = new FakeRes();
	await streamTo(live, { entry, sid: SID, sinceSeq: 0 });
	const poll = new FakeRes();
	attachSession(entry, poll, { sid: SID, sinceSeq: 0 });

	const liveSeqs = live.events().map((e) => e.seq);
	const pollSeqs = poll
		.events()
		.filter((e) => e.type !== "attach_end")
		.map((e) => e.seq);
	assert.deepEqual(liveSeqs, pollSeqs, "both deliveries carry seq 1 — only a client watermark keeps one copy");

	entry.hub.emit({ type: "status", phase: "two" });
	const seqs = entry.hub.history.map((e) => e.seq);
	assert.deepEqual(seqs, [1, 2], "what the worker does guarantee is monotonic, gap-free seq per session");
});

/* ───────────────────────── credential hygiene ─────────────────────────────── */

test("the model credential reaches the child's environment and never its command line", async () => {
	// The strong posture: a privilege drop is available, which is where the
	// reference's `env -i NAME=VALUE …` argv prologue would have published it.
	_resetSandboxForTests();
	await initSandbox({ exec: async () => ({ stdout: "1001" }) });
	try {
		const spec = buildAgentSpawn({ cwd: "/work", apiKey: API_KEY, argv: ["kiro-cli", "acp"] });
		assert.equal(spec.mode, "separate-uid");
		assert.equal(spec.env.KIRO_API_KEY, API_KEY);
		for (const arg of [spec.file, ...spec.args]) {
			assert.ok(!arg.includes(API_KEY), `credential leaked into argv: ${arg}`);
			assert.ok(!/KIRO_API_KEY/.test(arg), `credential NAME=VALUE prologue survived: ${arg}`);
		}
		assert.ok(spec.args.includes("--reuid=cmagent"), "still runs as the unprivileged user");
		assert.ok(spec.args.at(-1).includes("kiro-cli"), "and still execs the agent");
	} finally {
		await forceSameUidSandbox();
	}
});

test("the child's environment carries no orchestrator credential", async () => {
	const spec = buildAgentSpawn({ cwd: "/work", apiKey: API_KEY });
	for (const name of Object.keys(spec.env)) {
		assert.ok(!/^(AWS_|GH_|GITHUB_)/.test(name), `${name} must not reach the agent`);
	}
	assert.equal(spec.env.KIRO_API_KEY, API_KEY);
	assert.equal(spec.env.HOME, "/home/cmagent", "the probe requires the agent's own home for its launcher sibling");
});

test("stripEnvPrologue leaves a same-uid argv untouched", () => {
	assert.deepEqual(stripEnvPrologue(["-c", "umask 002\nexec x"]), ["-c", "umask 002\nexec x"]);
	assert.deepEqual(
		stripEnvPrologue(["--reuid=cmagent", "--", "/usr/bin/env", "-i", "PATH=/bin", "KIRO_API_KEY=x", "/bin/bash", "-c", "s"]),
		["--reuid=cmagent", "--", "/bin/bash", "-c", "s"],
	);
});

test("the credential appears in no event and in no result reason", async () => {
	const { entry, child } = await startWithFakeChild();
	child.stderr.write(`fatal: rejected token ${API_KEY}\n`);
	child.stdout.write(`garbage containing ${API_KEY}\n`);
	await delay(20);
	await failSession(entry, `spawn failed with key ${API_KEY}`);

	const serialised = JSON.stringify(entry.hub.history);
	assert.ok(!serialised.includes(API_KEY), "no event may carry the credential");
	assert.ok(serialised.includes("[redacted]"), "it is redacted rather than dropped, so the message stays useful");
	assert.equal(redact(`x ${API_KEY} y`), "x [redacted] y");
});

/* ───────────────────────── HTTP contract surface ──────────────────────────── */

test("a session id shorter than the platform minimum is refused before anything starts", async () => {
	const res = new FakeRes();
	await handleInvocation(fakeReq({ action: "start" }, { sid: "short" }), res);
	assert.equal(res.status, 400);
	assert.match(res.json().reason, new RegExp(String(MIN_SESSION_ID_LENGTH)));
	assert.equal(sessions.size, 0);
});

test("an action on an unknown session is refused, and a second start is a conflict", async () => {
	const missing = new FakeRes();
	await handleInvocation(fakeReq({ action: "rpc", message: {} }), missing);
	assert.equal(missing.status, 404);

	createSession(SID);
	const conflict = new FakeRes();
	await handleInvocation(fakeReq({ action: "start" }), conflict);
	assert.equal(conflict.status, 409);
});

test("an action carrying the wrong owner token is refused with the one result shape", async () => {
	createSession(SID, { ownerToken: "the-real-owner-token" });
	const res = new FakeRes();
	await handleInvocation(fakeReq({ action: "rpc", ownerToken: "guessed", message: { id: 1 } }), res);
	assert.equal(res.status, 403);
	assert.deepEqual(Object.keys(res.json()).sort(), ["action", "delivered", "reason", "seq"]);
	assert.equal(res.json().delivered, false);
});

test("an unknown action is refused rather than treated as a start", async () => {
	createSession(SID);
	const res = new FakeRes();
	await handleInvocation(fakeReq({ action: "teleport" }), res);
	assert.equal(res.status, 400);
	assert.match(res.json().reason, /unknown action/);
});

test("an rpc over HTTP answers the result shape as JSON, not as an event stream", async () => {
	const { child } = await startWithFakeChild();
	const res = new FakeRes();
	await handleInvocation(fakeReq({ action: "rpc", message: { jsonrpc: "2.0", id: 5, method: "initialize" } }), res);

	assert.equal(res.status, 200);
	assert.equal(res.headers["Content-Type"], "application/json");
	assert.equal(res.json().delivered, true);
	assert.equal(child.messages()[0].id, 5);
});

test("a stream carries the comment keepalive alongside its data frames", async () => {
	const entry = createSession(SID);
	const res = new FakeRes();
	await streamTo(res, {
		entry,
		sid: SID,
		keepaliveMs: 15,
		deliver: async () => {
			entry.hub.emit({ type: "status", phase: "working" });
			await delay(50);
		},
	});
	assert.ok(res.keepalives() >= 1, "an idle stream must not be reset by the platform");
	assert.equal(res.events().length, 1, "and the keepalive must not disturb the data frames");
	finishSession(entry, { type: "done", stopReason: "end_turn" });
});

test("the stream sets the event-stream headers and echoes the session id", async () => {
	const entry = createSession(SID);
	const res = new FakeRes();
	await streamTo(res, { entry, sid: SID });
	assert.equal(res.status, 200);
	assert.equal(res.headers["Content-Type"], "text/event-stream");
	assert.equal(res.headers[SID_HEADER], SID);
});

test("subscribing to an already-finished session ends the stream instead of crashing", async () => {
	const entry = createSession(SID);
	finishSession(entry, { type: "done", stopReason: "end_turn" });
	const res = new FakeRes();
	await streamTo(res, { entry, sid: SID, sinceSeq: 0 });
	assert.equal(res.writableEnded, true);
	assert.equal(res.events().at(-1).type, "done");
});

test("a start whose credential cannot be resolved fails the session fatally", async () => {
	const entry = createSession(SID);
	const child = new FakeChild();
	await startSession(
		entry,
		{},
		{
			spawn: fakeSpawnFor(child),
			resolveApiKey: async () => {
				throw new Error("KIRO_API_KEY_SECRET is not set");
			},
		},
	);
	if (entry.workspace) workspaces.push(entry.workspace);

	const fatal = entry.hub.history.find((e) => e.type === "error" && e.fatal === true);
	assert.equal(fatal.code, "start_failed");
	assert.match(fatal.message, /KIRO_API_KEY_SECRET/);
	assert.equal(child.written.length, 0, "no agent is launched without a credential");
	assert.equal(entry.done, true);
});
