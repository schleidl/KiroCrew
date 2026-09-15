// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Admission control for the worker's `/invocations` contract.
 *
 * Two independent guards, both enforced server-side because a control that only
 * exists in the client is not a control:
 *
 * 1. CONCURRENCY CAP (threat model T-015 / M-028). The extension caps parallel
 *    agents, but a runaway retry loop in a TUI — or a second principal that holds
 *    `InvokeAgentRuntime` — bypasses that entirely. Bedrock tokens and AgentCore
 *    session time are real money (A-09), so the runtime enforces its own cap.
 *
 * 2. SESSION OWNERSHIP (threat model T-002 / M-020). The runtime-session-id used
 *    to be the whole capability: anyone invoke-authorized who learned it could
 *    attach to a live run, read its transcript, or steer the agent into writing
 *    something the gate would happily merge. Each session now also carries a
 *    256-bit owner token that the delegating client keeps in memory, so hijacking
 *    requires both the id and a secret that is never rendered or logged.
 *    AgentCore does not bind sessions to callers (A-04), so this belongs to us.
 */

import { timingSafeEqual } from "node:crypto";

/** Server-side cap on concurrently running sessions. */
export const MAX_ACTIVE_SESSIONS = Number(process.env.CLOUD_MODE_MAX_ACTIVE_SESSIONS ?? 8);

/** Whether a start payload must carry an owner token at all. */
export function requireOwnerToken(env = process.env) {
	return /^(1|true|yes)$/i.test(env.CLOUD_MODE_REQUIRE_OWNER_TOKEN ?? "");
}

/** Constant-time comparison that treats an empty value as never matching. */
export function tokensMatch(a, b) {
	const x = Buffer.from(String(a ?? ""));
	const y = Buffer.from(String(b ?? ""));
	return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** Count sessions that have not finished yet. */
export function activeSessionCount(sessions) {
	let n = 0;
	for (const e of sessions.values()) if (!e.done) n += 1;
	return n;
}

/**
 * Decide whether a new session may start.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function admitStart({ sessions, payload = {}, max = MAX_ACTIVE_SESSIONS, env = process.env }) {
	if (activeSessionCount(sessions) >= max) {
		return {
			ok: false,
			code: "concurrency_limit",
			message:
				`Runtime is at its concurrent-session limit (${max} active). ` +
				`Retry when a story finishes, or raise CLOUD_MODE_MAX_ACTIVE_SESSIONS.`,
		};
	}
	if (!payload.ownerToken && requireOwnerToken(env)) {
		return {
			ok: false,
			code: "owner_token_required",
			message:
				"This runtime requires an ownerToken in the start payload (session hijack protection). " +
				"Update the cloud-mode extension, or unset CLOUD_MODE_REQUIRE_OWNER_TOKEN on the runtime.",
		};
	}
	return { ok: true };
}

/**
 * Decide whether a follow-up action (attach / steer / prompt / stop) is allowed.
 * A session started without an owner token stays open to its id alone — that is
 * the documented legacy behaviour, and `requireOwnerToken` prevents it.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function admitAction({ entry, payload = {} }) {
	if (!entry.ownerToken) return { ok: true };
	if (tokensMatch(payload.ownerToken, entry.ownerToken)) return { ok: true };
	return {
		ok: false,
		code: "not_session_owner",
		message: "Not the delegating client for this session (owner token mismatch)",
	};
}
