// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Untrusted-execution boundary for the Cloud Mode worker (threat model T-004,
 * T-006, T-011, T-012, T-018 / mitigation M-012).
 *
 * Two kinds of code run inside the session container:
 *
 *   1. ORCHESTRATOR code (server.mjs, git.mjs, integrate.mjs) — trusted. Holds
 *      the GitHub installation token and resolves AWS credentials in memory.
 *   2. UNTRUSTED code — every shell command the LLM decides to run, plus the
 *      target repository's own build/test/lint scripts executed by the
 *      validation gate. Attacker-influenceable by construction (story text,
 *      repo contents, CI logs).
 *
 * Historically (2) ran as the same OS user, in the same process tree, with the
 * orchestrator's full environment — so a single prompt injection or a hostile
 * `npm test` could read the runtime-role credentials and the GitHub token.
 *
 * This module is the single chokepoint through which all untrusted execution
 * goes. It provides two layers:
 *
 *   - ENV ALLOW-LIST (always): untrusted processes get a constructed
 *     environment containing only what a build needs (PATH, HOME, locale,
 *     caches). No AWS_*, no GH_* or GITHUB_*, no CLOUD_MODE_*, no PI_*.
 *   - SEPARATE OS USER (when available): the command is executed as an
 *     unprivileged user (`cmagent`) through whichever privilege-drop wrapper the
 *     platform allows (`setpriv`, `runuser`, or `sudo`), so it cannot read the
 *     orchestrator's memory or `/proc/<pid>/environ`, cannot read the GitHub
 *     token out of the orchestrator's environment, and cannot write the git
 *     directory (hooks).
 *
 * Env scrubbing alone is deliberately NOT treated as the control: same-uid
 * processes can recover a parent's environment through /proc. When no
 * privilege-drop mechanism is available, `initSandbox()` degrades to `same-uid`
 * mode and says so LOUDLY, with diagnostics (tenet 4: loud failure over silent
 * fallback) — the caller surfaces it as a session event and a log line, and
 * `CLOUD_MODE_REQUIRE_UID_SANDBOX=1` turns the degradation into a hard failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Unprivileged OS user that untrusted commands run as (created in the image). */
export const UNTRUSTED_USER = process.env.CLOUD_MODE_UNTRUSTED_USER ?? "cmagent";
/** Group shared by the orchestrator user and the untrusted user. */
export const SHARED_GROUP = process.env.CLOUD_MODE_SHARED_GROUP ?? "cmwork";
/** HOME handed to untrusted processes (never the orchestrator's home). */
export const UNTRUSTED_HOME = process.env.CLOUD_MODE_UNTRUSTED_HOME ?? `/home/${UNTRUSTED_USER}`;
/** Shared, group-writable tool caches so both users can populate them. */
const CACHE_ROOT = process.env.CLOUD_MODE_CACHE_ROOT ?? "/opt/cloud-mode-cache";

/**
 * Environment variables an untrusted build may see. Everything else is dropped:
 * this is an allow-list, not a deny-list, so a newly added secret-bearing
 * variable is excluded by default rather than by remembering to add it.
 */
const ENV_ALLOW_LIST = [
	"PATH",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"NODE_VERSION",
	"NODE_OPTIONS",
	"COREPACK_HOME",
	"COREPACK_ENABLE_DOWNLOAD_PROMPT",
	"npm_config_cache",
	"XDG_CACHE_HOME",
	"YARN_CACHE_FOLDER",
	"PNPM_HOME",
	"CARGO_HOME",
	"GOPATH",
	"GOCACHE",
	"GRADLE_USER_HOME",
	"MAVEN_OPTS",
	"PIP_CACHE_DIR",
];

/**
 * Extra variables the operator explicitly wants to reach repo build scripts
 * (e.g. a private registry host). Comma-separated names, values taken from the
 * worker environment. Deliberately opt-in and logged.
 */
function passthroughNames() {
	return (process.env.CLOUD_MODE_UNTRUSTED_ENV_PASSTHROUGH ?? "")
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
}

/** Names that must never be forwarded, even via the passthrough escape hatch. */
const NEVER_FORWARD = /^(AWS_|GH_|GITHUB_|CLOUD_MODE_|PI_|OPENAI_|ANTHROPIC_)|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Build the environment for an untrusted process.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]  HOME for the untrusted process.
 * @param {NodeJS.ProcessEnv} [opts.source]  environment to take allow-listed values from.
 * @param {Record<string,string>} [opts.extra]  additional explicit values (already vetted).
 */
