import { ethers, Wallet } from "ethers";
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Vote, RECOVERY_CONTRACT } from "./src/common.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TxResult {
  clientId: number;
  nonce: number;
  latencyMs: number;
  votes: number;
  timestamp: number;
  phase: number;
}

interface PhaseSummary {
  phase: number;
  targetTps: number;
  actualTps: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  meanLatencyMs: number;
  totalTxs: number;
  finalizedTxs: number;
  elapsedSec: number;
}

interface BenchmarkResult {
  benchmark: string;
  mode: string;
  nValidators: number;
  fByzantine: number;
  finalityQuorum: number;
  phases: PhaseSummary[];
  rawResults: TxResult[];
  equivocationTimeSec?: number;
  recoveryTimeSec?: number;
}

type Mode = "classic" | "recovery";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(results: TxResult[], durationSec: number, targetTps: number, phaseIdx: number): PhaseSummary {
  const finalized = results.filter((r) => r.votes > 0);
  const latencies = finalized.map((r) => r.latencyMs).sort((a, b) => a - b);
  const mean = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return {
    phase: phaseIdx,
    targetTps,
    actualTps: finalized.length / durationSec,
    medianLatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    meanLatencyMs: mean,
    totalTxs: results.length,
    finalizedTxs: finalized.length,
    elapsedSec: durationSec,
  };
}

function makeWallet(seed: string): Wallet {
  return new Wallet(ethers.keccak256(ethers.toUtf8Bytes(seed)));
}

async function signTx(
  wallet: Wallet, nonce: number, to: string, value: bigint, data?: string
): Promise<string> {
  return wallet.signTransaction({
    to, value, nonce, data: data || "0x", gasLimit: 21000, gasPrice: 0,
  });
}

// ─── Process Management ─────────────────────────────────────────────────────

interface ValidatorProcess {
  child: child_process.ChildProcess;
  port: number;
}

