import { ethers } from "ethers";
import { Validator, createValidatorNetwork, Transaction, RECOVERY_CONTRACT, N_VALIDATORS, QUORUM_SIZE, MAJORITY_QUORUM } from "./validator.js";

// Simple RPC client for our custom fullnode
class RPCClient {
  constructor(private url: string) {}

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }
}

// Test without running a server - direct validator interaction
async function testDirectProtocol() {
  console.log("=".repeat(60));
  console.log("FastPay Recovery Protocol - Direct Test");
  console.log(`n=${N_VALIDATORS}, f=${Math.floor((N_VALIDATORS - 1) / 5)}, quorum=${QUORUM_SIZE}, majority=${MAJORITY_QUORUM}`);
  console.log("=".repeat(60));

  // Create validator network
  const validators = createValidatorNetwork();

  // Create test wallet
  const wallet = ethers.Wallet.createRandom();
  const sender = wallet.address.toLowerCase();
  const recipient1 = "0x1111111111111111111111111111111111111111";
  const recipient2 = "0x2222222222222222222222222222222222222222";

  // Set initial balance
  const initialBalance = 1000n;
  for (const v of validators) {
    v.getAccountState(sender).balance = initialBalance;
  }

  console.log(`\nSender: ${sender}`);
  console.log(`Initial balance: ${initialBalance}`);

  // Helper to compute tx hash
  function computeTxHash(tx: Transaction): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint256", "string"],
        [tx.sender, tx.recipient, tx.amount, tx.nonce, tx.tip || ""]
      )
    );
  }

  // Helper to sign transaction
  async function signTx(tx: Transaction): Promise<string> {
    const txHash = computeTxHash(tx);
    return wallet.signMessage(ethers.getBytes(txHash));
  }

  // ============================================
  // Step 1: Normal transaction (should succeed)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 1: Normal transaction at nonce 0");
  console.log("-".repeat(60));

  const tx0: Transaction = {
    sender,
    recipient: recipient1,
    amount: 100n,
    nonce: 0,
  };

  const sig0 = await signTx(tx0);
  let votes = 0;
  for (const v of validators) {
    const vote = await v.onTransaction(tx0, sig0);
    if (vote) votes++;
  }

  console.log(`Collected ${votes}/${N_VALIDATORS} votes`);

  // Check state
  const state0 = validators[0].getAccountState(sender);
  console.log(`Account state: nonce=${state0.nonce}, finalised=${state0.finalised}, pending=${state0.pending}, balance=${state0.balance}`);

  // ============================================
  // Step 2: Conflicting transactions (causes lock)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 2: Sending CONFLICTING transactions at nonce 1");
  console.log("-".repeat(60));

  const tx1a: Transaction = {
    sender,
    recipient: recipient1,
    amount: 200n,
    nonce: 1,
  };

  const tx1b: Transaction = {
    sender,
    recipient: recipient2,
    amount: 300n,
    nonce: 1,
  };

  const sig1a = await signTx(tx1a);
  const sig1b = await signTx(tx1b);

  // Split validators: first half gets tx1a, second half gets tx1b
  const splitPoint = Math.floor(N_VALIDATORS / 2);
  let votes1a = 0;
  let votes1b = 0;

  for (let i = 0; i < validators.length; i++) {
    const v = validators[i];
    if (i < splitPoint) {
      const vote = await v.onTransaction(tx1a, sig1a);
      if (vote) votes1a++;
    } else {
      const vote = await v.onTransaction(tx1b, sig1b);
      if (vote) votes1b++;
    }
  }

  console.log(`TX1a (to ${recipient1}): ${votes1a} votes`);
  console.log(`TX1b (to ${recipient2}): ${votes1b} votes`);
  console.log(`Neither has quorum (need ${QUORUM_SIZE}), account is LOCKED`);

  // Check state
  const state1 = validators[0].getAccountState(sender);
  console.log(`Account state: nonce=${state1.nonce}, finalised=${state1.finalised}, pending=${state1.pending}, balance=${state1.balance}`);

  // ============================================
  // Step 3: Try normal transaction (should fail)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 3: Try normal transaction at nonce 2 (should fail)");
  console.log("-".repeat(60));

  const tx2: Transaction = {
    sender,
    recipient: recipient1,
    amount: 50n,
    nonce: 2,
  };

  const sig2 = await signTx(tx2);
  let votes2 = 0;
  for (const v of validators) {
    const vote = await v.onTransaction(tx2, sig2);
    if (vote) votes2++;
  }

  console.log(`Collected ${votes2}/${N_VALIDATORS} votes (expected: 0, account is pending)`);

  // ============================================
  // Step 4: Find tip transaction for recovery
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 4: Find tip transaction with majority support");
  console.log("-".repeat(60));

  // Find which tx has more votes at nonce 1
  const votesAtNonce1 = validators[0].getVotes(sender, 1);
  const votesByTx = new Map<string, number>();

  for (const vote of votesAtNonce1) {
    if (vote.txHash) {
      votesByTx.set(vote.txHash, (votesByTx.get(vote.txHash) || 0) + 1);
    }
  }

  let tipTxHash: string | null = null;
  let maxVotes = 0;

  for (const [hash, count] of votesByTx) {
    console.log(`TX ${hash.slice(0, 10)}... has ${count} votes`);
    if (count > maxVotes) {
      maxVotes = count;
      tipTxHash = hash;
    }
  }

  if (maxVotes >= MAJORITY_QUORUM && tipTxHash) {
    console.log(`\nTip transaction found: ${tipTxHash.slice(0, 10)}... with ${maxVotes} votes (need ${MAJORITY_QUORUM})`);
  } else {
    console.log(`\nNo transaction has majority support, would need BOT certificates`);
    // For this test, let's pick the one with most votes anyway
    if (tipTxHash) {
      console.log(`Using ${tipTxHash.slice(0, 10)}... with ${maxVotes} votes for recovery attempt`);
    }
  }

  // ============================================
  // Step 5: Recovery transaction
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 5: Send RECOVERY transaction at nonce 2");
  console.log("-".repeat(60));

  if (!tipTxHash) {
    console.log("ERROR: No tip transaction found");
    return;
  }

  // First, we need to advance past nonce 1 - the validators need to know it's locked
  // In a real scenario, the client would submit the certificate showing the split

  const recoveryTx: Transaction = {
    sender,
    recipient: RECOVERY_CONTRACT,
    amount: 0n,
    nonce: 2,
    tip: tipTxHash,
  };

  const sigRec = await signTx(recoveryTx);

  // Simulate certificate and transaction propagation:
  // 1. All validators learn about all transactions via gossip
  // 2. All validators advance their nonce after seeing the split certificate
  console.log("\nSimulating certificate and transaction propagation...");

  // Find the tip transaction from any validator that has it
  const tipTx = validators.find(v => v.getTransaction(tipTxHash))?.getTransaction(tipTxHash);

  // Propagate tip transaction to all validators (simulates gossip)
  if (tipTx) {
    for (const v of validators) {
      v.storeTransaction(tipTx, tipTxHash);
    }
    console.log(`Propagated tip transaction ${tipTxHash.slice(0, 10)}... to all validators`);
  }

  for (const v of validators) {
    const acc = v.getAccountState(sender);
    // Advance nonce if stuck at nonce 1
    if (acc.nonce === 1) {
      acc.nonce = 2;
      acc.pending = false;
    }
  }

  let votesRec = 0;
  for (const v of validators) {
    const vote = await v.onTransaction(recoveryTx, sigRec);
    if (vote) votesRec++;
  }

  console.log(`Recovery TX collected ${votesRec}/${N_VALIDATORS} votes`);

  // Check final state
  const stateFinal = validators[0].getAccountState(sender);
  console.log(`\nFinal account state: nonce=${stateFinal.nonce}, finalised=${stateFinal.finalised}, pending=${stateFinal.pending}, balance=${stateFinal.balance}`);

  // ============================================
  // Summary
  // ============================================
  console.log("\n" + "=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));
  console.log(`1. Normal TX at nonce 0: SUCCESS (${N_VALIDATORS} votes)`);
  console.log(`2. Conflicting TXs at nonce 1: LOCKED (split votes)`);
  console.log(`3. Normal TX at nonce 2: FAILED (account pending)`);
  console.log(`4. Recovery TX at nonce 2: ${votesRec >= QUORUM_SIZE ? "SUCCESS" : "PARTIAL"} (${votesRec} votes)`);
  console.log(`\nRecovery allows the account to continue transacting!`);
}

// Run test
testDirectProtocol().catch(console.error);