export function untrustedEnv({ home = UNTRUSTED_HOME, source = process.env, extra = {} } = {}) {
	/** @type {Record<string,string>} */
	const env = {};
	for (const name of ENV_ALLOW_LIST) {
		const value = source[name];
		if (value !== undefined && value !== "") env[name] = String(value);
	}
	for (const name of passthroughNames()) {
		const value = source[name];
		if (value === undefined || NEVER_FORWARD.test(name)) continue;
		env[name] = String(value);
	}
	env.HOME = home;
	env.USER = UNTRUSTED_USER;
	env.LOGNAME = UNTRUSTED_USER;
	env.SHELL = "/bin/bash";
	// Deterministic, shared caches (group-writable) so a build works for either
	// user and a cold corepack/npm cache does not fail a restricted-egress run.
	env.COREPACK_HOME ??= `${CACHE_ROOT}/corepack`;
	env.npm_config_cache ??= `${CACHE_ROOT}/npm`;
	env.XDG_CACHE_HOME ??= `${CACHE_ROOT}/xdg`;
	env.CI = "1";
	for (const [k, v] of Object.entries(extra)) env[k] = String(v);
	// Final safety net: nothing secret-shaped survives, whatever put it here.
	for (const name of Object.keys(env)) {
		if (NEVER_FORWARD.test(name)) delete env[name];
	}
	return env;
}

/** POSIX single-quote a string for safe embedding in a shell command. */
export function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** @typedef {{ mode: "separate-uid" | "same-uid", user?: string, strategy?: string, reason?: string }} SandboxState */

/** @type {SandboxState} */
let state = { mode: "same-uid", reason: "not initialised" };
/** @type {Promise<SandboxState> | undefined} */
let initPromise;

/** Current sandbox state (after initSandbox; `same-uid` before). */
export function sandboxState() {
	return { ...state };
}

/** Human-readable one-liner for logs and session events. */
export function describeSandbox(s = state) {
	return s.mode === "separate-uid"
		? `untrusted code runs as OS user '${s.user}' via ${s.strategy ?? "privilege drop"} (separate uid, scrubbed env)`
		: `untrusted code runs as the orchestrator user (scrubbed env only) — reason: ${s.reason}`;
}

/**
 * Ways to run a command as another OS user, tried in order.
 *
 * `sudo` needs a setuid-root binary, which some container runtimes disallow
 * (no_new_privs / nosuid) — Bedrock AgentCore does. `setpriv` and `runuser` need
 * no setuid at all: they simply drop privileges, which is always permitted when
 * the caller is already root. The worker therefore runs its orchestrator as root
 * inside the per-session microVM and drops to `cmagent` for everything
 * untrusted; see the Dockerfile for the trade-off.
 */
const DROP_STRATEGIES = [
	{
		name: "setpriv",
		// --clear-groups drops supplementary groups; the shared group is re-added
		// explicitly so the untrusted user can still write the worktree.
		build: (user, group) => [
			"setpriv",
			[`--reuid=${user}`, `--regid=${group}`, "--clear-groups", "--"],
		],
	},
	{ name: "runuser", build: (user) => ["runuser", ["-u", user, "--"]] },
	{ name: "sudo", build: (user) => ["sudo", ["-n", "-u", user, "--"]] },
];

/** Collect why a privilege drop is impossible, so the log line is actionable. */
async function dropDiagnostics(runner) {
	const bits = [];
	try {
		const { stdout } = await runner("/bin/sh", [
			"-c",
			"id -u; grep -i NoNewPrivs /proc/self/status 2>/dev/null | tr -d '\\n'; " +
				"ls -l /usr/bin/sudo 2>/dev/null | cut -c1-12",
		]);
		bits.push(String(stdout ?? "").trim().replace(/\s+/g, " "));
	} catch {
		/* diagnostics are best-effort */
	}
	return bits.join(" | ");
}

/**
 * Probe once whether we can execute commands as the unprivileged user, and
 * remember the outcome. Never throws unless the operator demanded the strong
 * mode via CLOUD_MODE_REQUIRE_UID_SANDBOX=1.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {(file: string, args: string[]) => Promise<unknown>} [opts.exec]  test seam
 */
export function initSandbox({ log = () => {}, exec } = {}) {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const runner = exec ?? ((file, args) => execFileAsync(file, args, { timeout: 10_000 }));
		const required = /^(1|true|yes)$/i.test(process.env.CLOUD_MODE_REQUIRE_UID_SANDBOX ?? "");
		if (/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_DISABLE_UID_SANDBOX ?? "")) {
			state = { mode: "same-uid", reason: "disabled via CLOUD_MODE_DISABLE_UID_SANDBOX" };
		} else {
			const failures = [];
			for (const strategy of DROP_STRATEGIES) {
				const [file, prefix] = strategy.build(UNTRUSTED_USER, SHARED_GROUP);
				try {
					await runner(file, [...prefix, "/usr/bin/id", "-u"]);
					state = { mode: "separate-uid", user: UNTRUSTED_USER, strategy: strategy.name };
					break;
				} catch (err) {
					const msg = String(err?.stderr ?? err?.message ?? err)
						.split("\n")
						.filter(Boolean)
						.slice(-1)[0];
					failures.push(`${strategy.name}: ${msg}`);
				}
			}
			if (state.mode !== "separate-uid") {
				state = {
					mode: "same-uid",
					reason: `no privilege-drop mechanism worked (${failures.join("; ")}) [${await dropDiagnostics(runner)}]`,
				};
			}
		}
		if (state.mode === "separate-uid") {
			log(`[cloud-mode] sandbox: ${describeSandbox(state)}`);
		} else {
			const msg =
				`[cloud-mode] SANDBOX DEGRADED — ${describeSandbox(state)}. ` +
				`Untrusted code shares the orchestrator's uid, so /proc-based credential reads are possible ` +
				`(threat model T-006/T-011/T-018).`;
			log(msg);
			if (required) throw new Error(msg.replace("[cloud-mode] ", ""));
		}
		return { ...state };
	})();
	return initPromise;
}

