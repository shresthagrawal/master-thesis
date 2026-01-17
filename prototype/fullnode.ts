import express from "express";
import { ethers } from "ethers";
import {
  Validator,
  createValidatorNetwork,
  Transaction,
  Vote,
  RECOVERY_CONTRACT,
  N_VALIDATORS,
  QUORUM_SIZE,
} from "./validator.js";

const PORT = 8545;

export class Fullnode {
  private validators: Validator[];
  private app: express.Application;
  private voteListeners: Map<string, ((vote: Vote) => void)[]> = new Map();

  constructor(validators: Validator[]) {
    this.validators = validators;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();

    // Subscribe to votes from all validators for client notifications
    for (const v of validators) {
      v.onVote((vote) => {
        const listeners = this.voteListeners.get(vote.account.toLowerCase()) || [];
        for (const listener of listeners) {
          listener(vote);
        }
      });
    }
  }

  private setupRoutes(): void {
    // JSON-RPC endpoint
    this.app.post("/", async (req, res) => {
      const { method, params, id } = req.body;

      try {
        let result: unknown;

        switch (method) {
          case "eth_sendRawTransaction":
            result = await this.ethSendRawTransaction(params[0]);
            break;

          case "eth_getBalance":
            result = this.ethGetBalance(params[0], params[1]);
            break;

          case "eth_getTransactionCount":
            result = this.ethGetTransactionCount(params[0], params[1]);
            break;

          case "eth_chainId":
            result = "0x1"; // Mainnet chain ID for compatibility
            break;

          case "eth_blockNumber":
            result = "0x1";
            break;

          case "eth_gasPrice":
            result = "0x0";
            break;

          case "eth_estimateGas":
            result = "0x5208"; // 21000 gas
            break;

          case "net_version":
            result = "1";
            break;

          // Recovery-specific endpoints
          case "recovery_getInfo":
            result = this.recoveryGetInfo(params[0]);
            break;

          case "recovery_sendTransaction":
            result = await this.recoverySendTransaction(params[0]);
            break;

          // For testing: send conflicting transactions
          case "test_sendConflicting":
            result = await this.testSendConflicting(params[0], params[1], params[2]);
            break;

          // For testing: set balance
          case "test_setBalance":
            this.testSetBalance(params[0], params[1]);
            result = true;
            break;

          default:
            res.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${method}` },
            });
            return;
        }

        res.json({ jsonrpc: "2.0", id, result });
      } catch (error) {
        console.error("RPC error:", error);
        res.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: String(error) },
        });
      }
    });
  }

  // eth_sendRawTransaction: decode and broadcast to validators
  private async ethSendRawTransaction(rawTx: string): Promise<string> {
    // Decode the transaction
    const parsed = ethers.Transaction.from(rawTx);

    const tx: Transaction = {
      sender: parsed.from!,
      recipient: parsed.to!,
      amount: parsed.value,
      nonce: parsed.nonce,
      tip: parsed.data && parsed.data !== "0x" ? parsed.data : undefined,
    };

    const txHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint256", "string"],
        [tx.sender, tx.recipient, tx.amount, tx.nonce, tx.tip || ""]
      )
    );

    // Create signature from the transaction
    const senderSignature = parsed.signature
      ? ethers.Signature.from({
          r: parsed.signature.r,
          s: parsed.signature.s,
          v: parsed.signature.v,
        }).serialized
      : "";

    // For simplicity, we'll use a message signature instead
    // In production, you'd verify the transaction signature properly

    console.log(`\n[Fullnode] Received tx from ${tx.sender} to ${tx.recipient}, nonce=${tx.nonce}, amount=${tx.amount}`);

    // Broadcast to all validators and collect votes
    const votes: Vote[] = [];
    const votePromises = this.validators.map(async (v) => {
      // Sign the txHash as the sender signature (simplified)
      const vote = await v.onTransaction(tx, senderSignature);
      if (vote) votes.push(vote);
    });

    await Promise.all(votePromises);

    console.log(`[Fullnode] Collected ${votes.length}/${N_VALIDATORS} votes for tx ${txHash.slice(0, 10)}...`);

    return txHash;
  }

  // eth_getBalance: query from first validator (all should be consistent)
  private ethGetBalance(address: string, _block: string): string {
    const { balance } = this.validators[0].getAccountState(address);
    return "0x" + balance.toString(16);
  }

  // eth_getTransactionCount: get nonce
  private ethGetTransactionCount(address: string, _block: string): string {
    const { nonce } = this.validators[0].getAccountState(address);
    return "0x" + nonce.toString(16);
  }

  // recovery_getInfo: get recovery information for an account
  private recoveryGetInfo(address: string): {
    nonce: number;
    finalised: number;
    pending: boolean;
    tipTx: { tx: Transaction; txHash: string } | null;
  } {
    const v = this.validators[0];
    const state = v.getAccountState(address);
    return {
      nonce: state.nonce,
      finalised: state.finalised,
      pending: state.pending,
      tipTx: v.getTipTransaction(address),
    };
  }

  // recovery_sendTransaction: send a recovery transaction
  private async recoverySendTransaction(params: {
    sender: string;
    nonce: number;
    tipTxHash: string;
    signature: string;
  }): Promise<string> {
    const tx: Transaction = {
      sender: params.sender,
      recipient: RECOVERY_CONTRACT,
      amount: 0n,
      nonce: params.nonce,
      tip: params.tipTxHash,
    };

    const txHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint256", "string"],
        [tx.sender, tx.recipient, tx.amount, tx.nonce, tx.tip || ""]
      )
    );

    console.log(`\n[Fullnode] Received recovery tx from ${tx.sender}, nonce=${tx.nonce}, tip=${params.tipTxHash.slice(0, 10)}...`);

    // Broadcast to all validators
    const votes: Vote[] = [];
    for (const v of this.validators) {
      const vote = await v.onTransaction(tx, params.signature);
      if (vote) votes.push(vote);
    }

    console.log(`[Fullnode] Collected ${votes.length}/${N_VALIDATORS} votes for recovery tx`);

    return txHash;
  }

  // Test helper: send conflicting transactions to specific validators
  private async testSendConflicting(
    tx1: { sender: string; recipient: string; amount: string; nonce: number; signature: string },
    tx2: { sender: string; recipient: string; amount: string; nonce: number; signature: string },
    split: number[] // which validators get tx1 vs tx2
  ): Promise<{ tx1Hash: string; tx2Hash: string; tx1Votes: number; tx2Votes: number }> {
    const transaction1: Transaction = {
      sender: tx1.sender,
      recipient: tx1.recipient,
      amount: BigInt(tx1.amount),
      nonce: tx1.nonce,
    };

    const transaction2: Transaction = {
      sender: tx2.sender,
      recipient: tx2.recipient,
      amount: BigInt(tx2.amount),
      nonce: tx2.nonce,
    };

    const tx1Hash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint256", "string"],
        [transaction1.sender, transaction1.recipient, transaction1.amount, transaction1.nonce, ""]
      )
    );

    const tx2Hash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint256", "uint256", "string"],
        [transaction2.sender, transaction2.recipient, transaction2.amount, transaction2.nonce, ""]
      )
    );

    console.log(`\n[Fullnode] Sending conflicting transactions at nonce ${tx1.nonce}`);
    console.log(`[Fullnode] TX1: ${tx1.sender} -> ${tx1.recipient}: ${tx1.amount}`);
    console.log(`[Fullnode] TX2: ${tx2.sender} -> ${tx2.recipient}: ${tx2.amount}`);

    let tx1Votes = 0;
    let tx2Votes = 0;

    for (let i = 0; i < this.validators.length; i++) {
      const v = this.validators[i];
      if (split.includes(i)) {
        const vote = await v.onTransaction(transaction1, tx1.signature);
        if (vote) tx1Votes++;
      } else {
        const vote = await v.onTransaction(transaction2, tx2.signature);
        if (vote) tx2Votes++;
      }
    }

    console.log(`[Fullnode] TX1 got ${tx1Votes} votes, TX2 got ${tx2Votes} votes`);

    return { tx1Hash, tx2Hash, tx1Votes, tx2Votes };
  }

  // Test helper: set balance
  private testSetBalance(address: string, balance: string): void {
    for (const v of this.validators) {
      v.getAccountState(address).balance = BigInt(balance);
    }
    console.log(`[Fullnode] Set balance for ${address} to ${balance}`);
  }

  start(): void {
    this.app.listen(PORT, () => {
      console.log(`Fullnode listening on http://localhost:${PORT}`);
      console.log(`Validators: ${this.validators.length} (quorum: ${QUORUM_SIZE})`);
    });
  }
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const validators = createValidatorNetwork();
  const fullnode = new Fullnode(validators);
  fullnode.start();
}

export { createValidatorNetwork };
