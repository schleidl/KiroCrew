// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AWS identity isolation (worker/aws-identity.mjs).
 *
 * Executable form of the threat model's Test-012: the worker must never place
 * AWS credentials in `process.env`, the model traffic must run on the scoped
 * (Bedrock-only) agent role when one is configured, and orchestrator work must
 * not accidentally inherit that scoped role.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	BROKER_ENV_VARS,
	FORBIDDEN_CREDENTIAL_ENV_VARS,
	_resetIdentityForTests,
	purgeStaticCredentialEnvVars,
	staticCredentialEnvVars,
	startAgentCredentialBroker,
} from "../aws-identity.mjs";

// Opaque placeholder: it is only ever handed to a stubbed AssumeRole. No real
// account id or region literal belongs in this repository.
const AGENT_ROLE = "arn:aws:iam::<account>:role/AgentRole";

function scopedCreds(over = {}) {
	return {
		accessKeyId: "ASIA_SCOPED",
		secretAccessKey: "scoped-secret",
		sessionToken: "scoped-token",
		expiration: new Date(Date.now() + 3600_000),
		...over,
	};
}

async function fetchCreds(uri, token) {
	const res = await fetch(uri, { headers: token ? { authorization: token } : {} });
	return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
}

function cleanEnv() {
	for (const name of [...BROKER_ENV_VARS, ...FORBIDDEN_CREDENTIAL_ENV_VARS, "CLOUD_MODE_REQUIRE_SCOPED_CREDS"]) {
		delete process.env[name];
	}
	_resetIdentityForTests();
}

test("broker vends the scoped agent role and never exports credentials to the env", async (t) => {
	cleanEnv();
	let assumed;
	const broker = await startAgentCredentialBroker({
		agentRoleArn: AGENT_ROLE,
		region: "<region>",
		assumeRole: async (args) => {
			assumed = args;
			return scopedCreds();
		},
	});
	t.after(() => broker.stop());

	assert.equal(broker.scope, "scoped-agent-role");
	assert.equal(assumed.roleArn, AGENT_ROLE);

	// Rung 1: the gate is satisfied by a URI + bearer token, not by a credential.
	assert.match(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, /^http:\/\/127\.0\.0\.1:\d+\/agent-credentials$/);
	assert.ok(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.length >= 64);
	assert.deepEqual(staticCredentialEnvVars(), [], "no AWS credential env vars may be set");

	// Rung 2: what is served is the scoped role, in the ECS credential shape.
	const { status, body } = await fetchCreds(broker.uri, process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN);
	assert.equal(status, 200);
	assert.equal(body.AccessKeyId, "ASIA_SCOPED");
	assert.equal(body.Token, "scoped-token");
	assert.ok(body.Expiration);
});

test("broker refuses requests without the per-process token", async (t) => {
	cleanEnv();
	const broker = await startAgentCredentialBroker({
		agentRoleArn: AGENT_ROLE,
		assumeRole: async () => scopedCreds(),
	});
	t.after(() => broker.stop());

	assert.equal((await fetchCreds(broker.uri)).status, 403);
	assert.equal((await fetchCreds(broker.uri, "wrong-token")).status, 403);
	const other = `${broker.uri.replace("/agent-credentials", "/")}`;
	assert.equal((await fetchCreds(other, process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN)).status, 404);
});

test("broker binds to loopback only", async (t) => {
	cleanEnv();
	const broker = await startAgentCredentialBroker({ agentRoleArn: AGENT_ROLE, assumeRole: async () => scopedCreds() });
	t.after(() => broker.stop());
	assert.match(broker.uri, /^http:\/\/127\.0\.0\.1:/);
});

test("credentials are refreshed when they near expiry, cached otherwise", async (t) => {
	cleanEnv();
	let calls = 0;
	const broker = await startAgentCredentialBroker({
		agentRoleArn: AGENT_ROLE,
		assumeRole: async () => {
			calls += 1;
			// First set expires almost immediately, second is long-lived.
			return scopedCreds({
				accessKeyId: `ASIA_${calls}`,
				expiration: new Date(Date.now() + (calls === 1 ? 60_000 : 3600_000)),
			});
		},
	});
	t.after(() => broker.stop());

	assert.equal(calls, 1, "the identity is proven at startup");
	const token = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
	assert.equal((await fetchCreds(broker.uri, token)).body.AccessKeyId, "ASIA_2", "expiring set is refreshed");
	assert.equal((await fetchCreds(broker.uri, token)).body.AccessKeyId, "ASIA_2", "fresh set is cached");
	assert.equal(calls, 2);
});

