import { ethers } from "ethers";

// Protocol parameters from environment (default: n = 5f + 1, with f = 1)
export const F_BYZANTINE = parseInt(process.env.F_BYZANTINE || "1", 10);
export const N_VALIDATORS = parseInt(process.env.N_VALIDATORS || String(5 * F_BYZANTINE + 1), 10);
export const QUORUM_SIZE = N_VALIDATORS - F_BYZANTINE; // n - f
export const MAJORITY_QUORUM = N_VALIDATORS - 3 * F_BYZANTINE; // n - 3f

// Special address for recovery contract (precompile style)
export const RECOVERY_CONTRACT = "0x0000000000000000000000000000000000000100";

// Account state maintained by validators
export interface AccountState {
  balance: bigint;
  nonce: number; // next nonce to sign
  pending: boolean;
  finalised: number; // last finalised nonce
}

// Transaction structure
export interface Transaction {
  sender: string;
  recipient: string;
  amount: bigint;
  nonce: number;
  tip?: string; // for recovery: reference to tip transaction hash
}

// Signed vote from a validator
export interface Vote {
  validatorId: number;
  account: string;
  nonce: number;
  txHash: string | null; // null represents bot
  signature: string;
}

// Certificate: collection of votes
export interface Certificate {
  votes: Vote[];
  txHash: string | null;
}

// Event emitter for broadcasting
type VoteListener = (vote: Vote) => void;
type CertificateListener = (cert: Certificate, tx: Transaction | null) => void;

export class Validator {
  public readonly id: number;
  private wallet: ethers.Wallet;
  private accounts: Map<string, AccountState> = new Map();
  private votes: Map<string, Vote[]> = new Map(); // key: account:nonce
  private certificates: Map<string, Certificate> = new Map(); // key: txHash
  private transactions: Map<string, Transaction> = new Map(); // key: txHash
  private voteListeners: VoteListener[] = [];
  private certListeners: CertificateListener[] = [];

  constructor(id: number, privateKey: string) {
    this.id = id;
    this.wallet = new ethers.Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  onVote(listener: VoteListener): void {
    this.voteListeners.push(listener);
  }

  onCertificate(listener: CertificateListener): void {
    this.certListeners.push(listener);
  }

  private broadcastVote(vote: Vote): void {
    for (const listener of this.voteListeners) {
      listener(vote);
    }
  }

  private broadcastCertificate(cert: Certificate, tx: Transaction | null): void {
    for (const listener of this.certListeners) {
      listener(cert, tx);
    }
  }

  private getAccount(address: string): AccountState {
    const normalized = address.toLowerCase();
    if (!this.accounts.has(normalized)) {
      this.accounts.set(normalized, {
        balance: 0n,
        nonce: 0,
        pending: false,
        finalised: -1,
      });
    }
    return this.accounts.get(normalized)!;
  }

  // Public accessors
  getAccountState(address: string): AccountState {
    return this.getAccount(address);
  }

  getVotes(account: string, nonce: number): Vote[] {
    return this.votes.get(`${account.toLowerCase()}:${nonce}`) || [];
  }

  getTransaction(txHash: string): Transaction | undefined {
    return this.transactions.get(txHash);
  }

  // Store a transaction (for gossip/propagation)
  storeTransaction(tx: Transaction, txHash: string): void {
    this.transactions.set(txHash, tx);
  }

  private computeTxHash(tx: Transaction): string {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint256", "string"],
      [tx.sender, tx.recipient, tx.amount, tx.nonce, tx.tip || ""]
    );
    return ethers.keccak256(encoded);
  }

  private async signVote(
    account: string,
    nonce: number,
    txHash: string | null
  ): Promise<Vote> {
    const message = ethers.solidityPackedKeccak256(
      ["address", "uint256", "bytes32"],
      [account, nonce, txHash || ethers.ZeroHash]
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(message));
    return {
      validatorId: this.id,
      account,
      nonce,
      txHash,
      signature,
    };
  }

  // Algorithm 1: OnTransaction
  async onTransaction(tx: Transaction, senderSignature: string): Promise<Vote | null> {
    const sender = tx.sender.toLowerCase();
    const account = this.getAccount(sender);

    // Verify signature
    const txHash = this.computeTxHash(tx);
    const recoveredAddress = ethers.verifyMessage(ethers.getBytes(txHash), senderSignature);
    if (recoveredAddress.toLowerCase() !== sender) {
      console.log(`[V${this.id}] Invalid signature for tx from ${sender}`);
      return null;
    }

    // Check not pending
    if (account.pending) {
      console.log(`[V${this.id}] Account ${sender} is pending`);
      return null;
    }

    // Check nonce
    if (tx.nonce !== account.nonce) {
      console.log(`[V${this.id}] Nonce mismatch: expected ${account.nonce}, got ${tx.nonce}`);
      return null;
    }

    // Validate based on transaction type
    if (tx.recipient.toLowerCase() === RECOVERY_CONTRACT.toLowerCase()) {
      if (!this.validateRecovery(tx)) {
        return null;
      }
    } else {
      if (!this.validatePayment(tx, account)) {
        return null;
      }
    }

    // Mark as pending and store transaction
    account.pending = true;
    this.transactions.set(txHash, tx);

    // Create and broadcast vote
    const vote = await this.signVote(sender, tx.nonce, txHash);
    this.storeVote(vote);
    this.broadcastVote(vote);

    console.log(`[V${this.id}] Voted for tx ${txHash.slice(0, 10)}... from ${sender} at nonce ${tx.nonce}`);
    return vote;
  }