function spawnValidator(config: object): Promise<ValidatorProcess> {
  const port = (config as any).basePort + (config as any).index;
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(
      process.execPath,
      ["--import", "tsx", path.join(import.meta.dirname!, "validator-process.ts"), JSON.stringify(config)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Validator ${(config as any).index} startup timed out`));
    }, 15000);

    child.stdout!.on("data", (data: Buffer) => {
      if (data.toString().includes("READY")) {
        clearTimeout(timeout);
        resolve({ child, port });
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      // Suppress stderr unless debugging
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
    });
  });
}

async function spawnValidators(
  n: number, mode: Mode, genesis: { address: string; balance: string }[], basePort: number = 4000
): Promise<{ procs: ValidatorProcess[]; ports: number[]; f: number; quorum: number }> {
  const f = mode === "classic" ? Math.floor((n - 1) / 3) : Math.floor((n - 1) / 5);
  const quorum = n - f;
  console.log(`  Spawning ${n} validators (mode=${mode}, f=${f}, quorum=${quorum})...`);

  const promises: Promise<ValidatorProcess>[] = [];
  for (let i = 0; i < n; i++) {
    promises.push(spawnValidator({ index: i, mode, n, f, basePort, genesis, skipVerification: true }));
  }
  const procs = await Promise.all(promises);
  const ports = procs.map((p) => p.port);
  console.log(`  All ${n} validators ready on ports ${ports[0]}–${ports[ports.length - 1]}`);
  return { procs, ports, f, quorum };
}

function killAll(procs: ValidatorProcess[]): void {
  for (const p of procs) p.child.kill();
}

// ─── Network Communication ──────────────────────────────────────────────────

async function sendTxToValidator(signedTx: string, port: number): Promise<Vote | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTx] }),
    });
    const data: any = await res.json();
    if (data.error) return null;
    return data.result as Vote;
  } catch {
    return null;
  }
}

function broadcastAndCollect(
  signedTx: string, ports: number[], quorum: number
): Promise<{ latencyMs: number; votes: Vote[] }> {
  const start = performance.now();
  const collectedVotes: Vote[] = [];
  return new Promise((resolve) => {
    let resolved = false;
    let completed = 0;

    for (const port of ports) {
      sendTxToValidator(signedTx, port)
        .then((vote) => {
          if (!resolved && vote) {
            collectedVotes.push(vote);
            if (collectedVotes.length >= quorum) {
              resolved = true;
              resolve({ latencyMs: performance.now() - start, votes: [...collectedVotes] });
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          completed++;
          if (completed === ports.length && !resolved) {
            resolved = true;
            resolve({ latencyMs: performance.now() - start, votes: [...collectedVotes] });
          }
        });
    }
  });
}

async function submitVotesToAll(votes: Vote[], ports: number[]): Promise<void> {
  await Promise.all(
    ports.map((port) =>
      fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "submitVotes", params: [votes] }),
      }).catch(() => {})
    )
  );
}

async function rpcCall(port: number, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data: any = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ─── Benchmark 1: Happy-path multi-account (L-curve) ────────────────────────

const RECIPIENT = "0x1111111111111111111111111111111111111111";

async function bench1(mode: Mode, n: number): Promise<BenchmarkResult> {
  const targetTpsLevels = [10, 20, 40, 80, 120, 160];
  const phaseDurationSec = 10;

  // Precompute all transactions (different account per tx, nonce=0, value=0)
  const totalTxs = targetTpsLevels.reduce((sum, tps) => sum + tps * phaseDurationSec, 0);
  console.log(`[bench1/${mode}] Precomputing ${totalTxs} transactions...`);
  const precomputed: string[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const wallet = makeWallet(`bench1-${i}`);
    precomputed.push(await signTx(wallet, 0, RECIPIENT, 0n));
  }
  console.log(`[bench1/${mode}] Precomputation done`);

  // Spawn validator processes
  const { procs, ports, f, quorum } = await spawnValidators(n, mode, []);

  // Warmup
  console.log(`[bench1/${mode}] Warmup...`);
  for (let i = 0; i < 20; i++) {
    const w = makeWallet(`warmup-b1-${i}`);
    const tx = await signTx(w, 0, RECIPIENT, 0n);
    await broadcastAndCollect(tx, ports, quorum);
  }

  const allResults: TxResult[] = [];
  const phaseSummaries: PhaseSummary[] = [];
  let txIdx = 0;

  for (let phaseIdx = 0; phaseIdx < targetTpsLevels.length; phaseIdx++) {
    const targetTps = targetTpsLevels[phaseIdx];
    const totalTxsInPhase = targetTps * phaseDurationSec;
    const phaseResults: TxResult[] = [];

    console.log(`[bench1/${mode}] Phase ${phaseIdx}: ${targetTps} tx/s (${totalTxsInPhase} txs)...`);

    if (txIdx + totalTxsInPhase > precomputed.length) {
      console.log(`  → Not enough precomputed txs, stopping`);
      break;
    }

    // Open-loop rate-limited dispatch: send txs at the target rate,
    // don't wait for responses before sending the next tx.
    const intervalMs = 1000 / targetTps;
    const phaseStart = Date.now();
    const inflight: Promise<void>[] = [];

    for (let i = 0; i < totalTxsInPhase; i++) {
      const idx = txIdx++;
      const txTimestamp = Date.now();

      const promise = broadcastAndCollect(precomputed[idx], ports, quorum).then(({ latencyMs, votes }) => {
        phaseResults.push({
          clientId: idx, nonce: 0, latencyMs, votes: votes.length,
          timestamp: txTimestamp, phase: phaseIdx,
        });
      });
      inflight.push(promise);

      // Sleep to maintain the target send rate
      if (i < totalTxsInPhase - 1) {
        await sleep(intervalMs);
      }
    }

    await Promise.all(inflight);
    const actualDuration = (Date.now() - phaseStart) / 1000;
    const summary = computeStats(phaseResults, actualDuration, targetTps, phaseIdx);
    phaseSummaries.push(summary);
    allResults.push(...phaseResults);

    console.log(
      `  → achieved ${summary.actualTps.toFixed(1)} tx/s, ` +
      `median=${summary.medianLatencyMs.toFixed(1)}ms, p95=${summary.p95LatencyMs.toFixed(1)}ms`
    );

    // Stop only if actual throughput has collapsed to near zero for 2 consecutive phases
    if (
      phaseIdx > 0 &&
      summary.actualTps < 1 &&
      phaseSummaries[phaseIdx - 1].actualTps < 1
    ) {
      console.log(`  → System collapsed, stopping`);
      break;
    }
  }

  killAll(procs);
  return {
    benchmark: "bench1", mode, nValidators: n, fByzantine: f, finalityQuorum: quorum,
    phases: phaseSummaries, rawResults: allResults,
  };
}

// ─── Benchmark 2: Single-account sequential L-curve ─────────────────────────

async function bench2(mode: Mode, n: number): Promise<BenchmarkResult> {
  const targetTpsLevels = [10, 20, 40, 80, 120, 160, 250, 500];
  const phaseDurationSec = 10;
  const wallet = makeWallet("bench2-account");

  // Precompute enough sequential transactions for all phases
  const totalTxs = targetTpsLevels.reduce((sum, tps) => sum + tps * phaseDurationSec, 0);
  console.log(`[bench2/${mode}] Precomputing ${totalTxs} sequential transactions...`);
  const precomputed: string[] = [];
  for (let i = 0; i < totalTxs; i++) {
    precomputed.push(await signTx(wallet, i, RECIPIENT, 0n));
  }
  console.log(`[bench2/${mode}] Precomputation done`);

  const { procs, ports, f, quorum } = await spawnValidators(n, mode, []);

  // Warmup with separate accounts
  console.log(`[bench2/${mode}] Warmup...`);
  for (let i = 0; i < 10; i++) {
    const w = makeWallet(`warmup-b2-${i}`);
    const tx = await signTx(w, 0, RECIPIENT, 0n);
    await broadcastAndCollect(tx, ports, quorum);
  }

  const allResults: TxResult[] = [];
  const phaseSummaries: PhaseSummary[] = [];
  let nonce = 0;

  for (let phaseIdx = 0; phaseIdx < targetTpsLevels.length; phaseIdx++) {
    const targetTps = targetTpsLevels[phaseIdx];
    const totalTxsInPhase = targetTps * phaseDurationSec;
    const intervalMs = 1000 / targetTps;
    const phaseResults: TxResult[] = [];

    console.log(`[bench2/${mode}] Phase ${phaseIdx}: ${targetTps} tx/s (${totalTxsInPhase} txs)...`);

    if (nonce + totalTxsInPhase > precomputed.length) {
      console.log(`  → Not enough precomputed txs, stopping`);
      break;
    }

    const phaseStart = Date.now();

    for (let i = 0; i < totalTxsInPhase; i++) {
      const loopStart = performance.now();
      const txTimestamp = Date.now();

      // Sequential: send tx, wait for quorum, submit votes to advance nonce
      const { latencyMs, votes } = await broadcastAndCollect(precomputed[nonce], ports, quorum);
      phaseResults.push({
        clientId: 0, nonce, latencyMs, votes: votes.length,
        timestamp: txTimestamp, phase: phaseIdx,
      });
      await submitVotesToAll(votes, ports);
      nonce++;

      // Rate limit: if we finished faster than the interval, sleep the remainder
      const elapsed = performance.now() - loopStart;
      if (elapsed < intervalMs && i < totalTxsInPhase - 1) {
        await sleep(intervalMs - elapsed);
      }
    }

    const actualDuration = (Date.now() - phaseStart) / 1000;
    const summary = computeStats(phaseResults, actualDuration, targetTps, phaseIdx);
    phaseSummaries.push(summary);
    allResults.push(...phaseResults);

    console.log(
      `  → achieved ${summary.actualTps.toFixed(1)} tx/s, ` +
      `median=${summary.medianLatencyMs.toFixed(1)}ms, p95=${summary.p95LatencyMs.toFixed(1)}ms`
    );
  }

  killAll(procs);
  return {
    benchmark: "bench2", mode, nValidators: n, fByzantine: f, finalityQuorum: quorum,
    phases: phaseSummaries, rawResults: allResults,
  };
}

// ─── Benchmark 3: Recovery impact on single-account throughput ───────────────

async function bench3(n: number): Promise<BenchmarkResult> {
  const mode: Mode = "recovery";
  const preDurationSec = 10;
  const postDurationSec = 10;
  const wallet = makeWallet("bench3-account");
  const maxTxs = 10000;

  // Precompute normal sequential transactions
  console.log(`[bench3] Precomputing ${maxTxs} sequential transactions...`);
  const precomputed: string[] = [];
  for (let i = 0; i < maxTxs; i++) {
    precomputed.push(await signTx(wallet, i, RECIPIENT, 0n));
  }
  console.log(`[bench3] Precomputation done`);

  const { procs, ports, f, quorum } = await spawnValidators(n, mode, []);

  // Warmup
  console.log(`[bench3] Warmup...`);
  for (let i = 0; i < 10; i++) {
    const w = makeWallet(`warmup-b3-${i}`);
    const tx = await signTx(w, 0, RECIPIENT, 0n);
    await broadcastAndCollect(tx, ports, quorum);
  }

  const results: TxResult[] = [];
  let nonce = 0;

  // Phase 1: Normal transactions
  console.log(`[bench3] Phase 1: Normal txs for ${preDurationSec}s...`);
  const phase1Start = Date.now();
  const phase1End = phase1Start + preDurationSec * 1000;

  while (Date.now() < phase1End && nonce < precomputed.length) {
    const txStart = Date.now();
    const { latencyMs, votes } = await broadcastAndCollect(precomputed[nonce], ports, quorum);
    results.push({
      clientId: 0, nonce, latencyMs, votes: votes.length,
      timestamp: txStart, phase: 0,
    });
    await submitVotesToAll(votes, ports);
    nonce++;
  }

  // Phase 2: Equivocation + Recovery
  console.log(`[bench3] Phase 2: Equivocation and recovery...`);
  const equivocationTime = Date.now();
  const equivocationTimeSec = (equivocationTime - phase1Start) / 1000;

  // Send conflicting transactions to split validators
  const equivNonce = nonce;
  const recipient2 = "0x2222222222222222222222222222222222222222";
  const txA = await signTx(wallet, equivNonce, RECIPIENT, 0n);
  const txB = await signTx(wallet, equivNonce, recipient2, 0n);

  const splitPoint = Math.floor(ports.length / 2);
  const portsA = ports.slice(0, splitPoint);
  const portsB = ports.slice(splitPoint);

  // Send conflicting txs to different validator subsets
  const [votesA, votesB] = await Promise.all([
    Promise.all(portsA.map((p) => sendTxToValidator(txA, p))),
    Promise.all(portsB.map((p) => sendTxToValidator(txB, p))),
  ]);

  // Wait for vote propagation between validators
  await sleep(500);

  // Query recovery info from a validator
  let recoveryInfo: any = null;
  for (const port of ports) {
    try {
      recoveryInfo = await rpcCall(port, "eth_getRecoveryInfo", [wallet.address.toLowerCase()]);
      if (recoveryInfo) break;
    } catch {}
  }

  const recoveryStart = Date.now();

  if (recoveryInfo) {
    nonce = recoveryInfo.currentNonce;

    // Find tip transaction (last non-bot in the chain)
    let tipTxSerialized: string | null = null;
    if (recoveryInfo.chain) {
      for (let i = recoveryInfo.chain.length - 1; i >= 0; i--) {
        if (recoveryInfo.chain[i].serializedTx !== null) {
          tipTxSerialized = recoveryInfo.chain[i].serializedTx;
          break;
        }
      }
    }
    if (!tipTxSerialized && recoveryInfo.serializedFinalisedTx) {
      tipTxSerialized = recoveryInfo.serializedFinalisedTx;
    }

    if (tipTxSerialized) {
      const recoveryTx = await signTx(wallet, nonce, RECOVERY_CONTRACT, 0n, tipTxSerialized);
      const { latencyMs, votes } = await broadcastAndCollect(recoveryTx, ports, quorum);
      results.push({
        clientId: 0, nonce, latencyMs, votes: votes.length,
        timestamp: recoveryStart, phase: 1,
      });
      await submitVotesToAll(votes, ports);
      nonce++;
    }
  }

  const recoveryTime = Date.now();
  const recoveryTimeSec = (recoveryTime - phase1Start) / 1000;
  console.log(
    `[bench3] Recovery completed at t=${recoveryTimeSec.toFixed(1)}s ` +
    `(equivocation at t=${equivocationTimeSec.toFixed(1)}s)`
  );

  // Phase 3: Resume normal transactions (precompute remaining txs at new nonces)
  console.log(`[bench3] Phase 3: Resume normal txs for ${postDurationSec}s...`);
  const postTxs: string[] = [];
  for (let i = 0; i < 5000; i++) {
    postTxs.push(await signTx(wallet, nonce + i, RECIPIENT, 0n));
  }

  const phase3End = Date.now() + postDurationSec * 1000;
  let postIdx = 0;

  while (Date.now() < phase3End && postIdx < postTxs.length) {
    const txStart = Date.now();
    const { latencyMs, votes } = await broadcastAndCollect(postTxs[postIdx], ports, quorum);
    results.push({
      clientId: 0, nonce: nonce + postIdx, latencyMs, votes: votes.length,
      timestamp: txStart, phase: 2,
    });
    await submitVotesToAll(votes, ports);
    postIdx++;
    nonce++;
  }

  const totalDuration = (Date.now() - phase1Start) / 1000;
  const summary = computeStats(results, totalDuration, 0, 0);
  console.log(`[bench3] Done: ${results.length} txs in ${totalDuration.toFixed(1)}s = ${summary.actualTps.toFixed(1)} tx/s`);

  killAll(procs);
  return {
    benchmark: "bench3", mode, nValidators: n, fByzantine: f, finalityQuorum: quorum,
    phases: [summary], rawResults: results,
    equivocationTimeSec, recoveryTimeSec,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [benchName, modeArg, nArg] = process.argv.slice(2);
  const n = nArg ? parseInt(nArg, 10) : 6;

  if (!benchName || !["bench1", "bench2", "bench3"].includes(benchName)) {
    console.log("Usage: tsx benchmark.ts <bench1|bench2|bench3> <classic|recovery> [nValidators]");
    process.exit(1);
  }

  const outputDir = path.join(import.meta.dirname!, "benchmark-results");
  fs.mkdirSync(outputDir, { recursive: true });

  let result: BenchmarkResult;

  if (benchName === "bench1") {
    const mode = (modeArg as Mode) || "recovery";
    result = await bench1(mode, n);
  } else if (benchName === "bench2") {
    const mode = (modeArg as Mode) || "recovery";
    result = await bench2(mode, n);
  } else {
    result = await bench3(n);
  }

  const filename = `${benchName}-${result.mode}-n${n}-${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(
    filepath,
    JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
  );
  console.log(`\nResults written to ${filepath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
