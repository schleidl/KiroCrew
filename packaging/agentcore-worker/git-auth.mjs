// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub token plumbing for orchestrator git/gh commands (threat model T-012 /
 * mitigations M-012c, M-026).
 *
 * The installation token is NEVER written into git configuration or a credential
 * file. It lives in this process's memory and is handed to individual git child
 * processes through a `GIT_ASKPASS` helper script — a tiny shell script that
 * echoes an environment variable. Consequences:
 *
 *   - `~/.gitconfig` contains no secret (it used to hold
 *     `url.https://x-access-token:<token>@github.com/.insteadOf`, mode 0644);
 *   - the token is present only in the environment of the git processes the
 *     orchestrator itself spawns;
 *   - untrusted code runs as a different OS user with an allow-listed
 *     environment (sandbox.mjs), so it can neither read that environment nor
 *     make the helper produce the token.
 *
 * Own module so `git.mjs` and `integrate.mjs` can share it without an import
 * cycle.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory for the askpass helper (mode 0700, orchestrator-owned). */
export const TOKEN_DIR = process.env.CLOUD_MODE_TOKEN_DIR ?? join(homedir(), ".cloud-mode");

const ASKPASS_SCRIPT =
	'#!/bin/sh\n' +
	'# Cloud Mode git credential helper: git asks for the username first, then the\n' +
	'# password. The secret comes from the environment, never from disk.\n' +
	'case "$1" in\n' +
	'  *[Uu]sername*) printf "%s\\n" "x-access-token" ;;\n' +
	'  *) printf "%s\\n" "$CLOUD_MODE_GIT_TOKEN" ;;\n' +
	'esac\n';

let token;
let askpassPath;

/** Install the askpass helper and remember the token in memory. */
export function setGitToken(value, { tokenDir = TOKEN_DIR } = {}) {
	token = value;
	mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
	chmodSync(tokenDir, 0o700);
	askpassPath = join(tokenDir, "askpass.sh");
	writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
	chmodSync(askpassPath, 0o700);
	return askpassPath;
}

/** Forget the token (end of session / tests). */
export function clearGitToken() {
	token = undefined;
	askpassPath = undefined;
}

/** True when a token has been configured for this process. */
export function hasGitToken() {
	return Boolean(token && askpassPath);
}

/**
 * Environment for an orchestrator git/gh child process: the ambient environment
 * plus the askpass helper and the token, injected per command.
 */
export function gitEnv(extra = {}) {
	if (!hasGitToken()) return { ...process.env, ...extra };
	return {
		...process.env,
		GIT_ASKPASS: askpassPath,
		CLOUD_MODE_GIT_TOKEN: token,
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	};
}
