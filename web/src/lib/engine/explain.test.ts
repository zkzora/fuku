import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeScore } from "./reputation";

describe("score explanation (rule narrator)", () => {
  it("narrates every fuku-score/2 factor without throwing", async () => {
    process.env.KIMI_API_KEY = "";
    process.env.QWEN_API_KEY = "";
    const { explainScore } = await import("./explain");
    const result = computeScore({ passkeyVerified: true, apassEligible: true, hasActivePolicy: true, successes: 14, violations: 1, securityEvents: 0 });
    assert.equal(result.score, 96);
    const { text, provider } = await explainScore({ agentName: "Trading Assistant", ownerName: "Ava", result, recentViolation: null });
    assert.equal(provider, "fuku-rules");
    assert.match(text, /passkey-verified owner/);
    assert.match(text, /Cleanverse A-Pass/);
    assert.match(text, /1 blocked attempts/);
  });
});
