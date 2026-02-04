// Standalone validator process — spawned by benchmark.ts
// Receives config as JSON via argv[2], starts an HTTP JSON-RPC server
// using the existing ValidatorServer, and prints "READY" when listening.

import { ValidatorServer, generateValidatorKeys } from "./src/validator.js";
import { ValidatorCore } from "./src/validator-core.js";
import { ClassicValidatorCore } from "./src/classic-validator-core.js";
import type { GenesisAccount } from "./src/common.js";

interface ValidatorConfig {
  index: number;
  mode: "classic" | "recovery";
  n: number;
  f: number;
  basePort: number;
  genesis: { address: string; balance: string }[];
  skipVerification?: boolean;
}

const config: ValidatorConfig = JSON.parse(process.argv[2]);

const { privateKeys, validatorInfos } = generateValidatorKeys(config.n, config.basePort);

const genesisAccounts: GenesisAccount[] = config.genesis.map((g) => ({
  address: g.address,
  balance: BigInt(g.balance),
}));

const skip = config.skipVerification ?? false;

const core = config.mode === "classic"
  ? new ClassicValidatorCore(privateKeys[config.index], validatorInfos, genesisAccounts, config.f, () => {}, skip)
  : new ValidatorCore(privateKeys[config.index], validatorInfos, genesisAccounts, () => {}, config.f, skip);

const server = new ValidatorServer(core, "127.0.0.1", config.basePort + config.index, validatorInfos);
server.start().then(() => {
  process.stdout.write("READY\n");
});