  private validatePayment(tx: Transaction, account: AccountState): boolean {
    // Check previous nonce was finalised
    if (account.finalised !== tx.nonce - 1) {
      console.log(`[V${this.id}] Previous nonce not finalised: finalised=${account.finalised}, tx.nonce=${tx.nonce}`);
      return false;
    }

    // Check sufficient balance
    if (account.balance < tx.amount) {
      console.log(`[V${this.id}] Insufficient balance: ${account.balance} < ${tx.amount}`);
      return false;
    }

    return true;
  }

  private validateRecovery(tx: Transaction): boolean {
    if (!tx.tip) {
      console.log(`[V${this.id}] Recovery tx missing tip`);
      return false;
    }

    // Look up the tip transaction
    const tipTx = this.transactions.get(tx.tip);
    if (!tipTx) {
      console.log(`[V${this.id}] Tip transaction not found: ${tx.tip}`);
      return false;
    }

    // Check tip has (n-3f)-certificate
    const tipVotes = this.getVotes(tipTx.sender, tipTx.nonce);
    const tipQuorum = this.countQuorum(tipVotes, tx.tip);
    if (tipQuorum < MAJORITY_QUORUM) {
      console.log(`[V${this.id}] Tip tx doesn't have majority quorum: ${tipQuorum} < ${MAJORITY_QUORUM}`);
      return false;
    }

    // Check intermediate nonces have bot certificates
    for (let k = tipTx.nonce + 1; k < tx.nonce; k++) {
      const kVotes = this.getVotes(tx.sender, k);
      const botQuorum = this.countQuorum(kVotes, null);
      if (botQuorum < MAJORITY_QUORUM) {
        console.log(`[V${this.id}] Intermediate nonce ${k} missing bot certificate`);
        return false;
      }
    }

    return true;
  }

  private countQuorum(votes: Vote[], txHash: string | null): number {
    const matching = votes.filter((v) => v.txHash === txHash);
    const uniqueValidators = new Set(matching.map((v) => v.validatorId));
    return uniqueValidators.size;
  }

  storeVote(vote: Vote): void {
    const key = `${vote.account.toLowerCase()}:${vote.nonce}`;
    if (!this.votes.has(key)) {
      this.votes.set(key, []);
    }
    const existing = this.votes.get(key)!;
    // Don't store duplicate votes from same validator for same tx
    if (!existing.some((v) => v.validatorId === vote.validatorId && v.txHash === vote.txHash)) {
      existing.push(vote);
    }

    // Check if we have enough votes to form a certificate
    this.checkAndFormCertificate(vote.account, vote.nonce);
  }

  private checkAndFormCertificate(account: string, nonce: number): void {
    const votes = this.getVotes(account, nonce);
    if (votes.length < QUORUM_SIZE) return;

    // Group votes by txHash
    const votesByTx = new Map<string, Vote[]>();
    for (const vote of votes) {
      const key = vote.txHash || "BOT";
      if (!votesByTx.has(key)) {
        votesByTx.set(key, []);
      }
      votesByTx.get(key)!.push(vote);
    }

    // Check if any txHash has quorum
    for (const [txHashKey, txVotes] of votesByTx) {
      const uniqueValidators = new Set(txVotes.map((v) => v.validatorId));
      if (uniqueValidators.size >= QUORUM_SIZE) {
        const txHash = txHashKey === "BOT" ? null : txHashKey;
        const cert: Certificate = { votes: txVotes, txHash };
        if (txHash) {
          this.certificates.set(txHash, cert);
        }
        const tx = txHash ? this.transactions.get(txHash) || null : null;
        this.onCertificate(cert, tx);
        this.broadcastCertificate(cert, tx);
        return;
      }
    }

    // No single tx has full quorum - check if total votes >= n-f (certificate with no majority)
    const uniqueValidators = new Set(votes.map((v) => v.validatorId));
    if (uniqueValidators.size >= QUORUM_SIZE) {
      // Find max quorum
      let maxQuorum = 0;
      let maxTxHash: string | null = null;
      for (const [txHashKey, txVotes] of votesByTx) {
        const count = new Set(txVotes.map((v) => v.validatorId)).size;
        if (count > maxQuorum) {
          maxQuorum = count;
          maxTxHash = txHashKey === "BOT" ? null : txHashKey;
        }
      }

      // If max quorum < n-3f, sign bot
      if (maxQuorum < MAJORITY_QUORUM) {
        this.signAndBroadcastBot(account, nonce);
      }
    }
  }

  private async signAndBroadcastBot(account: string, nonce: number): Promise<void> {
    const acc = this.getAccount(account);
    if (acc.nonce !== nonce) return; // Already moved past this nonce

    acc.pending = true;
    const vote = await this.signVote(account, nonce, null);
    this.storeVote(vote);
    this.broadcastVote(vote);
    console.log(`[V${this.id}] Signed BOT for ${account} at nonce ${nonce}`);
  }

