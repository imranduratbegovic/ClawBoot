import assert from "node:assert/strict";
import test from "node:test";
import { createSanitizer, publicState } from "../../setupd/security.mjs";

test("sanitizer redacts known and generic credentials", () => {
  const secret = "a-very-private-gateway-token";
  const sanitize = createSanitizer([secret]);
  const output = sanitize(
    `gateway=${secret} --gateway-token ${secret} api_key=sk-abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz`,
  );

  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(output.includes("Bearer abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("public state never includes the secret store", () => {
  const state = { mode: "pi", secrets: { gatewayToken: "nope" }, installation: {} };
  const safe = publicState(state);
  assert.equal("secrets" in safe, false);
  assert.equal(state.secrets.gatewayToken, "nope");
});

