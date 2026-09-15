// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveKiroApiKey` — the model credential's resolution path.
 *
 * Shaped after `resolveGitHubAppCreds`: a direct env var for local testing,
 * otherwise a Secrets Manager id named by an env var, read with the orchestrator
 * identity. The Secrets Manager call itself is a seam here, so these tests make
 * no AWS call.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveKiroApiKey } from "../secrets.mjs";

test("a directly supplied key wins and no secret is fetched", async () => {
	let fetched = 0;
	const key = await resolveKiroApiKey({
		env: { KIRO_API_KEY: "ksk_direct", KIRO_API_KEY_SECRET: "worker/model-credential" },
		fetchSecret: async () => {
			fetched += 1;
			return "ksk_from_secrets_manager";
		},
	});
	assert.equal(key, "ksk_direct");
	assert.equal(fetched, 0, "the env var short-circuits the API call, as for the GitHub App creds");
});

test("otherwise the key comes from the Secrets Manager id named in the environment", async () => {
	const asked = [];
	const key = await resolveKiroApiKey({
		env: { KIRO_API_KEY_SECRET: "worker/model-credential" },
		fetchSecret: async (id) => {
			asked.push(id);
			return "ksk_from_secrets_manager";
		},
	});
	assert.equal(key, "ksk_from_secrets_manager");
	assert.deepEqual(asked, ["worker/model-credential"], "the env var names the secret; the id is never hardcoded");
});

test("a trailing newline is stripped, because a pasted secret routinely carries one", async () => {
	const key = await resolveKiroApiKey({
		env: { KIRO_API_KEY_SECRET: "worker/model-credential" },
		fetchSecret: async () => "ksk_padded\n",
	});
	assert.equal(key, "ksk_padded");
});

test("a missing credential fails loudly and names both ways to supply one", async () => {
	await assert.rejects(() => resolveKiroApiKey({ env: {}, fetchSecret: async () => "" }), (err) => {
		assert.match(err.message, /KIRO_API_KEY/);
		assert.match(err.message, /KIRO_API_KEY_SECRET/);
		return true;
	});
});

test("an empty secret value is treated as missing rather than as a valid key", async () => {
	await assert.rejects(() =>
		resolveKiroApiKey({ env: { KIRO_API_KEY_SECRET: "worker/model-credential" }, fetchSecret: async () => "   " }),
	);
});

test("required:false lets a caller probe for the credential without throwing", async () => {
	assert.equal(await resolveKiroApiKey({ required: false, env: {}, fetchSecret: async () => "" }), undefined);
});

test("no account id, ARN or region literal is baked into the resolver", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../secrets.mjs", import.meta.url), "utf-8");
	assert.doesNotMatch(source, /\b\d{12}\b/, "no AWS account id");
	assert.doesNotMatch(source, /arn:aws/, "no ARN");
	assert.doesNotMatch(source, /\b(us|eu|ap|sa|ca|me|af)-[a-z]+-\d\b/, "no region literal");
});
