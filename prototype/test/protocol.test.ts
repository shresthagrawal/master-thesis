import { ethers } from "ethers";
import { createValidatorCores, ValidatorCore, propagateVote } from "../src/validator-core.js";
import { Client } from "../src/client.js";
import {
  GenesisAccount,
  FINALITY_QUORUM,
  NOTARISATION_QUORUM,
  N_VALIDATORS,
  Vote,
} from "../src/common.js";

// Test setup helper with auto-broadcast enabled
function setup(initialBalance: bigint = 1000n): {
  validators: ValidatorCore[];
  client: Client;
  clientAddress: string;
} {
  const clientPrivateKey = "0x" + "1".repeat(64);
  const clientWallet = new ethers.Wallet(clientPrivateKey);
  const clientAddress = clientWallet.address.toLowerCase();

  const genesisAccounts: GenesisAccount[] = [
    { address: clientAddress, balance: initialBalance },
  ];

  const { validators } = createValidatorCores(N_VALIDATORS, genesisAccounts, true);
  const client = new Client(validators, clientPrivateKey);

  return { validators, client, clientAddress };
}

describe("FastPay Recovery Protocol", () => {
  describe("Normal transactions", () => {
    test("achieves finality with all validator votes", async () => {
      const { validators, client, clientAddress } = setup(1000n);
      const recipient = "0x1111111111111111111111111111111111111111";

      const result = await client.sendTransaction(recipient, 100n);

      expect(result.votes).toBe(N_VALIDATORS);

      const state = validators[0].getAccountState(clientAddress);
      expect(state.nonce).toBe(1);
      expect(state.finalised).toBe(0);
      expect(state.balance).toBe(900n);
    });

    test("handles multiple sequential transactions", async () => {
      const { validators, client, clientAddress } = setup(1000n);
      const recipient = "0x1111111111111111111111111111111111111111";

      await client.sendTransaction(recipient, 100n);
      await client.sendTransaction(recipient, 200n);
      await client.sendTransaction(recipient, 50n);

      const state = validators[0].getAccountState(clientAddress);
      expect(state.nonce).toBe(3);
      expect(state.balance).toBe(650n);
      expect(state.finalised).toBe(2);
    });

    test("rejects transaction with insufficient balance", async () => {
      const { validators, client, clientAddress } = setup(100n);
      const recipient = "0x1111111111111111111111111111111111111111";

      const result = await client.sendTransaction(recipient, 200n);

      expect(result.votes).toBe(0);

      const state = validators[0].getAccountState(clientAddress);
      expect(state.balance).toBe(100n);
    });

    test("rejects transaction with wrong nonce", async () => {
      const { validators, client, clientAddress } = setup(1000n);
      const recipient = "0x1111111111111111111111111111111111111111";

      // Manually sign with wrong nonce
      const signedTx = await client.signTransaction({ to: recipient, value: 100n, nonce: 5 });
      const results = await Promise.all(
        validators.map((v) => v.onTransaction(signedTx).catch(() => null))
      );
      const votes = results.filter((v) => v !== null).length;

      expect(votes).toBe(0);

      const state = validators[0].getAccountState(clientAddress);
      expect(state.nonce).toBe(0);
    });
  });

  describe("Conflicting transactions", () => {
    test("split 3-3 allows one tx to reach notarisation quorum", async () => {
      const { validators, client, clientAddress } = setup(1000n);
      const recipient1 = "0x1111111111111111111111111111111111111111";
      const recipient2 = "0x2222222222222222222222222222222222222222";

      // First do a normal transaction
      await client.sendTransaction(recipient1, 100n);

      // Send conflicting transactions at nonce 1, split 3-3
      // This simulates malicious client behavior (equivocation)
      const signedTx1a = await client.signTransaction({ to: recipient1, value: 200n, nonce: 1 });
      const signedTx1b = await client.signTransaction({ to: recipient2, value: 300n, nonce: 1 });

      const splitPoint = Math.floor(N_VALIDATORS / 2);
      const firstHalf = Array.from({ length: splitPoint }, (_, i) => i);
      const secondHalf = Array.from({ length: N_VALIDATORS - splitPoint }, (_, i) => i + splitPoint);

      // Send different transactions to different validator groups
      const votes1a = await client.sendRawTransactionTo(signedTx1a, firstHalf);
      const votes1b = await client.sendRawTransactionTo(signedTx1b, secondHalf);
      const allVotes = [...votes1a, ...votes1b];

      // Propagate all votes (simulating network propagation)
      for (const vote of allVotes) {
        await propagateVote(validators, vote);
      }

      // With n=6, notarisation=3, a 3-3 split means each tx has notarisation quorum
      // The nonce should advance (one tx will be notarised)
      const state = validators[0].getAccountState(clientAddress);
      expect(state.nonce).toBe(2); // Nonce advanced
      expect(state.pending).toBe(false);
    });

    test("split below notarisation quorum triggers bot signing", async () => {
      const { validators, client, clientAddress } = setup(1000n);

      // First do a normal transaction
      const recipient = "0x1111111111111111111111111111111111111111";
      await client.sendTransaction(recipient, 100n);

      // Send 6 different transactions (one per validator) - each gets only 1 vote
      // This simulates extreme equivocation
      const allVotes: Vote[] = [];
      for (let i = 0; i < validators.length; i++) {
        const uniqueRecipient = "0x" + (i + 1).toString(16).padStart(40, "0");
        const signedTx = await client.signTransaction({ to: uniqueRecipient, value: 50n, nonce: 1 });
        const votes = await client.sendRawTransactionTo(signedTx, [i]);
        allVotes.push(...votes);
      }

      // Propagate all votes - this should trigger bot signing
      for (const vote of allVotes) {
        await propagateVote(validators, vote);
      }

      // With 6 different txs, each has quorum=1, which is < notarisation (3)
      // Validators should sign bot, and bot should eventually reach notarisation quorum
      const votes = validators[0].getVotes(clientAddress, 1);
      const botVotes = votes.filter((v) => v.serializedTx === null);

      expect(botVotes.length).toBeGreaterThanOrEqual(NOTARISATION_QUORUM);
    });
  });

  describe("Recovery", () => {
    test("succeeds after bot-signed nonce", async () => {
      const { validators, client, clientAddress } = setup(1000n);

      // First do a normal transaction at nonce 0
      const recipient = "0x1111111111111111111111111111111111111111";
      await client.sendTransaction(recipient, 100n);

      // Create a split scenario where no tx gets notarisation quorum
      // Send 6 different transactions (one per validator)
      const allVotes: Vote[] = [];
      for (let i = 0; i < validators.length; i++) {
        const uniqueRecipient = "0x" + (i + 1).toString(16).padStart(40, "0");
        const signedTx = await client.signTransaction({ to: uniqueRecipient, value: 50n, nonce: 1 });
        const votes = await client.sendRawTransactionTo(signedTx, [i]);
        allVotes.push(...votes);
      }

      // Propagate all votes - triggers bot signing
      for (const vote of allVotes) {
        await propagateVote(validators, vote);
      }

      // Bot signing should have occurred and nonce advanced to 2
      const stateBeforeRecovery = validators[0].getAccountState(clientAddress);
      expect(stateBeforeRecovery.nonce).toBe(2);

      // Now initiate recovery using the client
      client.nonce = 2;
      const recoveryResult = await client.initiateRecovery();

      expect(recoveryResult).not.toBeNull();
      expect(recoveryResult!.votes).toBeGreaterThanOrEqual(FINALITY_QUORUM);

      const state = validators[0].getAccountState(clientAddress);
      expect(state.finalised).toBe(2);
      // Balance: 1000 - 100 (nonce 0) = 900
      // Nonce 1 had no tx with notarisation quorum, so tip points to nonce 0 (already executed)
      expect(state.balance).toBe(900n);
    });
  });


  describe("Vote validation", () => {
    test("rejects votes with invalid signatures", async () => {
      const { validators, client } = setup(1000n);

      const fakeVote = {
        validator: validators[0].address,
        account: client.address,
        nonce: 0,
        serializedTx: null,
        signature: "0x" + "0".repeat(130),
      };

      await expect(validators[0].onVote(fakeVote)).rejects.toThrow();
    });

    test("rejects transactions when account is pending", async () => {
      const { validators, client } = setup(1000n);
      const recipient = "0x1111111111111111111111111111111111111111";

      const signedTx = await client.signTransaction({ to: recipient, value: 100n, nonce: 0 });

      // Submit to just one validator to make account pending
      await validators[0].onTransaction(signedTx);

      // Try to submit another transaction to the same validator
      const signedTx2 = await client.signTransaction({ to: recipient, value: 50n, nonce: 0 });

      await expect(validators[0].onTransaction(signedTx2)).rejects.toThrow(/pending/);
    });
  });
});
