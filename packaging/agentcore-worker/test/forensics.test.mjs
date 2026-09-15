// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the availability + forensics mitigations added on top of the
 * isolation work:
 *
 *   M-029 / T-016 — bounded event history with an explicit gap announcement.
 *   M-025 / T-010 — durable transcript artifact key layout and safe failure.
 *   M-024 / T-009 — attribution trailer stamped into commits and PR bodies.
 *   M-026 / T-012 — the GitHub token reaches git through an askpass helper in
 *                   the environment, never through a file or git config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attributionTrailer } from "../git.mjs";
import { clearGitToken, gitEnv, hasGitToken, setGitToken } from "../git-auth.mjs";
import { transcriptKey } from "../transcript-archive.mjs";

// ── M-024: attribution ───────────────────────────────────────────────────────

test("attribution trailer carries story, session and delegating principal", () => {
	const trailer = attributionTrailer({
		storyId: "S-72",
		sessionId: "cloudmode-abc",
		delegatedBy: "arn:aws:sts::1:assumed-role/Admin/dev",
	});
	assert.match(trailer, /Cloud-Mode-Story: S-72/);
	assert.match(trailer, /Cloud-Mode-Session: cloudmode-abc/);
	assert.match(trailer, /Cloud-Mode-Delegated-By: arn:aws:sts::1:assumed-role\/Admin\/dev/);
});

test("attribution trailer degrades to 'unknown' rather than omitting the field", () => {
	const trailer = attributionTrailer({ storyId: "S-1" });
	assert.match(trailer, /Cloud-Mode-Delegated-By: unknown/);
});

// ── M-026: token never on disk, never in git config ──────────────────────────

test("askpass helper serves the token from the environment, not from a file", () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-token-"));
	try {
		const path = setGitToken("ghs_secrettoken", { tokenDir: dir });
		assert.ok(hasGitToken());
		const script = readFileSync(path, "utf-8");
		assert.doesNotMatch(script, /ghs_secrettoken/, "the secret must not be written to disk");
		assert.match(script, /CLOUD_MODE_GIT_TOKEN/);
		// Helper is owner-executable only.
		assert.equal(statSync(path).mode & 0o077, 0);

		const env = gitEnv();
		assert.equal(env.GIT_ASKPASS, path);
		assert.equal(env.CLOUD_MODE_GIT_TOKEN, "ghs_secrettoken");
		assert.equal(env.GIT_TERMINAL_PROMPT, "0");

		clearGitToken();
		assert.equal(hasGitToken(), false);
		assert.equal(gitEnv().CLOUD_MODE_GIT_TOKEN, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no credential file is created next to the askpass helper", () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-token-"));
	try {
		setGitToken("ghs_x", { tokenDir: dir });
		assert.equal(existsSync(join(dir, "git-credentials")), false);
		clearGitToken();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── M-025: transcript artifact ───────────────────────────────────────────────

test("transcript key is date-partitioned and path-safe", () => {
	const key = transcriptKey({
		storyId: "../../etc/passwd",
		sessionId: "cloudmode-abc/def",
		at: new Date("2026-08-03T10:00:00Z"),
	});
	assert.match(key, /^transcripts\/2026-08-03\//);
	assert.ok(!key.includes(".."), "story id must not be able to traverse the prefix");
	assert.ok(!key.includes("cloudmode-abc/def"), "session id is sanitised");
	assert.match(key, /\.jsonl$/);
});

test("archiveTranscript is a no-op (not an error) when no bucket is configured", async () => {
	// The module reads the bucket at import time; with none set it must report
	// "not configured" instead of throwing into a finished delivery.
	const { archiveTranscript } = await import("../transcript-archive.mjs");
	const res = await archiveTranscript({ sessionId: "s", meta: {}, events: [] });
	assert.equal(res.archived, false);
	assert.match(res.reason ?? "", /no CLOUD_MODE_TRANSCRIPT_BUCKET/);
});
