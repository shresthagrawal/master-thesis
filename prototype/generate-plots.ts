import * as fs from "fs";
import * as path from "path";

// ─── Types (matching benchmark.ts output) ────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadResult(filepath: string): BenchmarkResult {
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function findLatest(dir: string, prefix: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── bench1 data generation ─────────────────────────────────────────────────

function generateBench1Data(classic: BenchmarkResult, recovery: BenchmarkResult, outputDir: string): void {
  // Throughput data
  let throughputDat = "targetTps\tclassic_actualTps\trecovery_actualTps\n";
  for (let i = 0; i < Math.min(classic.phases.length, recovery.phases.length); i++) {
    const cp = classic.phases[i];
    const rp = recovery.phases[i];
    throughputDat += `${cp.targetTps}\t${cp.actualTps.toFixed(2)}\t${rp.actualTps.toFixed(2)}\n`;
  }
  fs.writeFileSync(path.join(outputDir, "bench1-throughput.dat"), throughputDat);

  // Latency data — x-axis is actual throughput (not offered load)
  // Include a few post-saturation points to show the latency spike clearly
  let latencyDat = "classic_tps\tclassic_median\tclassic_p95\trecovery_tps\trecovery_median\trecovery_p95\n";
  let postSaturationCount = 0;
  for (let i = 0; i < Math.min(classic.phases.length, recovery.phases.length); i++) {
    const cp = classic.phases[i];
    const rp = recovery.phases[i];
    const saturated = cp.actualTps < cp.targetTps * 0.9 || rp.actualTps < rp.targetTps * 0.9;
    if (saturated) postSaturationCount++;
    // Include up to 3 post-saturation points for the spike
    if (postSaturationCount > 3) break;
    latencyDat +=
      `${cp.actualTps.toFixed(2)}\t${cp.medianLatencyMs.toFixed(2)}\t${cp.p95LatencyMs.toFixed(2)}\t` +
      `${rp.actualTps.toFixed(2)}\t${rp.medianLatencyMs.toFixed(2)}\t${rp.p95LatencyMs.toFixed(2)}\n`;
  }
  fs.writeFileSync(path.join(outputDir, "bench1-latency.dat"), latencyDat);

  console.log("  → bench1-throughput.dat, bench1-latency.dat");
}

// ─── bench2 data generation ─────────────────────────────────────────────────

function generateBench2Data(classic: BenchmarkResult, recovery: BenchmarkResult, outputDir: string): void {
  const cp = classic.phases[0];
  const rp = recovery.phases[0];

  let dat = "mode\tthroughput\tmeanLatency\tmedianLatency\tp95Latency\n";
  dat += `classic\t${cp.actualTps.toFixed(2)}\t${cp.meanLatencyMs.toFixed(2)}\t${cp.medianLatencyMs.toFixed(2)}\t${cp.p95LatencyMs.toFixed(2)}\n`;
  dat += `recovery\t${rp.actualTps.toFixed(2)}\t${rp.meanLatencyMs.toFixed(2)}\t${rp.medianLatencyMs.toFixed(2)}\t${rp.p95LatencyMs.toFixed(2)}\n`;
  fs.writeFileSync(path.join(outputDir, "bench2-throughput.dat"), dat);

  // Also generate a LaTeX table fragment for direct inclusion
  let table = `Classic FastPay & ${cp.actualTps.toFixed(1)} & ${cp.medianLatencyMs.toFixed(1)} & ${cp.meanLatencyMs.toFixed(1)} & ${cp.p95LatencyMs.toFixed(1)} \\\\\n`;
  table += `FastPay with Recovery & ${rp.actualTps.toFixed(1)} & ${rp.medianLatencyMs.toFixed(1)} & ${rp.meanLatencyMs.toFixed(1)} & ${rp.p95LatencyMs.toFixed(1)} \\\\`;
  fs.writeFileSync(path.join(outputDir, "bench2-table.tex"), table);

  console.log("  → bench2-throughput.dat, bench2-table.tex");
}

// ─── bench3 data generation ─────────────────────────────────────────────────

function generateBench3Data(recovery: BenchmarkResult, outputDir: string): void {
  if (recovery.rawResults.length === 0) return;

  const baseTimestamp = recovery.rawResults[0].timestamp;
  const equivocT = recovery.equivocationTimeSec ?? 0;
  const recoveryT = recovery.recoveryTimeSec ?? 0;

  // Bucket transactions into 1-second windows
  const buckets: { [sec: number]: { count: number; latencies: number[] } } = {};
  for (const r of recovery.rawResults) {
    const sec = Math.floor((r.timestamp - baseTimestamp) / 1000);
    if (!buckets[sec]) buckets[sec] = { count: 0, latencies: [] };
    if (r.votes > 0) {
      buckets[sec].count++;
      buckets[sec].latencies.push(r.latencyMs);
    }
  }

  const maxSec = Math.max(...Object.keys(buckets).map(Number));

  let dat = "timeSec\tthroughput\tmedianLatency\tevent\n";
  for (let s = 0; s <= maxSec; s++) {
    const b = buckets[s] || { count: 0, latencies: [] };
    const sorted = b.latencies.sort((a, c) => a - c);
    const medLat = sorted.length > 0 ? percentile(sorted, 50) : 0;

    let event = "normal";
    if (Math.abs(s - equivocT) < 1) event = "equivocation";
    else if (Math.abs(s - recoveryT) < 1) event = "recovery";

    dat += `${s}\t${b.count}\t${medLat.toFixed(2)}\t${event}\n`;
  }
  fs.writeFileSync(path.join(outputDir, "bench3-timeseries.dat"), dat);

  // Also write the event timestamps for pgfplots vertical lines
  let eventsDat = "event\ttimeSec\n";
  eventsDat += `equivocation\t${equivocT.toFixed(2)}\n`;
  eventsDat += `recovery\t${recoveryT.toFixed(2)}\n`;
  fs.writeFileSync(path.join(outputDir, "bench3-events.dat"), eventsDat);

  console.log("  → bench3-timeseries.dat, bench3-events.dat");
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const resultsDir = path.join(import.meta.dirname || ".", "benchmark-results");
  const outputDir = path.join(import.meta.dirname || ".", "..", "tex", "tumthesis", "data");
  fs.mkdirSync(outputDir, { recursive: true });

  console.log("Generating pgfplots data files...\n");

  // bench1
  const bench1Classic = findLatest(resultsDir, "bench1-classic");
  const bench1Recovery = findLatest(resultsDir, "bench1-recovery");
  if (bench1Classic && bench1Recovery) {
    console.log("Bench1 (Happy-path L-curve):");
    generateBench1Data(loadResult(bench1Classic), loadResult(bench1Recovery), outputDir);
  } else {
    console.log("Bench1: Skipped (missing result files)");
  }

  // bench2
  const bench2Classic = findLatest(resultsDir, "bench2-classic");
  const bench2Recovery = findLatest(resultsDir, "bench2-recovery");
  if (bench2Classic && bench2Recovery) {
    console.log("\nBench2 (Single-account throughput):");
    generateBench2Data(loadResult(bench2Classic), loadResult(bench2Recovery), outputDir);
  } else {
    console.log("Bench2: Skipped (missing result files)");
  }

  // bench3
  const bench3Recovery = findLatest(resultsDir, "bench3-recovery");
  if (bench3Recovery) {
    console.log("\nBench3 (Recovery impact):");
    generateBench3Data(loadResult(bench3Recovery), outputDir);
  } else {
    console.log("Bench3: Skipped (missing result files)");
  }

  console.log(`\nAll data files written to ${outputDir}`);
}

main();
