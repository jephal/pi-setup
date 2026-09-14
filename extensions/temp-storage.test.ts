import assert from "node:assert/strict";
import test from "node:test";
import { DISABLE_PRIVATE_TEMP_ENV, PRIVATE_TEMP_DIR_ENV, isKnownTempArtifact, resolvePrivateTempDirectory } from "./temp-storage.ts";

test("private temp storage prefers the configured absolute directory", () => {
	assert.equal(resolvePrivateTempDirectory({ [PRIVATE_TEMP_DIR_ENV]: "/run/user/1003/custom-pi" }), "/run/user/1003/custom-pi");
});

test("private temp storage uses the user runtime directory by default", () => {
	assert.equal(
		resolvePrivateTempDirectory({ XDG_RUNTIME_DIR: "/run/user/1003" }),
		"/run/user/1003/pi-setup",
	);
});

test("private temp storage falls back to a private cache path", () => {
	const result = resolvePrivateTempDirectory({ HOME: "/home/test-user" });
	assert.equal(result, "/home/test-user/.cache/pi-setup/tmp");
});

test("known artifact detection is prefix-scoped", () => {
	assert.equal(isKnownTempArtifact("pi-bash-example.log"), true);
	assert.equal(isKnownTempArtifact("pi-fovea-scan-example"), true);
	assert.equal(isKnownTempArtifact("unrelated-cache"), false);
});

test("the disable flag remains an explicit opt-out", () => {
	assert.equal(DISABLE_PRIVATE_TEMP_ENV, "PI_SETUP_DISABLE_PRIVATE_TEMP");
});
