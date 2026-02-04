import { Wallet } from "ethers";
import { ClassicValidatorCore, createClassicValidatorCores } from "../src/classic-validator-core.js";
import { Client } from "../src/client.js";
import { GenesisAccount } from "../src/common.js";

const N = 6;
const F = Math.floor((N - 1) / 3); // f = 1 for n = 6
const FINALITY = N - F; // 5

function setup(initialBalance: bigint = 1000n) {
  const clientPrivateKey = "0x" + "1".repeat(64);
  const clientWallet = new Wallet(clientPrivateKey);
  const clientAddress = clientWallet.address.toLowerCase();

  const genesisAccounts: GenesisAccount[] = [
    { address: clientAddress, balance: initialBalance },
  ];

  const { validators, validatorInfos } = createClassicValidatorCores(
    N,
    genesisAccounts,
    true, // autoBroadcast
    F
  );

  const client = new Client(validators, clientPrivateKey);
  const recipient = "0x1111111111111111111111111111111111111111";

  return { validators, validatorInfos, client, clientAddress, recipient };
}

describe("Classic FastPay Protocol", () => {
  describe("Normal transactions", () => {
    it("achieves finality with all validator votes", async () => {
      const { client, recipient, validators } = setup();

      const result = await client.sendTransaction(recipient, 100n);
      expect(result.votes).toBeGreaterThanOrEqual(FINALITY);

      const state = validators[0].getAccountState(client.address);
      expect(state.nonce).toBe(1);
      expect(state.finalised).toBe(0);
      expect(state.balance).toBe(900n);
    });

    it("handles multiple sequential transactions", async () => {
      const { client, recipient, validators } = setup();

      await client.sendTransaction(recipient, 100n);
      await client.sendTransaction(recipient, 200n);

      const state = validators[0].getAccountState(client.address);
      expect(state.nonce).toBe(2);
      expect(state.finalised).toBe(1);
      expect(state.balance).toBe(700n);
    });

    it("rejects transaction with insufficient balance", async () => {
      const { client, recipient } = setup(100n);

      const result = await client.sendTransaction(recipient, 200n);
      expect(result.votes).toBe(0);
    });

    it("rejects transaction with wrong nonce", async () => {
      const { client, recipient } = setup();
      client.nonce = 5; // wrong nonce

      const result = await client.sendTransaction(recipient, 100n);
      expect(result.votes).toBe(0);
    });
  });

  describe("Conflicting transactions", () => {
    it("causes permanent lock when votes split below finality quorum", async () => {
      const { client, validators, recipient } = setup();

      // First, do a normal tx at nonce 0 so account is not fresh
      await client.sendTransaction(recipient, 100n);

      const recipient2 = "0x2222222222222222222222222222222222222222";

      // Send conflicting txs at nonce 1 to different validator subsets
      const signedTx1a = await client.signTransaction({ to: recipient, value: 200n, nonce: 1 });
      const signedTx1b = await client.signTransaction({ to: recipient2, value: 300n, nonce: 1 });

      const splitPoint = Math.floor(N / 2);
      const firstHalf = Array.from({ length: splitPoint }, (_, i) => i);
      const secondHalf = Array.from({ length: N - splitPoint }, (_, i) => i + splitPoint);

      const votes1a = await client.sendRawTransactionTo(signedTx1a, firstHalf);
      const votes1b = await client.sendRawTransactionTo(signedTx1b, secondHalf);

      // Neither should reach finality quorum
      expect(votes1a.length).toBeLessThan(FINALITY);
      expect(votes1b.length).toBeLessThan(FINALITY);

      // Account is permanently locked - pending flag set
      const state = validators[0].getAccountState(client.address);
      expect(state.pending).toBe(true);

      // Cannot send new transactions (account is pending)
      client.nonce = 2;
      const result = await client.sendTransaction(recipient, 50n);
      expect(result.votes).toBe(0);
    });
  });

  describe("Recovery not supported", () => {
    it("throws error on getRecoveryInfo", () => {
      const { validators, client } = setup();
      expect(() => validators[0].getRecoveryInfo(client.address)).toThrow(
        "Recovery not supported in classic FastPay"
      );
    });
  });
});
