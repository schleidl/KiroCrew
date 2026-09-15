// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS identity isolation for the Cloud Mode worker (threat model T-011, T-019 /
 * mitigation M-012).
 *
 * ── The problem this replaces ────────────────────────────────────────────────
 * The worker used to copy the AgentCore runtime role's credentials into
 * `process.env` (AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN) before starting the
 * agent. Those credentials can read the GitHub App private key from Secrets
 * Manager, so any code execution inside the session — a prompt injection, a
 * hostile `npm test` — escalated to write access on every repository the App is
 * installed on.
 *
 * The export existed for one reason only: pi's amazon-bedrock provider refuses
 * to attempt a call unless it can SEE a known AWS credential env var. It never
 * used those values for signing — the AWS SDK resolves credentials on its own.
 *
 * ── What this module does ───────────────────────────────────────────────────
 * 1. RUNG 1 — no long-lived secret in the environment. Nothing here ever writes
 *    an access key or session token into `process.env`. pi's presence check is
 *    satisfied with `AWS_CONTAINER_CREDENTIALS_FULL_URI` +
 *    `AWS_CONTAINER_AUTHORIZATION_TOKEN`, which point at a loopback endpoint,
 *    not at a credential.
 *
 * 2. RUNG 2 — two identities instead of one:
 *      • ORCHESTRATOR identity = the ambient runtime role (Secrets Manager read,
 *        STS, ECR, logs). Resolved through the SDK chain and kept in memory;
 *        handed explicitly to the clients that need it (see secrets.mjs).
 *      • AGENT identity = a second role (`CLOUD_MODE_AGENT_ROLE_ARN`) that can
 *        do nothing but invoke the pinned Bedrock model. It is assumed by the
 *        orchestrator and vended over loopback for the model traffic.
 *    Result: full code execution inside the session yields a Bedrock-only
 *    credential — `secretsmanager:GetSecretValue` on the App key is denied.
 *
 * The broker binds to 127.0.0.1 with a 256-bit per-process bearer token, so
 * reaching it requires being inside this container. Combined with the uid split
 * in sandbox.mjs (untrusted code runs as another user and cannot read this
 * process's environment), untrusted code cannot obtain even the scoped
 * credential.
 *
 * If no agent role is configured, the broker vends the ambient runtime-role
 * credentials and reports `scope: "runtime-role"` LOUDLY — rung 1 still holds
 * (nothing in the environment), but rung 2 does not. Set
 * `CLOUD_MODE_REQUIRE_SCOPED_CREDS=1` to make that a hard failure instead.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";

const require = createRequire(import.meta.url);

/** Env vars the broker publishes. Hidden while resolving orchestrator creds. */
export const BROKER_ENV_VARS = ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN"];

/** Credential env vars that must never be set by us (rung 1 invariant). */
export const FORBIDDEN_CREDENTIAL_ENV_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

const CREDENTIAL_PATH = "/agent-credentials";
const REFRESH_SKEW_MS = 5 * 60_000;

let ambientChain;
function chain() {
	// @aws-sdk/credential-provider-node is CommonJS; require it for ESM interop.
	if (!ambientChain) {
		const { defaultProvider } = require("@aws-sdk/credential-provider-node");
		ambientChain = defaultProvider();
	}
	return ambientChain;
}

/**
 * Resolve credentials from the ambient chain with the broker's env vars hidden.
 *
 * Without this, the SDK's HTTP credential provider would happily resolve the
 * *scoped agent* credentials for orchestrator work (Secrets Manager, STS) —
 * silently breaking secret reads once the runtime role's own credentials expire.
 * The window is a few milliseconds inside one event-loop turn.
 */
async function resolveAmbient() {
	/** @type {Record<string, string | undefined>} */
	const saved = {};
	for (const name of BROKER_ENV_VARS) {
		if (name in process.env) {
			saved[name] = process.env[name];
			delete process.env[name];
		}
	}
	try {
		return await chain()();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value !== undefined) process.env[name] = value;
		}
	}
}

let ambientCache;
/**
 * Orchestrator (runtime-role) credentials, memoised until shortly before expiry.
 * Pass this function directly as an AWS SDK client's `credentials` option: the
 * client then never consults the environment, so the broker cannot shadow it.
 */
export async function orchestratorCredentials() {
	const expiry = ambientCache?.expiration ? new Date(ambientCache.expiration).getTime() : undefined;
	if (ambientCache && (!expiry || expiry - Date.now() > REFRESH_SKEW_MS)) return ambientCache;
	ambientCache = await resolveAmbient();
	return ambientCache;
}

/** Reset memoised credentials — tests only. */
export function _resetIdentityForTests() {
	ambientCache = undefined;
	ambientChain = undefined;
}

/**
 * Report credential env vars that are set in this process. Should always be
 * empty: AgentCore does not inject them and this worker never exports them.
 * A non-empty result means something reintroduced the T-011 exposure.
 */
export function staticCredentialEnvVars(source = process.env) {
	return FORBIDDEN_CREDENTIAL_ENV_VARS.filter((name) => !!source[name]);
}

/** Remove any credential env vars found, returning the names that were removed. */
export function purgeStaticCredentialEnvVars({ log = () => {} } = {}) {
	const found = staticCredentialEnvVars();
	for (const name of found) delete process.env[name];
	if (found.length > 0) {
		log(
			`[cloud-mode] purged AWS credential env vars (${found.join(", ")}): the agent's process tree must ` +
				`never see long-lived credentials (threat model T-011).`,
		);
	}
	return found;
}

