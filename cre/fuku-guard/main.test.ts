import { describe, expect } from "bun:test";
import { test } from "@chainlink/cre-sdk/test";
import staging from "./config.staging.json";
import production from "./config.production.json";
import { actionRequestSchema, configSchema, idempotencyKeyFor, initWorkflow, type Config } from "./main";

describe("config", () => {
  test("staging and production configs satisfy the schema", () => {
    expect(configSchema.safeParse(staging).success).toBe(true);
    expect(configSchema.safeParse(production).success).toBe(true);
  });

  test("both targets read the Fuku registries on Monad testnet", () => {
    for (const c of [staging, production] as Config[]) {
      expect(c.monad.chainSelectorName).toBe("monad-testnet");
      expect(c.monad.permissionRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(c.monad.reputationRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  test("production requires an authorized trigger key", () => {
    expect((production as Config).authorizedEVMAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("request payload", () => {
  test("accepts a withdraw request with amount and app", () => {
    const r = actionRequestSchema.safeParse({ agentId: "fuku:agent:0xabc", action: "withdraw", amountUsdc: 4800, app: "Monad DEX" });
    expect(r.success).toBe(true);
  });

  test("rejects a request without an agent id or with a negative amount", () => {
    expect(actionRequestSchema.safeParse({ action: "swap" }).success).toBe(false);
    expect(actionRequestSchema.safeParse({ agentId: "x", action: "swap", amountUsdc: -1 }).success).toBe(false);
  });
});

describe("initWorkflow", () => {
  test("registers one HTTP-triggered handler", () => {
    const handlers = initWorkflow(staging as Config);
    expect(handlers).toBeArray();
    expect(handlers).toHaveLength(1);
  });

  test("uses authorized keys when an address is configured", () => {
    const [h] = initWorkflow(production as Config);
    const keys = (h.trigger.config as { authorizedKeys?: { publicKey: string }[] }).authorizedKeys ?? [];
    expect(keys.map((k) => k.publicKey)).toEqual([(production as Config).authorizedEVMAddress]);
  });

  test("leaves the trigger open for simulation when no address is configured", () => {
    const [h] = initWorkflow(staging as Config);
    const keys = (h.trigger.config as { authorizedKeys?: unknown[] }).authorizedKeys ?? [];
    expect(keys).toHaveLength(0);
  });
});

describe("request payload (A-Token payments, idempotency)", () => {
  test("accepts to, asset and a requestId", () => {
    const r = actionRequestSchema.safeParse({
      agentId: "fuku:agent:0xabc",
      action: "transfer",
      amountUsdc: 250,
      to: "0x7ad75ad75a52e8d4ee5290294c498917386f40bb",
      asset: "aUSDC",
      requestId: "order-2026-0001",
    });
    expect(r.success).toBe(true);
  });

  test("derives the same Fuku Idempotency-Key on every node", () => {
    const req = { agentId: "fuku:agent:0xabc", action: "transfer", amountUsdc: 250, to: "0x1", asset: "aUSDC" };
    expect(idempotencyKeyFor(req)).toBe(idempotencyKeyFor({ ...req }));
    expect(idempotencyKeyFor(req)).not.toBe(idempotencyKeyFor({ ...req, amountUsdc: 251 }));
    expect(idempotencyKeyFor({ ...req, requestId: "order-2026-0001" })).toBe("cre:order-2026-0001");
  });
});
