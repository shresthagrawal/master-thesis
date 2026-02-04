import { ethers, Transaction } from "ethers";
import {
  AccountState,
  Vote,
  ValidatorInfo,
  GenesisAccount,
  IValidator,
  RecoveryInfo,
  verifyVote,
  voteTx,
  voteTxHash,
} from "./common.js";

export type { ValidatorInfo, GenesisAccount };
export type BroadcastVoteCallback = (vote: Vote) => void | Promise<void>;

// Classic FastPay validator: 3f+1 model, no recovery, no bot voting.
export class ClassicValidatorCore implements IValidator {
  public readonly address: string;
  public readonly finalityQuorum: number;
  private wallet: ethers.Wallet;
  private validatorSet: Set<string>;
  private accounts: { [address: string]: AccountState } = {};
  private voteStore: { [address: string]: { [nonce: number]: Vote[] } } = {};
  private broadcastVoteCallback: BroadcastVoteCallback;
  private skipVerification: boolean;

  constructor(
    privateKey: string,
    validators: ValidatorInfo[],
    genesisAccounts: GenesisAccount[] = [],
    fByzantine: number = Math.floor((validators.length - 1) / 3),
    broadcastVote: BroadcastVoteCallback = () => {},
    skipVerification: boolean = false
  ) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.broadcastVoteCallback = broadcastVote;
    this.skipVerification = skipVerification;

    const n = validators.length;
    if (n < 3 * fByzantine + 1) {
      throw new Error(`Invalid config: n=${n} must be >= 3f+1=${3 * fByzantine + 1}`);
    }
    this.finalityQuorum = n - fByzantine;

    this.validatorSet = new Set(validators.map((v) => v.address.toLowerCase()));

