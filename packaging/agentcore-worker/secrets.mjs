// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret resolution for the worker.
 *
 * AgentCore Runtime has no ECS-style secret injection, so the worker resolves
 * GitHub App credentials at runtime from AWS Secrets Manager using its execution
 * role. For local testing the raw values may instead be provided directly via
 * env vars (GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY).
 *
 * The agent child's model credential (KIRO_API_KEY) is resolved the same way —
 * see `resolveKiroApiKey` — and lives only in this process's memory and the
 * child's environment.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { orchestratorCredentials } from "./aws-identity.mjs";

let client;
function sm() {
	// Explicit ORCHESTRATOR credentials (the ambient runtime role), never the
	// ambient environment: the loopback credential broker publishes
	// AWS_CONTAINER_CREDENTIALS_FULL_URI for the model traffic, and a client that
	// resolved credentials from the environment would silently pick up the
	// Bedrock-only agent role instead (threat model T-011 / mitigation M-012).
	if (!client) {
		client = new SecretsManagerClient({
			region: process.env.AWS_REGION,
			credentials: orchestratorCredentials,
		});
	}
	return client;
}

async function getSecret(idOrArn) {
	const res = await sm().send(new GetSecretValueCommand({ SecretId: idOrArn }));
	return res.SecretString ?? "";
}

/**
 * Resolve the three GitHub App credentials. Prefers direct env vars; otherwise
 * fetches from the secret ids/ARNs in *_SECRET env vars.
 */
export async function resolveGitHubAppCreds() {
	const [appId, installationId, privateKey] = await Promise.all([
		process.env.GH_APP_ID ?? (process.env.GH_APP_ID_SECRET ? getSecret(process.env.GH_APP_ID_SECRET) : undefined),
		process.env.GH_APP_INSTALLATION_ID ??
			(process.env.GH_INSTALLATION_ID_SECRET ? getSecret(process.env.GH_INSTALLATION_ID_SECRET) : undefined),
		process.env.GH_APP_PRIVATE_KEY ??
			(process.env.GH_PRIVATE_KEY_SECRET ? getSecret(process.env.GH_PRIVATE_KEY_SECRET) : undefined),
	]);

	if (!appId || !installationId || !privateKey) {
		throw new Error(
			"Missing GitHub App credentials. Provide GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY " +
				"directly, or GH_APP_ID_SECRET / GH_INSTALLATION_ID_SECRET / GH_PRIVATE_KEY_SECRET pointing at " +
				"Secrets Manager entries.",
		);
	}
	return { appId: String(appId).trim(), installationId: String(installationId).trim(), privateKey };
}

/**
 * Resolve the agent child's model credential (`KIRO_API_KEY`).
 *
 * Same shape as `resolveGitHubAppCreds`: a direct env var for local testing,
 * otherwise a Secrets Manager id/ARN named by `KIRO_API_KEY_SECRET`, read with
 * the ORCHESTRATOR identity (never the ambient environment — see `sm()`).
 *
 * The resolved value is handed to exactly one place: the environment of the
 * `kiro-cli acp` child. It is never logged, never written to disk, never put on
 * a command line and never carried in an event. WP1's probe established that
 * ACP mode authenticates with this key alone and fails fast without it, so
 * there is no in-protocol handshake and no fallback login to suppress.
 *
 * A trailing newline is stripped: Secrets Manager values pasted by a human
 * routinely carry one, and an ACP child that receives `ksk_…\n` fails
 * authentication with an error that names nothing useful.
 */
export async function resolveKiroApiKey({ required = true, env = process.env, fetchSecret = getSecret } = {}) {
	const direct = env.KIRO_API_KEY;
	const value = direct ?? (env.KIRO_API_KEY_SECRET ? await fetchSecret(env.KIRO_API_KEY_SECRET) : undefined);
	const key = typeof value === "string" ? value.trim() : "";
	if (!key) {
		if (!required) return undefined;
		throw new Error(
			"Missing model credential. Provide KIRO_API_KEY directly, or KIRO_API_KEY_SECRET pointing at a " +
				"Secrets Manager entry the runtime role may read. The agent child cannot authenticate without it.",
		);
	}
	return key;
}
