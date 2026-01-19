import { createServer, IncomingMessage, ServerResponse } from "http";
import { ethers } from "ethers";
import {
  Vote,
  ValidatorInfo,
  GenesisAccount,
  JsonRpcRequest,
  JsonRpcResponse,
  IValidator,
  AccountState,
  RecoveryInfo,
} from "./common.js";
import { ValidatorCore } from "./validator-core.js";

export type { ValidatorInfo, GenesisAccount };
export { ValidatorCore, createValidatorCores } from "./validator-core.js";

type RpcHandler = (params: unknown[]) => Promise<unknown> | unknown;

// Network wrapper around ValidatorCore - exposes HTTP JSON-RPC server
export class ValidatorServer {
  public readonly core: ValidatorCore;
  public readonly host: string;
  public readonly port: number;
  private rpcHandlers: { [method: string]: RpcHandler } = {};
  private peers: ValidatorInfo[] = [];

  constructor(
    core: ValidatorCore,
    host: string,
    port: number,
    allValidators: ValidatorInfo[]
  ) {
    this.core = core;
    this.host = host;
    this.port = port;
    this.peers = allValidators.filter(
      (v) => v.address.toLowerCase() !== core.address.toLowerCase()
    );

    // Register RPC handlers
    this.rpcHandlers["eth_sendRawTransaction"] = ([signedTx]) =>
      this.core.onTransaction(signedTx as string);
    this.rpcHandlers["submitVote"] = ([vote]) => {
      this.core.onVote(vote as Vote);
      return { ok: true };
    };
    this.rpcHandlers["eth_getRecoveryInfo"] = ([account]) =>
      this.core.getRecoveryInfo(account as string);

    // Set up vote broadcasting over network
    this.core.setBroadcastCallback((vote) => this.broadcastVote(vote));
  }

  get address(): string {
    return this.core.address;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handleRequest(req, res));
    server.listen(this.port, this.host, () => {
      console.log(`[${this.address.slice(0, 8)}] Listening on ${this.host}:${this.port}`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await this.readBody(req);
    const request: JsonRpcRequest = JSON.parse(body);
    const response: JsonRpcResponse = { jsonrpc: "2.0", id: request.id };

    const handler = this.rpcHandlers[request.method];
    if (!handler) {
      response.error = { code: -32601, message: "Method not found" };
    } else {
      try {
        response.result = await handler(request.params);
      } catch (e) {
        response.error = { code: -32000, message: (e as Error).message };
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });
  }

  private async broadcastVote(vote: Vote): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "submitVote",
      params: [vote],
    };

    for (const peer of this.peers) {
      try {
        await fetch(`http://${peer.host}:${peer.port}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        // Peer unreachable, ignore
      }
    }
  }

  // Expose IValidator methods for direct access
  getAccountState(address: string): AccountState {
    return this.core.getAccountState(address);
  }

  async onTransaction(signedTx: string): Promise<Vote> {
    return this.core.onTransaction(signedTx);
  }
}

// Remote validator client - implements IValidator over HTTP
export class RemoteValidator implements IValidator {
  public readonly address: string;
  private host: string;
  private port: number;

  constructor(info: ValidatorInfo) {
    this.address = info.address;
    this.host = info.host;
    this.port = info.port;
  }

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    const res = await fetch(`http://${this.host}:${this.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    const data: JsonRpcResponse = await res.json();
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }

  async onTransaction(signedTx: string): Promise<Vote> {
    return (await this.rpcCall("eth_sendRawTransaction", [signedTx])) as Vote;
  }

  async onVote(vote: Vote): Promise<void> {
    await this.rpcCall("submitVote", [vote]);
  }

  async getRecoveryInfo(account: string): Promise<RecoveryInfo> {
    return (await this.rpcCall("eth_getRecoveryInfo", [account])) as RecoveryInfo;
  }
}

// Helper to create validator network with servers
export function createValidatorNetwork(
  count: number,
  genesisAccounts: GenesisAccount[] = [],
  basePort: number = 3000
): ValidatorServer[] {
  const { validators, validatorInfos } = createValidatorCoresForNetwork(count, genesisAccounts, basePort);

  const servers: ValidatorServer[] = [];
  for (let i = 0; i < count; i++) {
    servers.push(
      new ValidatorServer(validators[i], "127.0.0.1", basePort + i, validatorInfos)
    );
  }

  return servers;
}

// Internal helper to create cores with network info
function createValidatorCoresForNetwork(
  count: number,
  genesisAccounts: GenesisAccount[],
  basePort: number
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
      port: basePort + i,
    });
  }

  const validators: ValidatorCore[] = [];
  for (let i = 0; i < count; i++) {
    validators.push(new ValidatorCore(privateKeys[i], validatorInfos, genesisAccounts));
  }

  return { validators, validatorInfos };
}
