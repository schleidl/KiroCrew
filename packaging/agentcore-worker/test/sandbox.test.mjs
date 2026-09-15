// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the untrusted-execution boundary (worker/sandbox.mjs).
 *
 * These are the executable form of the threat model's Test-012 / Test-013:
 * repository-supplied code and LLM-issued shell commands must not be able to see
 * AWS credentials or the GitHub installation token, and — where the platform
 * allows it — must not run as the orchestrator's OS user.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	UNTRUSTED_USER,
	_resetSandboxForTests,
	describeSandbox,
	initSandbox,
	runUntrusted,
	sandboxState,
	shellQuote,
	untrustedCommand,
	untrustedCommandLine,
	untrustedEnv,
} from "../sandbox.mjs";

const SECRETS = {
	AWS_ACCESS_KEY_ID: "ASIAEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "s3cret",
	AWS_SESSION_TOKEN: "token",
	AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9/agent-credentials",
	AWS_CONTAINER_AUTHORIZATION_TOKEN: "brokertoken",
	GH_TOKEN: "ghs_installationtoken",
	GITHUB_TOKEN: "ghs_installationtoken",
	CLOUD_MODE_AGENT_ROLE_ARN: "arn:aws:iam::1:role/agent",
	PI_MODEL: "claude",
	MY_API_SECRET: "nope",
};

function withEnv(extra, fn) {
	const saved = { ...process.env };
	Object.assign(process.env, extra);
	try {
		return fn();
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in saved)) delete process.env[key];
		}
		Object.assign(process.env, saved);
	}
}

test("untrustedEnv drops every credential-bearing variable", () => {
	const env = untrustedEnv({ source: { ...process.env, ...SECRETS, PATH: "/usr/bin" } });
	for (const name of Object.keys(SECRETS)) {
		assert.equal(env[name], undefined, `${name} must not reach untrusted code`);
	}
	assert.equal(env.PATH, "/usr/bin", "a build still needs PATH");
	assert.equal(env.HOME, `/home/${UNTRUSTED_USER}`, "HOME must not be the orchestrator's home");
	assert.ok(env.COREPACK_HOME && env.npm_config_cache, "shared caches are provided");
});

test("untrustedEnv is an allow-list: unknown variables are dropped", () => {
	const env = untrustedEnv({ source: { PATH: "/bin", SOME_INTERNAL_HINT: "x" } });
	assert.equal(env.SOME_INTERNAL_HINT, undefined);
});

test("untrustedEnv passthrough is opt-in and still refuses secret-shaped names", () => {
	withEnv({ CLOUD_MODE_UNTRUSTED_ENV_PASSTHROUGH: "NPM_REGISTRY,GH_TOKEN,MY_API_SECRET" }, () => {
		const env = untrustedEnv({
			source: { PATH: "/bin", NPM_REGISTRY: "https://reg.internal", ...SECRETS },
		});
		assert.equal(env.NPM_REGISTRY, "https://reg.internal");
		assert.equal(env.GH_TOKEN, undefined);
		assert.equal(env.MY_API_SECRET, undefined);
	});
});

test("same-uid mode still scrubs, and says it is degraded", async () => {
	_resetSandboxForTests();
	const logs = [];
	const state = await initSandbox({ log: (m) => logs.push(m), exec: async () => { throw new Error("no sudo"); } });
	assert.equal(state.mode, "same-uid");
	assert.match(logs.join("\n"), /SANDBOX DEGRADED/);
	assert.match(describeSandbox(state), /orchestrator user/);

	const { file, args, env } = untrustedCommand("echo hi");
	assert.equal(file, "/bin/bash");
	assert.match(args.at(-1), /umask 002/);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	_resetSandboxForTests();
});

test("CLOUD_MODE_REQUIRE_UID_SANDBOX turns a degraded sandbox into a hard failure", async () => {
	_resetSandboxForTests();
	await withEnv({ CLOUD_MODE_REQUIRE_UID_SANDBOX: "1" }, async () => {
		await assert.rejects(
			() => initSandbox({ exec: async () => { throw new Error("no sudo"); } }),
			/SANDBOX DEGRADED|cannot switch/,
		);
	});
	_resetSandboxForTests();
});