test("no agent role is reported as not-applicable, and still fails hard when scoped creds are required", async (t) => {
	cleanEnv();
	const logs = [];
	const broker = await startAgentCredentialBroker({
		agentRoleArn: undefined,
		log: (m) => logs.push(m),
		ambient: async () => scopedCreds({ accessKeyId: "ASIA_RUNTIME_ROLE" }),
		assumeRole: async () => {
			throw new Error("must not be called without a role arn");
		},
	});
	t.after(() => broker.stop());
	assert.equal(broker.scope, "runtime-role");
	// Reworded from the reference's "CREDENTIAL SCOPE DEGRADED": a bearer-authenticated
	// agent signs no Bedrock request, so there is no model traffic for a scoped role to
	// narrow and the stack deliberately creates none. The message must not name a
	// mitigation that does not exist, but it must still be explicit about what is and
	// is not fenced — hence both assertions below.
	assert.match(logs.join("\n"), /NOT APPLICABLE/);
	assert.match(logs.join("\n"), /vended over loopback/);
	assert.doesNotMatch(logs.join("\n"), /DEGRADED/);
	assert.deepEqual(staticCredentialEnvVars(), []);
	assert.equal(
		(await fetchCreds(broker.uri, process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN)).body.AccessKeyId,
		"ASIA_RUNTIME_ROLE",
	);

	await broker.stop();
	process.env.CLOUD_MODE_REQUIRE_SCOPED_CREDS = "1";
	await assert.rejects(
		() => startAgentCredentialBroker({ agentRoleArn: undefined, ambient: async () => scopedCreds() }),
		/NOT APPLICABLE/,
	);
	delete process.env.CLOUD_MODE_REQUIRE_SCOPED_CREDS;
});

test("stop() removes the broker coordinates from the environment", async () => {
	cleanEnv();
	const broker = await startAgentCredentialBroker({ agentRoleArn: AGENT_ROLE, assumeRole: async () => scopedCreds() });
	assert.ok(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
	await broker.stop();
	for (const name of BROKER_ENV_VARS) assert.equal(process.env[name], undefined);
});

test("purgeStaticCredentialEnvVars removes a reintroduced T-011 exposure", () => {
	cleanEnv();
	process.env.AWS_ACCESS_KEY_ID = "ASIA_LEGACY";
	process.env.AWS_SECRET_ACCESS_KEY = "legacy";
	process.env.AWS_SESSION_TOKEN = "legacy";
	const logs = [];
	const removed = purgeStaticCredentialEnvVars({ log: (m) => logs.push(m) });
	assert.deepEqual(removed, FORBIDDEN_CREDENTIAL_ENV_VARS);
	assert.deepEqual(staticCredentialEnvVars(), []);
	assert.match(logs.join("\n"), /never see long-lived credentials/);
});

/**
 * Mechanism check: the AWS SDK's HTTP credential provider — the one pi's Bedrock
 * client ends up using — really resolves credentials from the loopback broker,
 * and really rejects a wrong bearer token. This is what makes rung 1 possible:
 * signing works with nothing secret in the environment.
 */
test("the AWS SDK resolves the vended credentials from the broker (no env credentials)", async (t) => {
	cleanEnv();
	const { createRequire } = await import("node:module");
	const require = createRequire(new URL("../package.json", import.meta.url));
	const { fromHttp } = require("@aws-sdk/credential-provider-http");

	const broker = await startAgentCredentialBroker({
		agentRoleArn: AGENT_ROLE,
		assumeRole: async () => scopedCreds({ accessKeyId: "ASIA_VIA_SDK" }),
	});
	t.after(() => broker.stop());

	const resolved = await fromHttp({
		credentialsFullUri: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
		authorizationToken: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN,
	})();
	assert.equal(resolved.accessKeyId, "ASIA_VIA_SDK");
	assert.equal(resolved.sessionToken, "scoped-token");
	assert.deepEqual(staticCredentialEnvVars(), [], "still nothing secret in the environment");

	// The bearer token is enforced by the broker itself (see the 403 test above).
	// Note that any process which can READ this process's environment can present
	// it — which is exactly why untrusted code runs under a different OS user
	// (sandbox.mjs); the token alone is not the boundary.
	assert.equal((await fetchCreds(broker.uri, "not-the-token")).status, 403);
});
