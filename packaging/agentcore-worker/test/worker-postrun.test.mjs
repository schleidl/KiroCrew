// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The post-run pipeline: validate, then integrate, then close (WP6 step 1).
 *
 * Asserted through the events, because the events are the contract: the bridge is the
 * only consumer, and a delivery that happened invisibly is indistinguishable from one
 * that did not. Four properties, each of which was a real way to get this wrong:
 *
 *   - a turn that did NOT end cleanly delivers nothing, and SAYS so rather than
 *     going quiet (silence reads as "delivery failed");
 *   - a FAILING validation blocks integration — the gate is fail-closed, because an
 *     agent's diff that nobody validated is exactly what must not reach a shared
 *     branch;
 *   - a passing validation delivers, and hands the SAME validator to the
 *     integration, which re-runs it after a rebase;
 *   - a thrown delivery is reported as a NON-fatal error beside the turn's own
 *     terminal event, never as a second terminal one, so it cannot rewrite the
 *     turn's outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Hub } from "../hub.mjs";
import { deliverThenCloseForTests } from "../server.mjs";

function entryWith(cwd) {
	return { id: "s".repeat(33), hub: new Hub(), meta: { cwd }, terminal: true, done: true };
}

function phases(hub) {
	return hub.history.map((e) => e.phase ?? e.type);
}

test("a turn that did not end cleanly delivers nothing and says why", async () => {
	const entry = entryWith("/nonexistent");
	await deliverThenCloseForTests(entry, { stopReason: "stopped" }, {
		validate: async () => assert.fail("validation must not run"),
		integrate: async () => assert.fail("integration must not run"),
		close: async () => {},
	});
	assert.deepEqual(phases(entry.hub), ["delivery_skipped"]);
	assert.match(entry.hub.history[0].reason, /stopReason=stopped/);
});

test("a failing validation blocks integration", async () => {
	const entry = entryWith("/work");
	let integrated = false;
	await deliverThenCloseForTests(entry, { stopReason: "end_turn" }, {
		validate: async () => ({ ok: false, output: "2 tests failed" }),
		integrate: async () => {
			integrated = true;
			return { ok: true };
		},
		close: async () => {},
	});
	assert.equal(integrated, false, "an unvalidated diff must not reach a shared branch");
	assert.deepEqual(phases(entry.hub), ["validated", "delivery_skipped"]);
	assert.equal(entry.hub.history[0].ok, false);
	assert.match(entry.hub.history[0].detail, /2 tests failed/);
});

test("a passing validation delivers and hands the validator to the integration", async () => {
	const entry = entryWith("/work");
	let received = null;
	await deliverThenCloseForTests(entry, { stopReason: "end_turn" }, {
		validate: async () => ({ ok: true, output: "all green" }),
		integrate: async (opts) => {
			received = opts;
			return { ok: true, reason: "merged" };
		},
		close: async () => {},
	});
	assert.deepEqual(phases(entry.hub), ["validated", "integrated"]);
	assert.equal(entry.hub.history[1].ok, true);
	assert.equal(typeof received.validate, "function", "the rebase must be able to re-validate");
	assert.equal(received.cwd, "/work");
});

test("a thrown delivery is non-fatal and does not rewrite the turn's outcome", async () => {
	const entry = entryWith("/work");
	let closed = false;
	await deliverThenCloseForTests(entry, { stopReason: "end_turn" }, {
		validate: async () => {
			throw new Error("validator exploded");
		},
		integrate: async () => ({ ok: true }),
		close: async () => {
			closed = true;
		},
	});
	const last = entry.hub.history.at(-1);
	assert.equal(last.type, "error");
	assert.equal(last.fatal, false, "the session already emitted its terminal event");
	assert.match(last.message, /delivery failed/);
	assert.equal(closed, true, "the hub still closes on the error path");
});

test("a session with no worktree skips rather than guessing one", async () => {
	const entry = entryWith("");
	await deliverThenCloseForTests(entry, { stopReason: "end_turn" }, {
		validate: async () => assert.fail("validation must not run"),
		integrate: async () => assert.fail("integration must not run"),
		close: async () => {},
	});
	assert.deepEqual(phases(entry.hub), ["delivery_skipped"]);
	assert.match(entry.hub.history[0].reason, /no worktree/);
});
