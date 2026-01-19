import { Transaction, solidityPackedKeccak256, verifyMessage, getBytes, ZeroHash } from "ethers";

// Protocol parameters from environment (default: n = 5f + 1, with f = 1)
export const F_BYZANTINE = parseInt(process.env.F_BYZANTINE || "1", 10);
export const N_VALIDATORS = parseInt(process.env.N_VALIDATORS || String(5 * F_BYZANTINE + 1), 10);

// Validate n >= 5f + 1
if (N_VALIDATORS < 5 * F_BYZANTINE + 1) {
  throw new Error(`Invalid config: n=${N_VALIDATORS} must be >= 5f+1=${5 * F_BYZANTINE + 1}`);
}

export const FINALITY_QUORUM = N_VALIDATORS - F_BYZANTINE; // n - f
export const NOTARISATION_QUORUM = N_VALIDATORS - 3 * F_BYZANTINE; // n - 3f

// Precompile address for recovery contract
export const RECOVERY_CONTRACT = "0x0000000000000000000000000000000000000100";

// Validator network info
export interface ValidatorInfo {
  address: string; // public key/address
  host: string;
  port: number;
}

// Genesis account balance
export interface GenesisAccount {
  address: string;
  balance: bigint;
}

// JSON-RPC types
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// RPC client for validator communication
export class RpcClient {
  constructor(private validators: ValidatorInfo[]) {}

  async call(method: string, params: unknown[]): Promise<unknown[]> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    const promises = this.validators.map(async (v) => {
      try {
        const res = await fetch(`http://${v.host}:${v.port}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const data: JsonRpcResponse = await res.json();
        if (data.error) return null;
        return data.result;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(promises);
    return results.filter((r) => r !== null);
  }

}

// Account state maintained by validators
export interface AccountState {
  balance: bigint;
  nonce: number; // next nonce to sign
  pending: boolean;
  finalised: number; // last finalised nonce
}

// Signed vote from a validator
export interface Vote {
  validator: string; // validator public key/address
  account: string;
  nonce: number;
  serializedTx: string | null; // null represents bot, otherwise serialized tx
  signature: string;
}

// Certificate: collection of votes (txHash derived from votes)
export interface Certificate {
  votes: Vote[];
}

// Recovery info returned by validator
export interface RecoveryInfo {
  finalisedNonce: number;
  serializedFinalisedTx: string | null;
  finalityCert: Certificate | null;
  currentNonce: number;
  chain: ChainEntry[];
}

export interface ChainEntry {
  nonce: number;
  serializedTx: string | null; // null means bot
  cert: Certificate;
}

// Get transaction from vote (parses serializedTx)
export function voteTx(vote: Vote): Transaction | null {
  return vote.serializedTx ? Transaction.from(vote.serializedTx) : null;
}

// Get tx hash from vote
export function voteTxHash(vote: Vote): string | null {
  return vote.serializedTx ? Transaction.from(vote.serializedTx).hash : null;
}

// Utility: count unique validators voting for a specific tx (by hash)
export function countQuorum(votes: Vote[], txHash: string | null): number {
  const matching = votes.filter((v) => voteTxHash(v) === txHash);
  return new Set(matching.map((v) => v.validator)).size;
}

// Verify vote signature and optionally check validator set membership
export function verifyVote(vote: Vote, validatorSet?: Set<string>): boolean {
  // Check validator set membership if provided
  if (validatorSet && !validatorSet.has(vote.validator.toLowerCase())) {
    return false;
  }

  // Verify signature (sign over tx hash, or ZeroHash for bot)
  const message = solidityPackedKeccak256(
    ["address", "uint256", "bytes32"],
    [vote.account, vote.nonce, voteTxHash(vote) ?? ZeroHash]
  );
  const recoveredAddress = verifyMessage(getBytes(message), vote.signature);
  return recoveredAddress.toLowerCase() === vote.validator.toLowerCase();
}

// Interface for validator operations (transport-agnostic)
export interface IValidator {
  readonly address: string;
  onTransaction(signedTx: string): Promise<Vote>;
  onVote(vote: Vote): Promise<void>;
  getRecoveryInfo(account: string): RecoveryInfo | Promise<RecoveryInfo>;
}
