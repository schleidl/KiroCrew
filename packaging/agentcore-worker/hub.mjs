// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-session fan-out hub with a BOUNDED event history.
 *
 * Buffers events so a late-joining or re-attaching invoke can catch up, and
 * pushes new events to all connected responses.
 *
 * The history is bounded (threat model T-016 / M-029): an agent that emits for
 * hours, or a hostile one that emits deliberately, must not be able to exhaust
 * container memory. When events are pruned the next replay begins with an
 * explicit `history_gap` event, so a client never silently believes it has
 * seen the whole transcript — the durable record is the archived transcript
 * artifact (M-025), not this buffer.
 *
 * VENDORED from the cloud-mode reference worker. The only adaptation is the
 * event vocabulary: the AgentCore remote-agent contract names its events
 * `acp | status | usage | history_gap | attach_end | error | done` rather than
 * the reference's `cloud_*` set, so the terminal set and the gap announcement
 * use those names. The mechanics — monotonic seq, bounded prune that never
 * evicts a terminal event, replay-then-go-live — are unchanged.
 */

/** Default cap on retained events per session. */
export const DEFAULT_MAX_HISTORY = Number(process.env.CLOUD_MODE_MAX_HISTORY_EVENTS ?? 5000);

/** Events that must never be pruned: a late attach still has to learn the outcome. */
export const TERMINAL_EVENT_TYPES = new Set(["done", "error"]);

/** @typedef {(event: object) => void} Listener */

export class Hub {
	constructor({ maxHistory = DEFAULT_MAX_HISTORY } = {}) {
		/** @type {object[]} */
		this.history = [];
		/** @type {Set<Listener>} */
		this.listeners = new Set();
		this.closed = false;
		// Monotonic per-session sequence number stamped on every event so clients
		// can resume (re-attach / poll) gap-free and duplicate-free from a known seq.
		this.seq = 0;
		this.maxHistory = Math.max(16, maxHistory);
		this.prunedThroughSeq = 0;
		this.prunedCount = 0;
	}

	emit(event) {
		if (this.closed) return;
		const e = { ...event, seq: ++this.seq };
		this.history.push(e);
		while (this.history.length > this.maxHistory) {
			const idx = this.history.findIndex((h) => !TERMINAL_EVENT_TYPES.has(h.type));
			if (idx === -1) break;
			const [dropped] = this.history.splice(idx, 1);
			this.prunedThroughSeq = Math.max(this.prunedThroughSeq, dropped.seq);
			this.prunedCount += 1;
		}
		for (const l of this.listeners) {
			try {
				l(e);
			} catch {
				/* ignore listener errors */
			}
		}
	}

	/** Replay buffered events after `sinceSeq`, announcing any pruning gap first. */
	_replay(listener, sinceSeq) {
		if (this.prunedThroughSeq > sinceSeq) {
			listener({
				type: "history_gap",
				seq: this.prunedThroughSeq,
				droppedEvents: this.prunedCount,
				throughSeq: this.prunedThroughSeq,
				message: `${this.prunedCount} earlier event(s) pruned from the worker's bounded history`,
			});
		}
		for (const e of this.history) if (e.seq > sinceSeq) listener(e);
	}

	/**
	 * Subscribe; immediately replays history after `sinceSeq`, then goes live.
	 * Returns an unsubscribe fn.
	 */
	subscribe(listener, sinceSeq = 0) {
		this._replay(listener, sinceSeq);
		if (this.closed) return () => {};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Replay only events after `sinceSeq` (for read-only polling attaches). */
	replaySince(listener, sinceSeq = 0) {
		this._replay(listener, sinceSeq);
	}

	close() {
		this.closed = true;
		this.listeners.clear();
	}
}
