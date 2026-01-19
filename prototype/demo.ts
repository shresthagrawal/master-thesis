import { Wallet } from "ethers";
import { createValidatorNetwork, RemoteValidator, GenesisAccount } from "./src/validator.js";
import { Client } from "./src/client.js";
import { N_VALIDATORS, FINALITY_QUORUM, NOTARISATION_QUORUM, ValidatorInfo } from "./src/common.js";

async function runDemo() {
  console.log("=".repeat(60));
  console.log("FastPay Recovery Protocol - Network Demo");
  console.log(`n=${N_VALIDATORS}, f=${Math.floor((N_VALIDATORS - 1) / 5)}, finality=${FINALITY_QUORUM}, notarisation=${NOTARISATION_QUORUM}`);
  console.log("=".repeat(60));

  // Create client wallet first to get address for genesis
  const clientPrivateKey = "0x" + "1".repeat(64);
  const clientWallet = new Wallet(clientPrivateKey);
  const clientAddress = clientWallet.address.toLowerCase();

  const recipient1 = "0x1111111111111111111111111111111111111111";
  const recipient2 = "0x2222222222222222222222222222222222222222";
  const initialBalance = 1000n;

  // Create genesis accounts
  const genesisAccounts: GenesisAccount[] = [
    { address: clientAddress, balance: initialBalance },
  ];

  // Create and start validator servers
  const servers = createValidatorNetwork(N_VALIDATORS, genesisAccounts, 4000);

  // Start all validator servers
  await Promise.all(servers.map((s) => s.start()));

  // Wait for servers to be ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Create remote validators for client to use
  const validatorInfos: ValidatorInfo[] = servers.map((s) => ({
    address: s.address,
    host: s.host,
    port: s.port,
  }));
  const remoteValidators = validatorInfos.map((info) => new RemoteValidator(info));

  // Create client with remote validators
  const client = new Client(remoteValidators, clientPrivateKey);

  console.log(`\nSender: ${client.address}`);
  console.log(`Initial balance: ${initialBalance}`);

  // ============================================
  // Step 1: Normal transaction (should succeed)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 1: Normal transaction at nonce 0");
  console.log("-".repeat(60));

  const result0 = await client.sendTransaction(recipient1, 100n);
  console.log(`Collected ${result0.votes}/${N_VALIDATORS} votes`);

  // Wait for vote propagation between validators
  await new Promise((resolve) => setTimeout(resolve, 100));

  const state0 = servers[0].getAccountState(client.address);
  console.log(`Account state: nonce=${state0.nonce}, finalised=${state0.finalised}, balance=${state0.balance}`);

  // ============================================
  // Step 2: Conflicting transactions (causes lock)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 2: Sending CONFLICTING transactions at nonce 1");
  console.log("-".repeat(60));

  // Sign conflicting transactions at same nonce (equivocation)
  const signedTx1a = await client.signTransaction({ to: recipient1, value: 200n, nonce: 1 });
  const signedTx1b = await client.signTransaction({ to: recipient2, value: 300n, nonce: 1 });

  const splitPoint = Math.floor(N_VALIDATORS / 2);
  const firstHalf = Array.from({ length: splitPoint }, (_, i) => i);
  const secondHalf = Array.from({ length: N_VALIDATORS - splitPoint }, (_, i) => i + splitPoint);

  // Send conflicting transactions to different validator groups
  const votes1a = await client.sendRawTransactionTo(signedTx1a, firstHalf);
  const votes1b = await client.sendRawTransactionTo(signedTx1b, secondHalf);

  console.log(`TX1a (to ${recipient1}): ${votes1a.length} votes`);
  console.log(`TX1b (to ${recipient2}): ${votes1b.length} votes`);
  console.log(`Neither has finality quorum (need ${FINALITY_QUORUM}), account is LOCKED`);

  // ============================================
  // Step 3: Try normal transaction (should fail)
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 3: Try normal transaction at nonce 2 (should fail)");
  console.log("-".repeat(60));

  client.nonce = 2;
  const result2 = await client.sendTransaction(recipient1, 50n);
  console.log(`Collected ${result2.votes}/${N_VALIDATORS} votes (expected: 0, account is pending)`);

  // ============================================
  // Step 4: Query validators for recovery info
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 4: Query validators for recovery info");
  console.log("-".repeat(60));

  // Simulate nonce advancement (in practice this happens via certificate propagation)
  for (const s of servers) {
    const acc = s.getAccountState(client.address);
    if (acc.nonce === 1) {
      acc.nonce = 2;
      acc.pending = false;
    }
  }

  // Query each validator for recovery info
  const responses = await client.queryRecoveryInfo();
  for (const r of responses) {
    console.log(`Response: finalised=${r.finalisedNonce}, nonce=${r.currentNonce}, chain=${r.chain.length} entries`);
  }

  const { tipTx, nonce } = client.findTipTransaction(responses);
  console.log(`\nUsing nonce ${nonce}, tip tx ${tipTx?.hash?.slice(0, 10)}...`);

  // Wait for vote propagation before recovery
  await new Promise((resolve) => setTimeout(resolve, 200));

  // ============================================
  // Step 5: Recovery transaction
  // ============================================
  console.log("\n" + "-".repeat(60));
  console.log("Step 5: Send RECOVERY transaction");
  console.log("-".repeat(60));

  const recoveryResult = await client.initiateRecovery();
  if (!recoveryResult) {
    console.log("ERROR: No tip transaction found");
    process.exit(1);
  }

  console.log(`Recovery TX collected ${recoveryResult.votes}/${N_VALIDATORS} votes`);

  const stateFinal = servers[0].getAccountState(client.address);
  console.log(`\nFinal state: nonce=${stateFinal.nonce}, finalised=${stateFinal.finalised}, balance=${stateFinal.balance}`);

  process.exit(0);
}

runDemo().catch(console.error);