test("separate-uid mode drops to the unprivileged user with an explicit env", async () => {
	_resetSandboxForTests();
	const calls = [];
	const state = await initSandbox({
		exec: async (file, args) => {
			calls.push([file, ...args]);
			return { stdout: "1001", stderr: "" };
		},
	});
	assert.equal(state.mode, "separate-uid");
	// setpriv is tried first: it needs no setuid binary, which is what Bedrock
	// AgentCore permits (sudo fails there).
	assert.equal(state.strategy, "setpriv");
	assert.deepEqual(calls[0], [
		"setpriv",
		`--reuid=${UNTRUSTED_USER}`,
		"--regid=cmwork",
		"--clear-groups",
		"--",
		"/usr/bin/id",
		"-u",
	]);

	const { file, args } = untrustedCommand("npm test");
	assert.equal(file, "setpriv");
	assert.deepEqual(args.slice(0, 5), [
		`--reuid=${UNTRUSTED_USER}`,
		"--regid=cmwork",
		"--clear-groups",
		"--",
		"/usr/bin/env",
	]);
	assert.equal(args.at(-2), "-c");
	assert.match(args.at(-1), /umask 002\nnpm test/);
	// No credential assignment anywhere in the argv.
	assert.doesNotMatch(args.join(" "), /AWS_SECRET_ACCESS_KEY|GH_TOKEN|AWS_CONTAINER_AUTHORIZATION_TOKEN/);
	_resetSandboxForTests();
});

test("privilege-drop strategies are tried in order and the working one is used", async () => {
	_resetSandboxForTests();
	const tried = [];
	const state = await initSandbox({
		exec: async (file) => {
			tried.push(file);
			// Emulate a platform where only sudo works.
			if (file !== "sudo") throw new Error(`${file}: not permitted`);
			return { stdout: "1001" };
		},
	});
	assert.deepEqual(tried, ["setpriv", "runuser", "sudo"]);
	assert.equal(state.strategy, "sudo");
	assert.equal(untrustedCommand("true").file, "sudo");
	_resetSandboxForTests();
});

test("a platform with no privilege drop reports every failure plus diagnostics", async () => {
	_resetSandboxForTests();
	const logs = [];
	const state = await initSandbox({
		log: (m) => logs.push(m),
		exec: async (file) => {
			if (file === "/bin/sh") return { stdout: "0 NoNewPrivs: 1 -rwxr-xr-x" };
			throw new Error(`${file}: Operation not permitted`);
		},
	});
	assert.equal(state.mode, "same-uid");
	assert.match(state.reason, /setpriv:.*runuser:.*sudo:/s, "each attempt is reported");
	assert.match(state.reason, /NoNewPrivs/, "diagnostics explain WHY it is impossible");
	assert.match(logs.join("\n"), /SANDBOX DEGRADED/);
	_resetSandboxForTests();
});

test("untrustedCommandLine quotes the payload so injection cannot escape the wrapper", async () => {
	_resetSandboxForTests();
	await initSandbox({ exec: async () => ({ stdout: "1001" }) });
	const line = untrustedCommandLine("echo 'a'; whoami");
	assert.match(line, /^exec setpriv '--reuid=cmagent' '--regid=cmwork'/);
	assert.match(line, /'umask 002\necho '\\''a'\\''; whoami'$/);
	_resetSandboxForTests();
});

test("runUntrusted executes with the scrubbed environment (real process)", async () => {
	_resetSandboxForTests();
	await initSandbox({ exec: async () => { throw new Error("force same-uid for a portable test"); } });
	const res = await withEnv(SECRETS, () => runUntrusted("env"));
	assert.equal(res.ok, true);
	assert.doesNotMatch(res.output, /ASIAEXAMPLE|s3cret|ghs_installationtoken|brokertoken/);
	_resetSandboxForTests();
});

test("runUntrusted reports failure instead of throwing", async () => {
	_resetSandboxForTests();
	await initSandbox({ exec: async () => { throw new Error("same-uid"); } });
	const res = await runUntrusted("exit 3");
	assert.equal(res.ok, false);
	_resetSandboxForTests();
});

test("shellQuote survives embedded quotes", () => {
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("sandboxState is readable before init and defaults to the weak mode", () => {
	_resetSandboxForTests();
	assert.equal(sandboxState().mode, "same-uid");
});
