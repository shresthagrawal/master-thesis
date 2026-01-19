import { ethers, Transaction, Wallet, HDNodeWallet } from "ethers";
import {
  ValidatorInfo,
  RecoveryInfo,
  Vote,
  IValidator,
  RECOVERY_CONTRACT,
  FINALITY_QUORUM,
  verifyVote,
} from "./common.js";

export class Client {
  public readonly address: string;
  private wallet: Wallet | HDNodeWallet;
  private validators: IValidator[];
  private validatorSet: Set<string>;
  public nonce: number = 0;

  constructor(validators: IValidator[], privateKey?: string) {
    this.wallet = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
    this.address = this.wallet.address.toLowerCase();
    this.validators = validators;
    this.validatorSet = new Set(validators.map((v) => v.address.toLowerCase()));
  }

  async signTransaction(tx: { to: string; value: bigint; nonce: number; data?: string }): Promise<string> {
    return this.wallet.signTransaction({
      to: tx.to,
      value: tx.value,
      nonce: tx.nonce,
      data: tx.data || "0x",
      gasLimit: 21000,
      gasPrice: 0,
    });
  }

  private countValidVotes(votes: (Vote | null)[]): number {
    let count = 0;
    for (const vote of votes) {
      if (vote && verifyVote(vote, this.validatorSet)) {
        count++;
      }
    }
    return count;
  }

  async sendTransaction(to: string, value: bigint, data?: string): Promise<{ votes: number; signedTx: string }> {
    const signedTx = await this.signTransaction({ to, value, nonce: this.nonce, data });

    const results = await Promise.all(
      this.validators.map((v) => v.onTransaction(signedTx).catch(() => null))
    );

    const votes = this.countValidVotes(results);

    if (votes >= FINALITY_QUORUM) {
      this.nonce++;
    }
    return { votes, signedTx };
  }

  // Send a signed transaction to specific validators (for testing equivocation scenarios)
  async sendRawTransactionTo(signedTx: string, validatorIndices: number[]): Promise<Vote[]> {
    const votes: Vote[] = [];
    for (const i of validatorIndices) {
      if (i >= 0 && i < this.validators.length) {
        try {
          const vote = await this.validators[i].onTransaction(signedTx);
          if (vote && verifyVote(vote, this.validatorSet)) {
            votes.push(vote);
          }
        } catch {
          // Validator rejected
        }
      }
    }
    return votes;
  }

  async queryRecoveryInfo(): Promise<RecoveryInfo[]> {
    const results = await Promise.all(
      this.validators.map((v) =>
        Promise.resolve(v.getRecoveryInfo(this.address)).catch(() => null)
      )
    );

    return results.filter((r): r is RecoveryInfo => r !== null);
  }

  findTipTransaction(responses: RecoveryInfo[]): { tipTx: Transaction | null; nonce: number } {
    if (responses.length === 0) {
      return { tipTx: null, nonce: this.nonce };
    }

    // Pick response with highest nonce
    const bestResponse = responses.reduce((best, r) =>
      r.currentNonce > best.currentNonce ? r : best
    );

    // Find tip: last non-bot tx in chain, or finalized tx if all bot
    let tipTx: Transaction | null = null;

    for (let i = bestResponse.chain.length - 1; i >= 0; i--) {
      const entry = bestResponse.chain[i];
      if (entry.serializedTx !== null) {
        tipTx = Transaction.from(entry.serializedTx);
        break;
      }
    }

    if (!tipTx && bestResponse.serializedFinalisedTx) {
      tipTx = Transaction.from(bestResponse.serializedFinalisedTx);
    }

    return { tipTx, nonce: bestResponse.currentNonce };
  }

  async initiateRecovery(): Promise<{ votes: number; signedTx: string } | null> {
    const responses = await this.queryRecoveryInfo();
    const { tipTx, nonce } = this.findTipTransaction(responses);

    if (!tipTx) {
      return null;
    }

    const signedTx = await this.signTransaction({
      to: RECOVERY_CONTRACT,
      value: 0n,
      nonce: nonce,
      data: tipTx.serialized,
    });

    const results = await Promise.all(
      this.validators.map((v) => v.onTransaction(signedTx).catch(() => null))
    );

    const votes = this.countValidVotes(results);

    if (votes >= FINALITY_QUORUM) {
      this.nonce = nonce + 1;
    }

    return { votes, signedTx };
  }
}