/** Reset memoised state — tests only. */
export function _resetSandboxForTests() {
	state = { mode: "same-uid", reason: "not initialised" };
	initPromise = undefined;
}

/**
 * Build the argv/env for running an untrusted shell command.
 *
 * `umask 002` makes files created by the untrusted user group-writable, so the
 * orchestrator (member of the shared group) can still commit, rebase and clean
 * up the worktree afterwards.
 *
 * @param {string} command  shell command (untrusted)
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.extraEnv]
 * @returns {{ file: string, args: string[], env: Record<string,string>, mode: string }}
 */
export function untrustedCommand(command, { extraEnv = {} } = {}) {
	const env = untrustedEnv({ extra: extraEnv });
	const script = `umask 002\n${command}`;
	if (state.mode !== "separate-uid") {
		return { file: "/bin/bash", args: ["-c", script], env, mode: state.mode };
	}
	const strategy = DROP_STRATEGIES.find((s) => s.name === state.strategy) ?? DROP_STRATEGIES[0];
	const [file, prefix] = strategy.build(UNTRUSTED_USER, SHARED_GROUP);
	// The privilege-drop wrappers pass the environment through, so `env -i` makes
	// the allow-list explicit and independent of the wrapper's own behaviour.
	const kv = Object.entries(env).map(([k, v]) => `${k}=${v}`);
	return {
		file,
		args: [...prefix, "/usr/bin/env", "-i", ...kv, "/bin/bash", "-c", script],
		env,
		mode: state.mode,
		strategy: strategy.name,
	};
}

/**
 * Same as `untrustedCommand`, but rendered as ONE shell command string, for
 * callers that can only rewrite a command (pi's bash tool spawns
 * `bash -c <command>`; the outer shell stays on the orchestrator uid with an
 * already-scrubbed environment, and immediately execs into the sandbox).
 */
export function untrustedCommandLine(command, { extraEnv = {} } = {}) {
	const { file, args } = untrustedCommand(command, { extraEnv });
	return ["exec", file, ...args.map(shellQuote)].join(" ");
}

/**
 * Run an untrusted shell command to completion.
 * Never rejects on a non-zero exit — returns the captured output instead.
 *
 * @returns {Promise<{ ok: boolean, code: number|null, output: string }>}
 */
export async function runUntrusted(command, { cwd, timeout, maxBuffer = 32 * 1024 * 1024, extraEnv } = {}) {
	const { file, args, env } = untrustedCommand(command, { extraEnv });
	try {
		const { stdout, stderr } = await execFileAsync(file, args, { cwd, env, maxBuffer, timeout });
		return { ok: true, code: 0, output: `${stdout}${stderr}` };
	} catch (err) {
		const output = `${err?.stdout?.toString?.() ?? ""}${err?.stderr?.toString?.() ?? err?.message ?? ""}`;
		return { ok: false, code: err?.code ?? null, output };
	}
}

/**
 * Make a path writable by the untrusted user without handing over ownership:
 * group = the shared group, group-writable, setgid on directories so new files
 * stay in the shared group. `deny` paths are then made group-read-only again —
 * used for the worktree's `.git` pointer file, which must not be rewritable by
 * untrusted code (it selects the git directory, i.e. where hooks come from).
 *
 * No-op in same-uid mode (the orchestrator user already owns everything).
 */
export async function grantUntrustedAccess({ paths = [], traverse = [], deny = [], log = () => {} } = {}) {
	if (state.mode !== "separate-uid") return { applied: false };
	const q = shellQuote;
	const script = [
		// Traversal-only: the untrusted user must reach the worktree, but must not
		// list or read the sibling clone (which holds .git and its hooks).
		...traverse.map((p) => `chmod 0711 ${q(p)}`),
		...paths.flatMap((p) => [
			`chgrp -R ${q(SHARED_GROUP)} ${q(p)} 2>/dev/null || true`,
			`chmod -R g+rwX ${q(p)}`,
			`find ${q(p)} -type d -exec chmod g+s {} +`,
		]),
		...deny.map((p) => `chmod g-w ${q(p)} 2>/dev/null || true`),
	].join("\n");
	try {
		await execFileAsync("/bin/bash", ["-c", script], { timeout: 120_000 });
		log(`[cloud-mode] sandbox: granted '${UNTRUSTED_USER}' group access to ${paths.join(", ")}`);
		return { applied: true };
	} catch (err) {
		log(`[cloud-mode] sandbox: failed to grant access (${String(err?.message ?? err).split("\n")[0]})`);
		return { applied: false, error: String(err?.message ?? err) };
	}
}