function tokensMatch(a, b) {
	const x = Buffer.from(String(a ?? ""));
	const y = Buffer.from(String(b ?? ""));
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Assume the Bedrock-only agent role. Kept in a function so tests can stub it.
 */
async function assumeAgentRole({ roleArn, region, sessionName, durationSeconds }) {
	const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
	const sts = new STSClient({ region, credentials: orchestratorCredentials });
	const res = await sts.send(
		new AssumeRoleCommand({
			RoleArn: roleArn,
			RoleSessionName: sessionName.slice(0, 64),
			DurationSeconds: durationSeconds,
		}),
	);
	const c = res.Credentials;
	if (!c?.AccessKeyId || !c?.SecretAccessKey) throw new Error("AssumeRole returned no credentials");
	return {
		accessKeyId: c.AccessKeyId,
		secretAccessKey: c.SecretAccessKey,
		sessionToken: c.SessionToken,
		expiration: c.Expiration ? new Date(c.Expiration) : undefined,
	};
}

/**
 * Start the loopback credential broker and publish its coordinates in the
 * environment.
 *
 * @param {object} [opts]
 * @param {string} [opts.agentRoleArn]  Bedrock-only role to assume (CLOUD_MODE_AGENT_ROLE_ARN)
 * @param {string} [opts.region]
 * @param {string} [opts.sessionName]
 * @param {number} [opts.durationSeconds]
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof assumeAgentRole} [opts.assumeRole]  test seam
 * @returns {Promise<{ uri: string, scope: "scoped-agent-role"|"runtime-role", roleArn?: string, describe: string, stop: () => Promise<void>, credentials: () => Promise<object> }>}
 */
export async function startAgentCredentialBroker({
	agentRoleArn = process.env.CLOUD_MODE_AGENT_ROLE_ARN?.trim(),
	region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
	sessionName = `cloud-mode-agent-${process.pid}`,
	durationSeconds = Number(process.env.CLOUD_MODE_AGENT_ROLE_DURATION ?? 3600),
	log = () => {},
	assumeRole = assumeAgentRole,
	/** test seam: resolve the ambient (runtime-role) credentials */
	ambient = resolveAmbient,
} = {}) {
	const requireScoped = /^(1|true|yes)$/i.test(process.env.CLOUD_MODE_REQUIRE_SCOPED_CREDS ?? "");
	const scope = agentRoleArn ? "scoped-agent-role" : "runtime-role";

	if (!agentRoleArn) {
		// NOT a degradation in this worker. The reference implementation ran a
		// Bedrock-calling agent, so a Bedrock-only role was a real mitigation there.
		// A kiro-cli agent authenticates to Kiro with a bearer token and never
		// signs a Bedrock request, so there is no model traffic for a scoped role to
		// narrow — the AgentCore stack deliberately does not create one. Reporting
		// DEGRADED here would name a mitigation that does not exist, which reads to
		// an operator as a misconfiguration.
		//
		// The credential fence that does apply is the broker itself: the runtime
		// role's keys are never exported into the environment, so untrusted code
		// cannot reach them even though the broker vends the runtime identity.
		const msg =
			`[worker] credential scope: no scoped agent role — NOT APPLICABLE for a bearer-authenticated ` +
			`agent, which issues no signed Bedrock calls. Untrusted code still cannot read the runtime ` +
			`role's keys: they stay out of the environment and are vended over loopback only.`;
		log(msg);
		if (requireScoped) throw new Error(msg.replace("[worker] ", ""));
	}

	const token = randomBytes(32).toString("hex");
	/** @type {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, expiration?: Date } | undefined} */
	let cached;

	async function current() {
		const expiry = cached?.expiration ? new Date(cached.expiration).getTime() : undefined;
		if (cached && (!expiry || expiry - Date.now() > REFRESH_SKEW_MS)) return cached;
		cached = agentRoleArn
			? await assumeRole({ roleArn: agentRoleArn, region, sessionName, durationSeconds })
			: await ambient();
		return cached;
	}

	const server = createServer(async (req, res) => {
		const path = (req.url ?? "").split("?")[0];
		if (path !== CREDENTIAL_PATH) {
			res.writeHead(404).end();
			return;
		}
		if (!tokensMatch(req.headers.authorization, token)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const c = await current();
			// ECS container-credentials response shape (what the SDK expects).
			const body = JSON.stringify({
				AccessKeyId: c.accessKeyId,
				SecretAccessKey: c.secretAccessKey,
				Token: c.sessionToken,
				Expiration: (c.expiration ? new Date(c.expiration) : new Date(Date.now() + 15 * 60_000)).toISOString(),
			});
			res.writeHead(200, { "content-type": "application/json" }).end(body);
		} catch (err) {
			res.writeHead(500, { "content-type": "application/json" }).end(
				JSON.stringify({ message: String(err?.message ?? err) }),
			);
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	server.unref();
	const { port } = /** @type {{ port: number }} */ (server.address());
	const uri = `http://127.0.0.1:${port}${CREDENTIAL_PATH}`;

	// Fail fast: prove the identity works before an agent depends on it.
	await current();

	// pi's provider gate is satisfied by these two names; neither is a credential.
	process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = uri;
	process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = token;
	purgeStaticCredentialEnvVars({ log });

	const describe =
		scope === "scoped-agent-role"
			? `model traffic uses scoped agent role ${agentRoleArn} (Bedrock invoke only), vended over loopback`
			: `model traffic uses the full runtime role (no scoped agent role configured), vended over loopback`;
	log(`[cloud-mode] credentials: ${describe}`);

	return {
		uri,
		scope,
		roleArn: agentRoleArn,
		describe,
		credentials: current,
		stop: () =>
			new Promise((resolve) => {
				for (const name of BROKER_ENV_VARS) delete process.env[name];
				server.close(() => resolve(undefined));
			}),
	};
}
