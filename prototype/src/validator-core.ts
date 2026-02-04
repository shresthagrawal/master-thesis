import { ethers, Transaction } from "ethers";
import {
  AccountState,
  Vote,
  Certificate,
  RecoveryInfo,
  ChainEntry,
  ValidatorInfo,
  GenesisAccount,
  IValidator,
  F_BYZANTINE,
  RECOVERY_CONTRACT,
  countQuorum,
  verifyVote,
  voteTx,
  voteTxHash,
} from "./common.js";

export type { ValidatorInfo, GenesisAccount };

// Callback for broadcasting votes to peers
export type BroadcastVoteCallback = (vote: Vote) => void | Promise<void>;

export class ValidatorCore implements IValidator {
  public readonly address: string;
  public readonly finalityQuorum: number;
  public readonly notarisationQuorum: number;
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
    broadcastVote: BroadcastVoteCallback = () => {},
    fByzantine: number = F_BYZANTINE,
    skipVerification: boolean = false
  ) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.broadcastVoteCallback = broadcastVote;
    this.skipVerification = skipVerification;

    const n = validators.length;
    this.finalityQuorum = n - fByzantine;
    this.notarisationQuorum = n - 3 * fByzantine;

    // Store validator set
    this.validatorSet = new Set(validators.map((v) => v.address.toLowerCase()));

    // Initialize genesis accounts
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

  private async signVote(account: string, nonce: number, tx: Transaction | null): Promise<Vote> {
    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "bytes32"],
      [account, nonce, tx?.hash ?? ethers.ZeroHash]
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(message));
    return { validator: this.address, account, nonce, serializedTx: tx?.serialized ?? null, signature };
  }

  // Receives a signed transaction (serialized hex string)
  async onTransaction(signedTx: string): Promise<Vote> {
    const tx = Transaction.from(signedTx);
    // tx.from is recovered from the signature; null means invalid or missing signature
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

    if (tx.to!.toLowerCase() === RECOVERY_CONTRACT.toLowerCase()) {
      this.validateRecovery(tx);
    } else {
      this.validatePayment(tx);
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

  private validatePayment(tx: Transaction): void {
    const account = this.getAccount(tx.from!);
    if (account.finalised !== tx.nonce - 1) {
      throw new Error("Previous nonce not finalised");
    }
    if (account.balance < tx.value) {
      throw new Error("Insufficient balance");
    }
  }

  private validateRecovery(tx: Transaction): void {
    if (!tx.data || tx.data === "0x") {
      throw new Error("Recovery transaction missing tip");
    }

    const tipTx = Transaction.from(tx.data);
    const sender = tx.from!.toLowerCase();

    // Verify tip belongs to the same account
    if (tipTx.from?.toLowerCase() !== sender) {
      throw new Error("Tip transaction sender mismatch");
    }

    // Verify tip has notarisation quorum
    const tipVotes = this.getVotes(sender, tipTx.nonce);
    if (countQuorum(tipVotes, tipTx.hash!) < this.notarisationQuorum) {
      throw new Error("Tip transaction doesn't have notarisation quorum");
    }

    // Verify all intermediate nonces have bot certificates
    for (let k = tipTx.nonce + 1; k < tx.nonce; k++) {
      const kVotes = this.getVotes(sender, k);
      if (countQuorum(kVotes, null) < this.notarisationQuorum) {
        throw new Error(`Intermediate nonce ${k} missing bot certificate`);
      }
    }
  }

  async onVote(vote: Vote): Promise<void> {
    // Verify vote signature and validator set membership
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

    if (vote.serializedTx !== null) {
      // Normal vote: drop if we already have any vote from this validator
      if (existing.some((v) => v.validator === vote.validator)) {
        return;
      }
    } else {
      // Bot vote: drop only if we already have a bot vote from this validator
      if (existing.some((v) => v.validator === vote.validator && v.serializedTx === null)) {
        return;
      }
    }

    existing.push(vote);

    await this.processCertificate(vote.account, vote.nonce);
  }

  private async processCertificate(account: string, nonce: number): Promise<void> {
    const acc = this.getAccount(account);
    const votes = this.getVotes(account, nonce);
    const { quorum, tx } = this.getMaxQuorumCert(votes);
    let nonceIncremented = false;

    // Handle current nonce
    if (nonce === acc.nonce) {
      if (quorum < this.notarisationQuorum) {
        // No transaction has notarisation quorum - try signing bot
        const alreadyVotedBot = votes.some((v) => v.validator === this.address && v.serializedTx === null);
        if (votes.length >= this.finalityQuorum && !alreadyVotedBot) {
          acc.pending = true;
          const botVote = await this.signVote(account, nonce, null);
          await this.onVote(botVote);
          await this.broadcastVoteCallback(botVote);
        }
      } else {
        // Notarisation quorum reached - try advancing nonce
        if (acc.pending) {
          acc.nonce = nonce + 1;
          acc.pending = false;
          nonceIncremented = true;
        }
      }
    }

    // Handle finality (n-f quorum)
    if (quorum >= this.finalityQuorum && nonce > acc.finalised && tx !== null) {
      const originalTx = this.getTxChainStart(tx);
      // Original tx must be same as finalized or next (+1)
      if (originalTx.nonce === acc.finalised || originalTx.nonce === acc.finalised + 1) {
        if (originalTx.nonce === acc.finalised + 1) {
          this.executeTransfer(originalTx);
        }
        acc.finalised = nonce;
        if (nonce >= acc.nonce) {
          acc.nonce = nonce + 1;
          acc.pending = false;
          nonceIncremented = true;
        }
      }
    }

    // If nonce was incremented, try processing next nonce in case we have votes
    if (nonceIncremented) {
      await this.processCertificate(account, acc.nonce);
    }
  }

  private executeTransfer(tx: Transaction): void {
    const senderAcc = this.getAccount(tx.from!);
    const recipientAcc = this.getAccount(tx.to!);
    senderAcc.balance -= tx.value;
    recipientAcc.balance += tx.value;
  }

  private getTxChainStart(tx: Transaction): Transaction {
    if (tx.to!.toLowerCase() === RECOVERY_CONTRACT.toLowerCase() && tx.data && tx.data !== "0x") {
      const tipTx = Transaction.from(tx.data);
      return this.getTxChainStart(tipTx);
    }
    return tx;
  }

  // Recovery RPC: returns info needed for client to recover
  getRecoveryInfo(account: string): RecoveryInfo {
    const acc = this.getAccount(account);
    const kf = acc.finalised;
    const kn = acc.nonce;

    // Get finalized transaction and its certificate
    let serializedFinalisedTx: string | null = null;
    let cf: Certificate | null = null;
    if (kf >= 0) {
      const votes = this.getVotes(account, kf);
      const { tx, cert } = this.getMaxQuorumCert(votes, this.finalityQuorum);
      if (tx && cert) {
        serializedFinalisedTx = tx.serialized;
        cf = cert;
      }
    }

    // Build chain of (n-3f) certificates from kf+1 to kn-1
    const chain: ChainEntry[] = [];
    for (let k = kf + 1; k < kn; k++) {
      const votes = this.getVotes(account, k);
      const { tx, cert } = this.getMaxQuorumCert(votes, this.notarisationQuorum);
      if (!cert) {
        throw new Error(`Missing notarisation certificate at nonce ${k}`);
      }
      chain.push({ nonce: k, serializedTx: tx?.serialized ?? null, cert });
    }

    return { finalisedNonce: kf, serializedFinalisedTx, finalityCert: cf, currentNonce: kn, chain };
  }

  private getMaxQuorumCert(votes: Vote[], minQuorum: number = 1): { quorum: number; tx: Transaction | null; cert: Certificate | null } {
    const votesByTx: { [key: string]: Vote[] } = {};
    for (const vote of votes) {
      const key = voteTxHash(vote) ?? "BOT";
      if (!votesByTx[key]) votesByTx[key] = [];
      votesByTx[key].push(vote);
    }

    let maxQuorum = 0;
    let maxTx: Transaction | null = null;
    let maxVotes: Vote[] = [];

    for (const txVotes of Object.values(votesByTx)) {
      const count = new Set(txVotes.map((v) => v.validator)).size;
      if (count > maxQuorum) {
        maxQuorum = count;
        maxTx = voteTx(txVotes[0]);
        maxVotes = txVotes;
      }
    }

    if (maxQuorum >= minQuorum) {
      return { quorum: maxQuorum, tx: maxTx, cert: { votes: maxVotes } };
    }
    return { quorum: 0, tx: null, cert: null };
  }
}

// Helper to create a set of validator cores for testing (no auto-broadcast)
export function createValidatorCores(
  count: number,
  genesisAccounts: GenesisAccount[] = [],
  autoBroadcast: boolean = false,
  fByzantine: number = F_BYZANTINE
): { validators: ValidatorCore[]; validatorInfos: ValidatorInfo[] } {
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

  const validators: ValidatorCore[] = [];
  for (let i = 0; i < count; i++) {
    validators.push(new ValidatorCore(privateKeys[i], validatorInfos, genesisAccounts, () => {}, fByzantine));
  }

  // Optionally wire up vote broadcasting between validators
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

// Helper to propagate a vote to all validators
export async function propagateVote(validators: ValidatorCore[], vote: Vote): Promise<void> {
  for (const v of validators) {
    try {
      await v.onVote(vote);
    } catch {
      // Validator may reject duplicate votes
    }
  }
}
