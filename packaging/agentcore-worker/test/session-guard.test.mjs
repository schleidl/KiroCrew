// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the worker's availability and admission-control guards:
 *
 *   M-029 / T-016 — the per-session event history is bounded, terminal events
 *                   survive pruning, and a client is TOLD when events were lost.
 *   M-028 / T-015 — the concurrent-session cap is enforced by the worker, not
 *                   only by the extension.
 *   M-020 / T-002 — attach/steer/stop require the session's owner token, so a
 *                   leaked session id alone cannot hijack a run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Hub, TERMINAL_EVENT_TYPES } from "../hub.mjs";
import { activeSessionCount, admitAction, admitStart, tokensMatch } from "../session-guard.mjs";

const collect = (hub, sinceSeq = 0) => {
	const seen = [];
	hub.replaySince((e) => seen.push(e), sinceSeq);
	return seen;
};

// ── M-029: bounded history ───────────────────────────────────────────────────

test("history is capped and never grows without bound", () => {
	const hub = new Hub({ maxHistory: 20 });
	for (let i = 0; i < 500; i++) hub.emit({ type: "message", i });
	assert.equal(hub.history.length, 20);
	assert.equal(hub.seq, 500, "sequence numbers keep counting even when events are pruned");
});

test("pruning is announced with an explicit gap event, not silently", () => {
	const hub = new Hub({ maxHistory: 20 });
	for (let i = 0; i < 100; i++) hub.emit({ type: "message", i });
	const seen = collect(hub);
	assert.equal(seen[0].type, "history_gap");
	assert.equal(seen[0].droppedEvents, 80);
	assert.equal(seen.length, 21, "gap notice + the retained window");
});

test("a client that is already past the pruned range gets no spurious gap", () => {
	const hub = new Hub({ maxHistory: 20 });
	for (let i = 0; i < 100; i++) hub.emit({ type: "message", i });
	const seen = collect(hub, hub.prunedThroughSeq);
	assert.ok(!seen.some((e) => e.type === "history_gap"));
	assert.equal(seen.length, 20);
});

test("terminal events survive pruning so a late attach still learns the outcome", () => {
	// Ported to this contract's vocabulary: the terminal set is `done` and a fatal
	// `error`, not the reference's cloud_* delivery events.
	const hub = new Hub({ maxHistory: 20 });
	hub.emit({ type: "error", fatal: false, message: "a non-fatal error is prunable" });
	for (let i = 0; i < 200; i++) hub.emit({ type: "message", i });
	hub.emit({ type: "error", fatal: true, message: "fatal" });
	hub.emit({ type: "done", stopReason: "end_turn" });
	for (let i = 0; i < 200; i++) hub.emit({ type: "message", i });

	const kinds = hub.history.map((e) => e.type);
	for (const terminal of ["error", "done"]) {
		assert.ok(kinds.includes(terminal), `${terminal} must not be pruned`);
		assert.ok(TERMINAL_EVENT_TYPES.has(terminal));
	}
	assert.equal(kinds.filter((k) => k === "error").length, 2, "both errors are retained by type");
});

test("subscribe still replays, then goes live", () => {
	const hub = new Hub({ maxHistory: 100 });
	hub.emit({ type: "a" });
	const seen = [];
	const off = hub.subscribe((e) => seen.push(e));
	hub.emit({ type: "b" });
	off();
	hub.emit({ type: "c" });
	assert.deepEqual(
		seen.map((e) => e.type),
		["a", "b"],
	);
});

// ── M-028: server-side concurrency cap ───────────────────────────────────────

const sessionsWith = (active, done = 0) => {
	const m = new Map();
	for (let i = 0; i < active; i++) m.set(`live-${i}`, { done: false });
	for (let i = 0; i < done; i++) m.set(`done-${i}`, { done: true });
	return m;
};

test("finished sessions do not count against the cap", () => {
	assert.equal(activeSessionCount(sessionsWith(2, 7)), 2);
});

test("start is admitted below the cap and refused at it", () => {
	const payload = { ownerToken: "t".repeat(64) };
	assert.equal(admitStart({ sessions: sessionsWith(2), payload, max: 3 }).ok, true);
	const refused = admitStart({ sessions: sessionsWith(3), payload, max: 3 });
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "concurrency_limit");
	assert.match(refused.message, /concurrent-session limit \(3 active\)/);
});

test("the cap counts sessions in the worker, independent of any client claim", () => {
	// A client that lies about its own concurrency still hits the server cap.
	const refused = admitStart({ sessions: sessionsWith(8), payload: { ownerToken: "x".repeat(64) }, max: 8 });
	assert.equal(refused.ok, false);
});

// ── M-020: session ownership ─────────────────────────────────────────────────

test("owner token is required when the runtime demands it", () => {
	const env = { CLOUD_MODE_REQUIRE_OWNER_TOKEN: "1" };
	const refused = admitStart({ sessions: new Map(), payload: {}, env });
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "owner_token_required");
	assert.equal(admitStart({ sessions: new Map(), payload: { ownerToken: "abc" }, env }).ok, true);
	// Without the switch, a legacy client is still accepted.
	assert.equal(admitStart({ sessions: new Map(), payload: {}, env: {} }).ok, true);
});

test("actions on a bound session require the matching owner token", () => {
	const entry = { ownerToken: "a".repeat(64) };
	assert.equal(admitAction({ entry, payload: { ownerToken: "a".repeat(64) } }).ok, true);

	const wrong = admitAction({ entry, payload: { ownerToken: "b".repeat(64) } });
	assert.equal(wrong.ok, false);
	assert.equal(wrong.code, "not_session_owner");

	// Knowing only the session id is no longer enough — this is the T-002 fix.
	const none = admitAction({ entry, payload: {} });
	assert.equal(none.ok, false);
	assert.equal(none.code, "not_session_owner");
});

test("token comparison rejects empty tokens and length-mismatches safely", () => {
	assert.equal(tokensMatch("", ""), false);
	assert.equal(tokensMatch(undefined, undefined), false);
	assert.equal(tokensMatch("abc", "abcd"), false);
	assert.equal(tokensMatch("abc", "abc"), true);
});