  // Algorithm 2: OnCertificate
  async onCertificate(cert: Certificate, tx: Transaction | null): Promise<void> {
    if (cert.votes.length === 0) return;

    const account = cert.votes[0].account.toLowerCase();
    const nonce = cert.votes[0].nonce;
    const acc = this.getAccount(account);

    // Extract max quorum
    const votesByTx = new Map<string, Vote[]>();
    for (const vote of cert.votes) {
      const key = vote.txHash || "BOT";
      if (!votesByTx.has(key)) {
        votesByTx.set(key, []);
      }
      votesByTx.get(key)!.push(vote);
    }

    let maxQuorum = 0;
    let maxTxHash: string | null = null;
    for (const [txHashKey, txVotes] of votesByTx) {
      const count = new Set(txVotes.map((v) => v.validatorId)).size;
      if (count > maxQuorum) {
        maxQuorum = count;
        maxTxHash = txHashKey === "BOT" ? null : txHashKey;
      }
    }

    const totalUniqueValidators = new Set(cert.votes.map((v) => v.validatorId)).size;

    if (nonce === acc.nonce) {
      if (maxQuorum < MAJORITY_QUORUM) {
        // No full quorum - sign bot
        acc.pending = true;
        const botVote = await this.signVote(account, nonce, null);
        this.storeVote(botVote);
        this.broadcastVote(botVote);
        console.log(`[V${this.id}] Certificate has no majority, signed BOT for ${account} at nonce ${nonce}`);
      } else if (acc.pending) {
        // Update nonce and pending
        acc.nonce = nonce + 1;
        acc.pending = false;
        console.log(`[V${this.id}] Advanced nonce for ${account} to ${acc.nonce}`);
      }
    }

    // Check for finality (n-f quorum)
    if (totalUniqueValidators >= QUORUM_SIZE && maxQuorum >= MAJORITY_QUORUM) {
      if (nonce >= acc.nonce) {
        acc.nonce = nonce + 1;
        acc.pending = false;
      }

      // Finalize and execute
      if (nonce > acc.finalised && maxTxHash !== null) {
        const finalTx = tx || this.transactions.get(maxTxHash);
        if (finalTx) {
          // Follow recovery chain to get original tx
          const originalTx = this.getTxChainStart(finalTx);

          if (originalTx.nonce <= acc.finalised + 1) {
            if (originalTx.nonce === acc.finalised + 1) {
              // Execute transfer
              const senderAcc = this.getAccount(originalTx.sender);
              const recipientAcc = this.getAccount(originalTx.recipient);
              senderAcc.balance -= originalTx.amount;
              recipientAcc.balance += originalTx.amount;
              console.log(`[V${this.id}] Executed transfer: ${originalTx.sender} -> ${originalTx.recipient}: ${originalTx.amount}`);
            }
            acc.finalised = nonce;
            console.log(`[V${this.id}] Finalised ${account} at nonce ${nonce}`);
          }
        }
      }
    }
  }

  private getTxChainStart(tx: Transaction): Transaction {
    if (tx.recipient.toLowerCase() === RECOVERY_CONTRACT.toLowerCase() && tx.tip) {
      const tipTx = this.transactions.get(tx.tip);
      if (tipTx) {
        return this.getTxChainStart(tipTx);
      }
    }
    return tx;
  }

  // For recovery: get a transaction with majority support at a given nonce
  getTipTransaction(account: string): { tx: Transaction; txHash: string } | null {
    const acc = this.getAccount(account);

    // Search backwards from current nonce to find a tx with majority support
    for (let n = acc.nonce - 1; n >= 0; n--) {
      const votes = this.getVotes(account, n);
      const votesByTx = new Map<string, Vote[]>();

      for (const vote of votes) {
        if (vote.txHash) {
          if (!votesByTx.has(vote.txHash)) {
            votesByTx.set(vote.txHash, []);
          }
          votesByTx.get(vote.txHash)!.push(vote);
        }
      }

      for (const [txHash, txVotes] of votesByTx) {
        const uniqueValidators = new Set(txVotes.map((v) => v.validatorId)).size;
        if (uniqueValidators >= MAJORITY_QUORUM) {
          const tx = this.transactions.get(txHash);
          if (tx) {
            return { tx, txHash };
          }
        }
      }
    }

    return null;
  }
}

// Create validator network
export function createValidatorNetwork(count: number = N_VALIDATORS): Validator[] {
  const validators: Validator[] = [];

  for (let i = 0; i < count; i++) {
    // Deterministic private keys for testing
    const privateKey = ethers.keccak256(ethers.toUtf8Bytes(`validator-${i}`));
    validators.push(new Validator(i, privateKey));
  }

  // Connect validators to each other (broadcast votes)
  for (const v of validators) {
    v.onVote((vote) => {
      for (const other of validators) {
        if (other.id !== v.id) {
          other.storeVote(vote);
        }
      }
    });
  }

  return validators;
}
