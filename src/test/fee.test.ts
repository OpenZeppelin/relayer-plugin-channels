import { describe, test, expect } from "vitest";
import { calculateMaxFee } from "../fee";
import { TransactionBuilder, Account, Networks } from "@stellar/stellar-sdk";

describe("fee", () => {
  const passphrase = Networks.TESTNET;

  function buildSimpleTx(): any {
    const acc = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "1",
    );
    return new TransactionBuilder(acc, {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .setTimeout(30)
      .build();
  }

  test("non-soroban uses offset + base", () => {
    const orig = Math.random;
    Math.random = () => 0; // pick min base fee
    const tx = buildSimpleTx();
    const fee = calculateMaxFee(tx);
    expect(typeof fee).toBe("number");
    expect(fee).toBeGreaterThan(0);
    Math.random = orig;
  });

  test("clamps to MAX_FEE when set", () => {
    const tx = buildSimpleTx();
    const old = process.env.MAX_FEE;
    process.env.MAX_FEE = "1000";
    const fee = calculateMaxFee(tx);
    expect(fee).toBeLessThanOrEqual(1000);
    process.env.MAX_FEE = old;
  });
});
