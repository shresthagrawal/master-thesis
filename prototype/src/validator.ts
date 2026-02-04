import { createServer, IncomingMessage, ServerResponse } from "http";
import { ethers } from "ethers";
import {
  Vote,
  ValidatorInfo,
  GenesisAccount,
  JsonRpcRequest,
  JsonRpcResponse,
  IValidator,
  RecoveryInfo,
} from "./common.js";
import { ValidatorCore } from "./validator-core.js";

export type { ValidatorInfo, GenesisAccount };
export { ValidatorCore, createValidatorCores } from "./validator-core.js";

// Any validator core that supports broadcast setup
export type ValidatorWithBroadcast = IValidator & {
  setBroadcastCallback(cb: (vote: Vote) => void | Promise<void>): void;
};

type RpcHandler = (params: unknown[]) => Promise<unknown> | unknown;

// Network wrapper around any IValidator core - exposes HTTP JSON-RPC server
export class ValidatorServer {
  public readonly core: ValidatorWithBroadcast;
  public readonly host: string;
  public readonly port: number;
  private rpcHandlers: { [method: string]: RpcHandler } = {};
  private peers: ValidatorInfo[] = [];

  constructor(
    core: ValidatorWithBroadcast,
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
    this.rpcHandlers["submitVote"] = async ([vote]) => {
      await this.core.onVote(vote as Vote);
      return { ok: true };
    };
    this.rpcHandlers["submitVotes"] = async ([votes]) => {
      for (const vote of votes as Vote[]) {
        try { await this.core.onVote(vote); } catch {}
      }
      return { ok: true };
    };
    this.rpcHandlers["eth_getRecoveryInfo"] = ([account]) =>
      this.core.getRecoveryInfo(account as string);

    // Set up fire-and-forget vote broadcasting over network.
    // Intentionally not returning the promise so that onTransaction returns
    // the vote to the client without waiting for peer broadcasts.
    this.core.setBroadcastCallback((vote) => {
      this.broadcastVote(vote);
    });
  }

  get address(): string {
    return this.core.address;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer(
        { insecureHTTPParser: true },
        (req, res) => this.handleRequest(req, res)
      );
      server.keepAliveTimeout = 60000;
      server.listen(this.port, this.host, () => resolve());
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

    const payload = JSON.stringify(response);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
  }

  private broadcastVote(vote: Vote): void {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "submitVote",
      params: [vote],
    });

    for (const peer of this.peers) {
      fetch(`http://${peer.host}:${peer.port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch(() => {});
    }
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

// Generate deterministic validator keys and infos
export function generateValidatorKeys(
  count: number,
  basePort: number = 3000
): { privateKeys: string[]; validatorInfos: ValidatorInfo[] } {
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

  return { privateKeys, validatorInfos };
}

// Helper to create validator network with servers
export function createValidatorNetwork(
  count: number,
  genesisAccounts: GenesisAccount[] = [],
  basePort: number = 3000
): ValidatorServer[] {
  const { privateKeys, validatorInfos } = generateValidatorKeys(count, basePort);

  const servers: ValidatorServer[] = [];
  for (let i = 0; i < count; i++) {
    const core = new ValidatorCore(privateKeys[i], validatorInfos, genesisAccounts);
    servers.push(
      new ValidatorServer(core, "127.0.0.1", basePort + i, validatorInfos)
    );
  }

  return servers;
}
