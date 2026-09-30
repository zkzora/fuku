import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demoEnabled, safeNextPath } from "./demo-mode";
import { sessionSecret } from "./session";
import { LIMITS, rateLimit, RateLimitError, resetRateLimits } from "./rate-limit";
import { parseWalletBindingMessage, walletBindingMessage } from "./wallet-binding";

describe("production gating", () => {
  it("turns the demo off in production unless explicitly enabled", () => {
    assert.equal(demoEnabled({ NODE_ENV: "development" }), true);
    assert.equal(demoEnabled({ NODE_ENV: "production" }), false);
    assert.equal(demoEnabled({ NODE_ENV: "production", FUKU_DEMO_ENABLED: "true" }), true);
    assert.equal(demoEnabled({ NODE_ENV: "development", FUKU_DEMO_ENABLED: "false" }), false);
  });

  it("refuses weak or default session secrets in production", () => {
    assert.throws(() => sessionSecret({ NODE_ENV: "production" }), /FUKU_SESSION_SECRET/);
    assert.throws(() => sessionSecret({ NODE_ENV: "production", FUKU_SESSION_SECRET: "fuku-dev-secret" }), /FUKU_SESSION_SECRET/);
    assert.throws(() => sessionSecret({ NODE_ENV: "production", FUKU_SESSION_SECRET: "change-me-to-a-long-random-string" }), /FUKU_SESSION_SECRET/);
    assert.throws(() => sessionSecret({ NODE_ENV: "production", FUKU_SESSION_SECRET: "short" }), /FUKU_SESSION_SECRET/);
    assert.equal(sessionSecret({ NODE_ENV: "production", FUKU_SESSION_SECRET: "x".repeat(40) }).length, 40);
    assert.ok(sessionSecret({ NODE_ENV: "development" }).length > 0);
  });

  it("only redirects to same-site paths", () => {
    assert.equal(safeNextPath("/permissions?agent=x"), "/permissions?agent=x");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "/ok\r\nSet-Cookie: x", null]) {
      assert.equal(safeNextPath(bad), "/dashboard", String(bad));
    }
  });
});

describe("rate limits", () => {
  it("are bounded per bucket and subject", () => {
    resetRateLimits();
    const { limit, windowMs } = LIMITS.auth;
    for (let i = 0; i < limit; i++) rateLimit("auth", "1.2.3.4", 1_000);
    assert.throws(() => rateLimit("auth", "1.2.3.4", 1_000), RateLimitError);
    rateLimit("auth", "5.6.7.8", 1_000); // another subject has its own window
    rateLimit("auth", "1.2.3.4", 1_000 + windowMs); // the window resets
  });
});

describe("wallet binding message", () => {
  it("round-trips and rejects tampered messages", () => {
    const f = {
      identityId: "fuku:id:0xabc",
      wallet: "0x7ad75ad75a52e8d4ee5290294c498917386f40bb",
      nonce: "n1",
      chainId: 10143,
      issuedAt: "2026-09-30T00:00:00.000Z",
      expiresAt: "2026-09-30T00:05:00.000Z",
    };
    const msg = walletBindingMessage(f);
    const parsed = parseWalletBindingMessage(msg)!;
    assert.equal(parsed.identityId, f.identityId);
    assert.equal(parsed.wallet.toLowerCase(), f.wallet);
    assert.equal(parseWalletBindingMessage(msg.replace("Fuku wallet binding", "Other")), null);
    assert.equal(parseWalletBindingMessage(msg + "\nextra"), null);
  });
});