    for (const { address, balance } of genesisAccounts) {
      this.accounts[address.toLowerCase()] = {
        balance,
        nonce: 0,
        pending: false,
        finalised: -1,
      };
    }
  }

  setBroadcastCallback(callback: BroadcastVoteCallback): void {
    this.broadcastVoteCallback = callback;
  }

  private getAccount(address: string): AccountState {
    const normalized = address.toLowerCase();
    if (!this.accounts[normalized]) {
      this.accounts[normalized] = {
        balance: 0n,
        nonce: 0,
        pending: false,
        finalised: -1,
      };
    }
    return this.accounts[normalized];
  }

  getAccountState(address: string): AccountState {
    return this.getAccount(address);
  }

  getVotes(account: string, nonce: number): Vote[] {
    const normalized = account.toLowerCase();
    return this.voteStore[normalized]?.[nonce] || [];
  }

  private async signVote(account: string, nonce: number, tx: Transaction): Promise<Vote> {
    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "bytes32"],
      [account, nonce, tx.hash]
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(message));
    return { validator: this.address, account, nonce, serializedTx: tx.serialized, signature };
  }

  async onTransaction(signedTx: string): Promise<Vote> {
    const tx = Transaction.from(signedTx);
    if (!tx.from || !tx.signature) {
      throw new Error("Invalid transaction signature");
    }

    const sender = tx.from.toLowerCase();
    const account = this.getAccount(sender);

    if (account.pending) {
      throw new Error("Account has pending transaction");
    }

    if (tx.nonce !== account.nonce) {
      throw new Error(`Nonce mismatch: expected ${account.nonce}, got ${tx.nonce}`);
    }

    if (account.balance < tx.value) {
      throw new Error("Insufficient balance");
    }

    account.pending = true;

    const vote = await this.signVote(sender, tx.nonce, tx);
    // Store own vote directly (skip signature verification — we just signed it)
    this.storeVote(vote);
    await this.processCertificate(vote.account, vote.nonce);
    await this.broadcastVoteCallback(vote);

    return vote;
  }

  private storeVote(vote: Vote): void {
    const normalized = vote.account.toLowerCase();
    if (!this.voteStore[normalized]) this.voteStore[normalized] = {};
    if (!this.voteStore[normalized][vote.nonce]) this.voteStore[normalized][vote.nonce] = [];
    this.voteStore[normalized][vote.nonce].push(vote);
  }

  async onVote(vote: Vote): Promise<void> {
    if (!this.skipVerification && !verifyVote(vote, this.validatorSet)) {
      throw new Error("Invalid vote signature or validator not in set");
    }

    const normalized = vote.account.toLowerCase();
    if (!this.voteStore[normalized]) {
      this.voteStore[normalized] = {};
    }
    if (!this.voteStore[normalized][vote.nonce]) {
      this.voteStore[normalized][vote.nonce] = [];
    }

    const existing = this.voteStore[normalized][vote.nonce];

    // Classic: one vote per validator per nonce (no bot votes)
    if (existing.some((v) => v.validator === vote.validator)) {
      return;
    }

    existing.push(vote);

    await this.processCertificate(vote.account, vote.nonce);
  }

  private async processCertificate(account: string, nonce: number): Promise<void> {
    const acc = this.getAccount(account);
    const votes = this.getVotes(account, nonce);
    const { quorum, tx } = this.getMaxQuorumCert(votes);

    // Classic FastPay: only finality quorum matters
    if (nonce === acc.nonce && quorum >= this.finalityQuorum && tx !== null) {
      this.executeTransfer(tx);
      acc.finalised = nonce;
      acc.nonce = nonce + 1;
      acc.pending = false;
    }
  }

  private executeTransfer(tx: Transaction): void {
    const senderAcc = this.getAccount(tx.from!);
    const recipientAcc = this.getAccount(tx.to!);
    senderAcc.balance -= tx.value;
    recipientAcc.balance += tx.value;
  }

  getRecoveryInfo(_account: string): RecoveryInfo {
    throw new Error("Recovery not supported in classic FastPay");
  }

  private getMaxQuorumCert(votes: Vote[]): { quorum: number; tx: Transaction | null } {
    const votesByTx: { [key: string]: Vote[] } = {};
    for (const vote of votes) {
      const key = voteTxHash(vote) ?? "BOT";
      if (!votesByTx[key]) votesByTx[key] = [];
      votesByTx[key].push(vote);
    }

    let maxQuorum = 0;
    let maxTx: Transaction | null = null;

    for (const txVotes of Object.values(votesByTx)) {
      const count = new Set(txVotes.map((v) => v.validator)).size;
      if (count > maxQuorum) {
        maxQuorum = count;
        maxTx = voteTx(txVotes[0]);
      }
    }

    return { quorum: maxQuorum, tx: maxTx };
  }
}

// Helper to create classic validator cores for testing
export function createClassicValidatorCores(
  count: number,
  genesisAccounts: GenesisAccount[] = [],
  autoBroadcast: boolean = false,
  fByzantine: number = Math.floor((count - 1) / 3)
): { validators: ClassicValidatorCore[]; validatorInfos: ValidatorInfo[] } {
  const validatorInfos: ValidatorInfo[] = [];
  const privateKeys: string[] = [];

  for (let i = 0; i < count; i++) {
    const privateKey = ethers.keccak256(ethers.toUtf8Bytes(`validator-${i}`));
    const wallet = new ethers.Wallet(privateKey);
    privateKeys.push(privateKey);
    validatorInfos.push({
      address: wallet.address,
      host: "127.0.0.1",
      port: 3000 + i,
    });
  }

  const validators: ClassicValidatorCore[] = [];
  for (let i = 0; i < count; i++) {
    validators.push(new ClassicValidatorCore(privateKeys[i], validatorInfos, genesisAccounts, fByzantine));
  }

  if (autoBroadcast) {
    for (let i = 0; i < count; i++) {
      const otherValidators = validators.filter((_, j) => j !== i);
      validators[i].setBroadcastCallback(async (vote) => {
        for (const other of otherValidators) {
          try {
            await other.onVote(vote);
          } catch {
            // Validator may reject duplicate votes
          }
        }
      });
    }
  }

  return { validators, validatorInfos };
}
