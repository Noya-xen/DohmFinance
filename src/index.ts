import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as bip39 from "bip39";
import * as ecc from "tiny-secp256k1";
import {
  createKeystore,
  KeystoreSigner,
} from "@alkanes/ts-sdk";

type Id = { block: bigint; tx: bigint };
type AlkaneMap = Record<string, bigint>;
type Utxo = {
  txid: string;
  vout: number;
  sats: number;
  alkanes: AlkaneMap;
  blockHash?: string;
};
type WalletInfo = {
  keystore: string;
  network: "regtest";
  address: string;
  publicKey: string;
  addressType: "p2wpkh";
  createdAt: string;
};
type Config = {
  ids: Record<string, string>;
  params: Record<string, number | string>;
};
type PreparedTx = { psbtBase64: string; action: string };

const BACKEND = process.env.DOHM_BACKEND_URL ?? "https://dohmapi-next.localtests.xyz/api";
const RPC_URL = process.env.DOHM_RPC_URL ?? "https://dohmapi-next.localtests.xyz/rpc";
const ESPLORA_URL = process.env.DOHM_ESPLORA_URL ?? "https://dohmapi-next.localtests.xyz/esplora";
const WALLET_FILE = process.env.DOHM_WALLET_FILE ?? "wallet.json";
const FEE_RATE = Number(process.env.DOHM_FEE_RATE ?? "2");
const DUST = 546;
const NETWORK = bitcoin.networks.regtest;
const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc);

function id(s: string): Id {
  const [block, tx] = s.split(":").map(BigInt);
  return { block, tx };
}

function key(v: Id): string {
  return `${v.block}:${v.tx}`;
}

function deriveAccount(mnemonic: string): { address: string; publicKey: string; addressType: "p2wpkh" } {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Encrypted keystore contains an invalid mnemonic.");
  const root = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic), NETWORK);
  const node = root.derivePath("m/84'/1'/0'/0/0");
  const pubkey = Buffer.from(node.publicKey);
  const address = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address;
  if (!address) throw new Error("Could not derive a regtest wallet address.");
  return { address, publicKey: pubkey.toString("hex"), addressType: "p2wpkh" };
}

function printCredit(): void {
  console.log("\x1b[36m  *==========================================*");
  console.log("    > Built by: Noya-xen (Github)");
  console.log("    > Follow me on X : @xinomixo");
  console.log("  *==========================================*\x1b[0m\n");
}

function banner(): void {
  console.log("\x1b[36mDOHM TESTNET ACTIVITY\x1b[0m");
  console.log("Bitcoin Regtest + ALKANES | interactive activity runner\n");
  printCredit();
}

function requirePassword(): string {
  const password = process.env.DOHM_WALLET_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("Set DOHM_WALLET_PASSWORD (minimum 8 characters) in .env first.");
  }
  return password;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function loadWallet(): Promise<{ signer: KeystoreSigner; info: WalletInfo }> {
  const info = await readJson<WalletInfo>(WALLET_FILE);
  if (info.network !== "regtest" || info.addressType !== "p2wpkh") {
    throw new Error("wallet.json is not a Dohm regtest P2WPKH wallet.");
  }
  const signer = await KeystoreSigner.fromEncrypted(info.keystore, requirePassword(), {
    network: "regtest",
    addressType: "p2wpkh",
  });
  const account = deriveAccount(signer.exportMnemonic());
  if (account.address !== info.address) {
    throw new Error("Wallet address does not match the encrypted keystore.");
  }
  return { signer, info };
}

async function createWallet(): Promise<void> {
  if (await fs.stat(WALLET_FILE).then(() => true).catch(() => false)) {
    throw new Error(`${WALLET_FILE} already exists; refusing to overwrite it.`);
  }
  const password = requirePassword();
  const { keystore, mnemonic } = await createKeystore(password, { network: "regtest", wordCount: 12 });
  const signer = await KeystoreSigner.fromEncrypted(keystore, password, {
    network: "regtest",
    addressType: "p2wpkh",
  });
  const account = deriveAccount(mnemonic);
  const info: WalletInfo = {
    keystore: typeof keystore === "string" ? keystore : JSON.stringify(keystore),
    network: "regtest",
    address: account.address,
    publicKey: account.publicKey,
    addressType: "p2wpkh",
    createdAt: new Date().toISOString(),
  };
  await writePrivateJson(WALLET_FILE, info);
  console.log(`\x1b[32m[✓] Wallet saved: ${WALLET_FILE}\x1b[0m`);
  console.log(`[i] Address: ${account.address}`);
  console.log("[!] Mnemonic tidak disimpan oleh script. Backup wallet.json secara aman.");
}

async function backupWallet(): Promise<void> {
  const { signer, info } = await loadWallet();
  console.log("\n\x1b[33m[!] Recovery phrase adalah kunci penuh wallet. Jangan kirim atau upload ke siapa pun.\x1b[0m");
  console.log(`[i] Address: ${info.address}`);
  console.log("[i] Recovery phrase (12 words):");
  console.log(`\x1b[33m${signer.exportMnemonic()}\x1b[0m`);
  console.log("[i] Simpan di password manager/catatan terenkripsi, lalu hapus dari terminal history.\n");
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (!response.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? response.status)}`);
  return body.result as T;
}

async function getConfig(): Promise<Config> {
  const response = await fetch(`${BACKEND.replace(/\/$/, "")}/config`);
  if (!response.ok) throw new Error(`config HTTP ${response.status}`);
  const raw = (await response.json()) as Record<string, string | number>;
  return {
    ids: {
      frUSD: String(raw.FRUSD_ALKANE_ID), frBTC: String(raw.FRBTC_ALKANE_ID),
      DOHM: String(raw.DOHM_ALKANE_ID), sDOHM: String(raw.SDOHM_ALKANE_ID),
      treasury: String(raw.TREASURY_ALKANE_ID), bonds: String(raw.BONDS_ALKANE_ID),
      DIESEL: String(raw.DIESEL_ALKANE_ID), FIRE: String(raw.FIRE_ALKANE_ID),
      ammRouter: String(raw.AMM_ROUTER_ALKANE_ID), pool: String(raw.POOL_ALKANE_ID),
      poolDohmFrusd: String(raw.POOL_DOHM_FRUSD_ALKANE_ID),
      poolDohmFrbtc: String(raw.POOL_DOHM_FRBTC_ALKANE_ID),
      poolDohmDiesel: String(raw.POOL_DOHM_DIESEL_ALKANE_ID),
      poolDohmFire: String(raw.POOL_DOHM_FIRE_ALKANE_ID),
    },
    params: {
      bondMarketId: Number(raw.BOND_MARKET_ID), lpBondMarketId: Number(raw.LP_BOND_MARKET_ID),
      frbtcMarketId: Number(raw.FRBTC_MARKET_ID), presaleMarketId: Number(raw.PRESALE_MARKET_ID),
    },
  };
}

function reverseTxid(txid: string): string {
  return txid.match(/../g)!.reverse().join("");
}

async function walletUtxos(address: string): Promise<Utxo[]> {
  const response = await fetch(`${ESPLORA_URL.replace(/\/$/, "")}/address/${address}/utxo`);
  if (!response.ok) throw new Error(`UTXO HTTP ${response.status}`);
  const raw = (await response.json()) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_hash?: string } }>;
  const confirmed = raw.filter((u) => u.status?.confirmed);
  const calls = confirmed.map((u) => ["alkanes_protorunesbyoutpoint", [{ txid: reverseTxid(u.txid), vout: u.vout, protocolTag: "1" }]]);
  const assets = calls.length ? await rpc<unknown[]>("sandshrew_multicall", [calls]) : [];
  return confirmed.map((u, index) => {
    const entries = Array.isArray(assets[index]) ? assets[index] as Array<{ token?: { id?: Id }; rune?: { id?: Id }; runeId?: Id; value?: string | number; balance?: string | number }> : [];
    const alkanes: AlkaneMap = {};
    for (const entry of entries) {
      const rawId = entry.token?.id ?? entry.rune?.id ?? entry.runeId;
      if (!rawId) continue;
      const asset = key({ block: BigInt(rawId.block), tx: BigInt(rawId.tx) });
      alkanes[asset] = (alkanes[asset] ?? 0n) + BigInt(entry.value ?? entry.balance ?? 0);
    }
    return { txid: u.txid, vout: u.vout, sats: u.value, alkanes, blockHash: u.status.block_hash };
  });
}

function leb(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  do { out.push(Number(v & 127n) | (v > 127n ? 128 : 0)); v >>= 7n; } while (v > 0n);
  return out;
}

function u128Chunks(bytes: number[]): bigint[] {
  const out: bigint[] = [];
  for (let start = 0; start < bytes.length; start += 15) {
    let value = 0n;
    for (let i = Math.min(start + 15, bytes.length) - 1; i >= start; i--) value = (value << 8n) | BigInt(bytes[i]);
    out.push(value);
  }
  return out;
}

function pushEdicts(target: bigint[], edicts: Array<{ id: Id; amount: bigint; output: number }>): void {
  if (!edicts.length) return;
  target.push(0n);
  const sorted = [...edicts].sort((a, b) => Number(a.id.block - b.id.block) || Number(a.id.tx - b.id.tx));
  let previous = { block: 0n, tx: 0n };
  for (const edict of sorted) {
    const blockDelta = edict.id.block - previous.block;
    const txDelta = blockDelta === 0n ? edict.id.tx - previous.tx : edict.id.tx;
    target.push(blockDelta, txDelta, edict.amount, BigInt(edict.output));
    previous = edict.id;
  }
}

function protostone(cellpack: bigint[], edicts: Array<{ id: Id; amount: bigint; output: number }> = [], pointer = 0, refundPointer = 0): Uint8Array {
  const cellpackBytes = cellpack.flatMap(leb);
  const inner: bigint[] = [91n, BigInt(pointer), 93n, BigInt(refundPointer)];
  for (const chunk of u128Chunks(cellpackBytes)) inner.push(81n, chunk);
  pushEdicts(inner, edicts);
  inner.unshift(1n, BigInt(inner.length));
  const outer: bigint[] = [];
  for (const chunk of u128Chunks(inner.flatMap(leb))) outer.push(16383n, chunk);
  const payload = outer.flatMap(leb);
  const script: number[] = [106, 93];
  for (let start = 0; start < payload.length; start += 520) {
    const chunk = payload.slice(start, start + 520);
    if (chunk.length < 76) script.push(chunk.length);
    else if (chunk.length <= 255) script.push(76, chunk.length);
    else if (chunk.length <= 65535) script.push(77, chunk.length & 255, chunk.length >> 8);
    else throw new Error("protostone payload too large");
    script.push(...chunk);
  }
  return Uint8Array.from(script);
}

function cell(contract: Id, opcode: number, args: bigint[] = []): bigint[] {
  return [contract.block, contract.tx, BigInt(opcode), ...args];
}

function assetEdict(asset: Id, amount: bigint, output = 0): Array<{ id: Id; amount: bigint; output: number }> {
  return [{ id: asset, amount, output }];
}

function chooseAsset(utxos: Utxo[], asset: string, amount: bigint): { selected: Utxo[]; carried: bigint } {
  const candidates = utxos.filter((u) => (u.alkanes[asset] ?? 0n) > 0n);
  const total = candidates.reduce((sum, u) => sum + (u.alkanes[asset] ?? 0n), 0n);
  if (total < amount) throw new Error(`Insufficient ${asset}: need ${amount}, have ${total}`);
  candidates.sort((a, b) => Number((b.alkanes[asset] ?? 0n) - (a.alkanes[asset] ?? 0n)));
  const selected: Utxo[] = [];
  let carried = 0n;
  for (const u of candidates) { if (carried >= amount) break; selected.push(u); carried += u.alkanes[asset] ?? 0n; }
  return { selected, carried };
}

function feeUtxo(utxos: Utxo[], excluded: Utxo[]): Utxo {
  const excludedKeys = new Set(excluded.map((u) => `${u.txid}:${u.vout}`));
  const fee = utxos.filter((u) => !excludedKeys.has(`${u.txid}:${u.vout}`) && Object.values(u.alkanes).every((v) => v === 0n) && u.sats > DUST).sort((a, b) => b.sats - a.sats)[0];
  if (!fee) throw new Error("No spendable BTC UTXO available for fees. Run: start faucet");
  return fee;
}

function buildPsbt(account: { address: string; publicKey: string; addressType: string }, inputs: Utxo[], script: Uint8Array, leadingOutputs = 1, action: string): PreparedTx {
  const total = inputs.reduce((sum, u) => sum + u.sats, 0);
  const outputCount = leadingOutputs + 2;
  const fee = Math.ceil((20 + inputs.length * 68 + outputCount * 31 + script.length) * FEE_RATE);
  const change = total - leadingOutputs * DUST - fee;
  if (change < DUST) throw new Error(`Insufficient BTC for fee/dust: need about ${leadingOutputs * DUST + fee}, have ${total}`);
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  const payment = bitcoin.address.toOutputScript(account.address, NETWORK);
  for (const u of inputs) {
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: payment, value: u.sats } });
  }
  for (let i = 0; i < leadingOutputs; i++) psbt.addOutput({ script: payment, value: DUST });
  psbt.addOutput({ script: Buffer.from(script), value: 0 });
  psbt.addOutput({ script: payment, value: change });
  return { psbtBase64: psbt.toBase64(), action };
}

async function prepareAssetTx(account: WalletInfo, asset: string, amount: bigint, script: Uint8Array, action: string, leadingOutputs = 1): Promise<PreparedTx> {
  const utxos = await walletUtxos(account.address);
  const picked = chooseAsset(utxos, asset, amount);
  const fee = feeUtxo(utxos, picked.selected);
  return buildPsbt(account, [...picked.selected, fee], script, leadingOutputs, action);
}

async function prepareBond(account: WalletInfo, cfg: Config, amount: bigint, marketId: number, reserveId: string): Promise<PreparedTx> {
  const utxos = await walletUtxos(account.address);
  const picked = chooseAsset(utxos, reserveId, amount);
  const fee = feeUtxo(utxos, picked.selected);
  const script = protostone(cell(id(cfg.ids.bonds), 2, [BigInt(marketId), amount, 0n]), assetEdict(id(reserveId), picked.carried));
  return buildPsbt(account, [...picked.selected, fee], script, 1, "bond");
}

async function prepareClaim(account: WalletInfo, cfg: Config, orbital: string): Promise<PreparedTx> {
  const utxos = await walletUtxos(account.address);
  const picked = chooseAsset(utxos, orbital, 1n);
  const fee = feeUtxo(utxos, picked.selected);
  const script = protostone(cell(id(cfg.ids.bonds), 3));
  return buildPsbt(account, [...picked.selected, fee], script, 1, "claim-matured-bond");
}

async function prepareStake(account: WalletInfo, cfg: Config, amount: bigint, unstake = false): Promise<PreparedTx> {
  const asset = unstake ? cfg.ids.sDOHM : cfg.ids.DOHM;
  const contract = id(cfg.ids.sDOHM);
  const opcode = unstake ? 2 : 1;
  const script = protostone(cell(contract, opcode, [amount]), assetEdict(id(asset), amount));
  return prepareAssetTx(account, asset, amount, script, unstake ? "unstake" : "stake");
}

async function prepareSwap(account: WalletInfo, cfg: Config, amount: bigint, sellDohm: boolean, minOut = 0n): Promise<PreparedTx> {
  const tokenIn = id(sellDohm ? cfg.ids.DOHM : cfg.ids.frBTC);
  const tokenOut = id(sellDohm ? cfg.ids.frBTC : cfg.ids.DOHM);
  const args = [2n, tokenIn.block, tokenIn.tx, tokenOut.block, tokenOut.tx, amount, minOut, 10000000000n];
  const script = protostone(cell(id(cfg.ids.ammRouter), 13, args), assetEdict(tokenIn, amount));
  return prepareAssetTx(account, key(tokenIn), amount, script, "swap");
}

async function prepareAddLiquidity(account: WalletInfo, cfg: Config, dohm: bigint, frbtc: bigint, minDohm = 0n, minFrbtc = 0n): Promise<PreparedTx> {
  const token0 = id(cfg.ids.DOHM), token1 = id(cfg.ids.frBTC), pool = id(cfg.ids.poolDohmFrbtc ?? cfg.ids.pool ?? "2:9");
  const reversed = token1.block < token0.block || (token1.block === token0.block && token1.tx < token0.tx);
  const [first, second] = reversed ? [token1, token0] : [token0, token1];
  const [firstAmount, secondAmount] = reversed ? [frbtc, dohm] : [dohm, frbtc];
  const [firstMin, secondMin] = reversed ? [minFrbtc, minDohm] : [minDohm, minFrbtc];
  const args = [first.block, first.tx, second.block, second.tx, firstAmount, secondAmount, firstMin, secondMin, 10000000000n];
  const utxos = await walletUtxos(account.address);
  const a = chooseAsset(utxos, key(token0), dohm), b = chooseAsset(utxos, key(token1), frbtc);
  const fee = feeUtxo(utxos, [...a.selected, ...b.selected]);
  const selected = [...new Map([...a.selected, ...b.selected].map((u) => [`${u.txid}:${u.vout}`, u])).values()];
  const script = protostone(cell(id(cfg.ids.ammRouter), 11, args), [...assetEdict(token0, a.carried, 1), ...assetEdict(token1, b.carried, 1)]);
  return buildPsbt(account, [...selected, fee], script, 2, `add-liquidity:${key(pool)}`);
}

async function prepareRemoveLiquidity(account: WalletInfo, cfg: Config, amount: bigint, minDohm = 0n, minFrbtc = 0n): Promise<PreparedTx> {
  const pool = id(cfg.ids.poolDohmFrbtc ?? cfg.ids.pool ?? "2:9"), token0 = id(cfg.ids.DOHM), token1 = id(cfg.ids.frBTC);
  const utxos = await walletUtxos(account.address);
  const picked = chooseAsset(utxos, key(pool), amount), fee = feeUtxo(utxos, picked.selected);
  const reversed = token1.block < token0.block || (token1.block === token0.block && token1.tx < token0.tx);
  const [first, second] = reversed ? [token1, token0] : [token0, token1];
  const [firstMin, secondMin] = reversed ? [minFrbtc, minDohm] : [minDohm, minFrbtc];
  const args = [first.block, first.tx, second.block, second.tx, amount, firstMin, secondMin, 10000000000n];
  const script = protostone(cell(id(cfg.ids.ammRouter), 12, args), assetEdict(pool, picked.carried, 1));
  return buildPsbt(account, [...picked.selected, fee], script, 2, "remove-liquidity");
}

async function prepareFrbtcMint(account: WalletInfo, cfg: Config, attestation: bigint[]): Promise<PreparedTx> {
  const utxos = await walletUtxos(account.address);
  const fee = feeUtxo(utxos, []);
  const script = protostone(cell(id(cfg.ids.frBTC), 78, [BigInt(attestation.length), ...attestation]));
  return buildPsbt(account, [fee], script, 1, "frBTC-mint");
}

async function signAndBroadcast(prepared: PreparedTx, signer: KeystoreSigner): Promise<string> {
  console.log(`[~] ${prepared.action} | signing and broadcasting...`);
  const signed = await signer.signPsbt(prepared.psbtBase64, { finalize: true, extractTx: true });
  if (!signed.txHex) throw new Error("Signer did not return an extracted transaction.");
  const txid = await rpc<string>("btc_sendrawtransaction", [signed.txHex]);
  console.log(`\x1b[32m[✓] Broadcast: ${txid}\x1b[0m`);
  return txid;
}

async function faucet(address: string, kind: "btc" | "frbtc", info?: WalletInfo, cfg?: Config, signer?: KeystoreSigner): Promise<void> {
  const endpoint = kind === "btc" ? "/faucet-btc" : "/frbtc/attest";
  const response = await fetch(`${BACKEND.replace(/\/$/, "")}${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "btc" ? { address } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${kind} faucet HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (kind === "btc") {
    console.log(`\x1b[32m[✓] BTC faucet request accepted:\x1b[0m`, body);
    return;
  }
  const raw = body.attestation ?? body.data ?? body.result;
  if (!info || !cfg || !signer || !Array.isArray(raw)) {
    console.log("[i] frBTC attestation received, but no transaction was built:", body);
    return;
  }
  const attestation = raw.map((value: string | number | bigint) => BigInt(value));
  const prepared = await prepareFrbtcMint(info, cfg, attestation);
  await signAndBroadcast(prepared, signer);
}

type SimulationResult = { execution?: { data?: string }; data?: string };

async function simulateOrbital(target: Id, inputs: number[]): Promise<Uint8Array> {
  const context = {
    target: { block: String(target.block), tx: String(target.tx) },
    inputs: inputs.map(String), alkanes: [], transaction: "0x", block: "0x",
    height: "0", txindex: 0, pointer: 0, refundPointer: 0, vout: 0, calldata: "0x",
  };
  const result = await rpc<SimulationResult>("alkanes_simulate", [context]);
  const data = (result.execution?.data ?? result.data ?? "").replace(/^0x/, "");
  return Uint8Array.from(Buffer.from(data, "hex"));
}

function simulationText(data: Uint8Array): string {
  return Buffer.from(data).toString().replace(/\0+$/g, "").trim();
}

function readU128LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = Math.min(offset + 16, bytes.length) - 1; i >= offset; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

async function matureBondInfo(orbital: string, currentHeight: number): Promise<{ matured: boolean; payout: bigint; vestingEnd: bigint }> {
  const target = id(orbital);
  const label = simulationText(await simulateOrbital(target, [100]));
  if (!label.includes("DOHM-BOND") && !label.includes("DOHM Bond Note")) return { matured: false, payout: 0n, vestingEnd: 0n };
  const state = await simulateOrbital(target, [102]);
  if (state.length < 64) return { matured: false, payout: 0n, vestingEnd: 0n };
  const payout = readU128LE(state, 0);
  const vestingEnd = readU128LE(state, 16);
  const claimed = readU128LE(state, 32);
  return { matured: Number(vestingEnd) <= currentHeight && payout > claimed, payout, vestingEnd };
}

async function status(): Promise<void> {
  const { info } = await loadWallet();
  const cfg = await getConfig();
  const utxos = await walletUtxos(info.address);
  const totals: AlkaneMap = {};
  for (const u of utxos) for (const [asset, amount] of Object.entries(u.alkanes)) totals[asset] = (totals[asset] ?? 0n) + amount;
  console.log({ address: info.address, btcSats: utxos.reduce((s, u) => s + u.sats, 0), DOHM: (totals[cfg.ids.DOHM] ?? 0n).toString(), frBTC: (totals[cfg.ids.frBTC] ?? 0n).toString(), sDOHM: (totals[cfg.ids.sDOHM] ?? 0n).toString(), lpDohmFrbtc: (totals[cfg.ids.poolDohmFrbtc] ?? 0n).toString(), utxos: utxos.length });
}

async function claimMatured(): Promise<void> {
  const { signer, info } = await loadWallet();
  const cfg = await getConfig();
  const utxos = await walletUtxos(info.address);
  const currentHeight = Number(await rpc<number>("btc_getblockcount"));
  const bondKeys = [...new Set(utxos.flatMap((u) => Object.keys(u.alkanes).filter((asset) => asset.startsWith("2:"))))];
  let claimed = 0;
  for (const orbital of bondKeys) {
    try {
      const maturity = await matureBondInfo(orbital, currentHeight);
      if (!maturity.matured) continue;
      const prepared = await prepareClaim(info, cfg, orbital);
      await signAndBroadcast(prepared, signer);
      claimed++;
    } catch (error) { console.log(`[~] Skip ${orbital}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`[i] Matured bond claims prepared: ${claimed} | current height: ${currentHeight}`);
}

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askLine(rl: readline.Interface, label: string, fallback?: string): Promise<string> {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback || "";
}

function amountEnv(name: string, fallback: string): bigint {
  const raw = process.env[name] ?? fallback;
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} harus lebih besar dari 0.`);
  return value;
}

function printMenu(): void {
  console.log("\x1b[36m────────────────────────────────────────────");
  console.log("                 MAIN MENU");
  console.log("────────────────────────────────────────────\x1b[0m");
  console.log("[1] Create Wallet and Save Wallet");
  console.log("[2] Faucet BTC + frBTC");
  console.log("[3] Bonding");
  console.log("[4] Claim Matured Bonds");
  console.log("[5] Try Feature Swap");
  console.log("[6] Stake and Unstake");
  console.log("[7] Add Liquidity and Remove Liquidity");
  console.log("[8] Wallet Status");
  console.log("[9] Full Auto (All Actions)");
  console.log("[B] Backup Wallet Recovery Phrase");
  console.log("[0] Exit\n");
}

type StepResult = { label: string; success: boolean };

async function runStep(results: StepResult[], label: string, action: () => Promise<void>): Promise<boolean> {
  try {
    console.log(`\n\x1b[34m[>] ${label}\x1b[0m`);
    await action();
    results.push({ label, success: true });
    console.log(`\x1b[32m[✓] ${label} selesai\x1b[0m`);
    return true;
  } catch (error) {
    results.push({ label, success: false });
    console.log(`\x1b[31m[✗] ${label} gagal: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    return false;
  }
}

function printSummary(results: StepResult[]): void {
  const success = results.filter((result) => result.success).length;
  const failed = results.length - success;
  console.log("\n\x1b[36m──────────────────── SUMMARY ────────────────────\x1b[0m");
  console.log(`\x1b[32mTotal Sukses : ${success}\x1b[0m`);
  console.log(`\x1b[31mTotal Gagal  : ${failed}\x1b[0m`);
  console.log(`Total Aksi   : ${results.length}`);
  console.log("\x1b[36m──────────────────────────────────────────────────\x1b[0m\n");
}

async function waitForAssetBalance(address: string, asset: string, minimum: bigint, timeoutMs = 120000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await walletUtxos(address);
    const balance = utxos.reduce((sum, utxo) => sum + (utxo.alkanes[asset] ?? 0n), 0n);
    if (balance >= minimum) return balance;
    await delay(5000);
  }
  throw new Error(`Asset ${asset} belum terindeks setelah ${Math.floor(timeoutMs / 1000)} detik.`);
}

async function waitForBtcUtxo(address: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await walletUtxos(address);
    if (utxos.some((utxo) => Object.values(utxo.alkanes).every((value) => value === 0n) && utxo.sats > DUST)) return;
    await delay(5000);
  }
  throw new Error("BTC faucet belum menghasilkan UTXO fee yang terkonfirmasi.");
}

async function runStakeUnstake(info: WalletInfo, cfg: Config, signer: KeystoreSigner, results: StepResult[]): Promise<void> {
  const amount = amountEnv("DOHM_DEFAULT_STAKE_AMOUNT", "1000000");
  const staked = await runStep(results, `Stake ${amount}`, async () => {
    const prepared = await prepareStake(info, cfg, amount, false);
    await signAndBroadcast(prepared, signer);
  });
  if (staked) {
    await runStep(results, "Wait for sDOHM balance", async () => {
      await waitForAssetBalance(info.address, cfg.ids.sDOHM, amount);
    });
  }
  await runStep(results, `Unstake ${amount}`, async () => {
    const prepared = await prepareStake(info, cfg, amount, true);
    await signAndBroadcast(prepared, signer);
  });
}

async function runLiquidityCycle(info: WalletInfo, cfg: Config, signer: KeystoreSigner, results: StepResult[]): Promise<void> {
  const dohm = amountEnv("DOHM_DEFAULT_DOHM_LIQUIDITY", "1000000");
  const frbtc = amountEnv("DOHM_DEFAULT_FRBTC_LIQUIDITY", "1000000");
  const added = await runStep(results, `Add liquidity DOHM=${dohm} frBTC=${frbtc}`, async () => {
    const prepared = await prepareAddLiquidity(info, cfg, dohm, frbtc);
    await signAndBroadcast(prepared, signer);
  });
  if (!added) return;
  const pool = cfg.ids.poolDohmFrbtc;
  await runStep(results, "Wait for LP balance", async () => {
    await waitForAssetBalance(info.address, pool, 1n);
  });
  await runStep(results, "Remove liquidity", async () => {
    const utxos = await walletUtxos(info.address);
    const balance = utxos.reduce((sum, utxo) => sum + (utxo.alkanes[pool] ?? 0n), 0n);
    const configured = BigInt(process.env.DOHM_DEFAULT_REMOVE_LIQUIDITY ?? "0");
    const amount = configured > 0n && configured < balance ? configured : balance;
    if (amount <= 0n) throw new Error("LP balance kosong, tidak ada liquidity untuk di-remove.");
    const prepared = await prepareRemoveLiquidity(info, cfg, amount);
    await signAndBroadcast(prepared, signer);
  });
}

async function runFullAuto(info: WalletInfo, cfg: Config, signer: KeystoreSigner): Promise<void> {
  const results: StepResult[] = [];
  await runStep(results, "BTC faucet", async () => faucet(info.address, "btc"));
  await runStep(results, "Wait for BTC fee UTXO", async () => waitForBtcUtxo(info.address));
  await runStep(results, "frBTC faucet and mint", async () => faucet(info.address, "frbtc", info, cfg, signer));
  await runStep(results, "Wait for frBTC balance", async () => { await waitForAssetBalance(info.address, cfg.ids.frBTC, 1n); });
  await runStep(results, "Bonding", async () => {
    const amount = amountEnv("DOHM_DEFAULT_BOND_SATS", "10000");
    const prepared = await prepareBond(info, cfg, amount, Number(cfg.params.frbtcMarketId), cfg.ids.frBTC);
    await signAndBroadcast(prepared, signer);
  });
  await runStep(results, "Swap", async () => {
    const amount = amountEnv("DOHM_DEFAULT_SWAP_AMOUNT", "1000000");
    const sellDohm = (process.env.DOHM_SWAP_DIRECTION ?? "dohm-to-frbtc") === "dohm-to-frbtc";
    const prepared = await prepareSwap(info, cfg, amount, sellDohm);
    await signAndBroadcast(prepared, signer);
  });
  await runStakeUnstake(info, cfg, signer, results);
  await runLiquidityCycle(info, cfg, signer, results);
  await runStep(results, "Claim matured bonds", async () => claimMatured());
  printSummary(results);
}

async function interactiveMenu(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      printMenu();
      const choice = await askLine(rl, "Select option");
      if (choice === "0") return;
      if (choice === "1") {
        try { await createWallet(); } catch (error) { console.log(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
        continue;
      }
      if (choice === "9") {
        const { signer, info } = await loadWallet();
        const cfg = await getConfig();
        await runFullAuto(info, cfg, signer);
        continue;
      }
      if (choice.toLowerCase() === "b") {
        try { await backupWallet(); } catch (error) { console.log(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
        continue;
      }
      const { signer, info } = await loadWallet();
      const cfg = await getConfig();
      const results: StepResult[] = [];
      switch (choice) {
        case "2":
          await runStep(results, "BTC faucet", async () => faucet(info.address, "btc"));
          await runStep(results, "frBTC faucet and mint", async () => faucet(info.address, "frbtc", info, cfg, signer));
          break;
        case "3":
          await runStep(results, "Bonding", async () => {
            const amount = amountEnv("DOHM_DEFAULT_BOND_SATS", "10000");
            const prepared = await prepareBond(info, cfg, amount, Number(cfg.params.frbtcMarketId), cfg.ids.frBTC);
            await signAndBroadcast(prepared, signer);
          });
          break;
        case "4": await runStep(results, "Claim matured bonds", async () => claimMatured()); break;
        case "5":
          await runStep(results, "Swap", async () => {
            const amount = amountEnv("DOHM_DEFAULT_SWAP_AMOUNT", "1000000");
            const sellDohm = (process.env.DOHM_SWAP_DIRECTION ?? "dohm-to-frbtc") === "dohm-to-frbtc";
            const prepared = await prepareSwap(info, cfg, amount, sellDohm);
            await signAndBroadcast(prepared, signer);
          });
          break;
        case "6": await runStakeUnstake(info, cfg, signer, results); break;
        case "7": await runLiquidityCycle(info, cfg, signer, results); break;
        case "8": await runStep(results, "Wallet status", async () => status()); break;
        default: console.log("[!] Pilihan tidak dikenal.");
      }
      printSummary(results);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  banner();
  const [command, subcommand] = process.argv.slice(2).filter((v) => !v.startsWith("--"));
  if (!command) return interactiveMenu();
  if (command === "wallet" && subcommand === "create") return createWallet();
  if (command === "wallet" && subcommand === "backup") return backupWallet();
  if (command === "faucet") {
    const { signer, info } = await loadWallet();
    const cfg = subcommand === "frbtc" ? await getConfig() : undefined;
    return faucet(info.address, subcommand as "btc" | "frbtc", info, cfg, signer);
  }
  if (command === "status") return status();
  const { signer, info } = await loadWallet();
  const cfg = await getConfig();
  const amount = BigInt(arg("amount", "0")!);
  let prepared: PreparedTx;
  switch (command) {
    case "bond": prepared = await prepareBond(info, cfg, amount || BigInt(process.env.DOHM_DEFAULT_BOND_SATS ?? "10000"), Number(arg("market", String(cfg.params.frbtcMarketId ?? 1))), arg("reserve", cfg.ids.frBTC)!); break;
    case "swap": prepared = await prepareSwap(info, cfg, amount || BigInt(process.env.DOHM_DEFAULT_SWAP_AMOUNT ?? "1000000"), arg("direction", "dohm-to-frbtc") === "dohm-to-frbtc", BigInt(arg("min-out", "0")!)); break;
    case "stake": prepared = await prepareStake(info, cfg, amount, false); break;
    case "unstake": prepared = await prepareStake(info, cfg, amount, true); break;
    case "add-liquidity": prepared = await prepareAddLiquidity(info, cfg, BigInt(arg("dohm", "0")!), BigInt(arg("frbtc", "0")!), BigInt(arg("min-dohm", "0")!), BigInt(arg("min-frbtc", "0")!)); break;
    case "remove-liquidity": prepared = await prepareRemoveLiquidity(info, cfg, amount, BigInt(arg("min-dohm", "0")!), BigInt(arg("min-frbtc", "0")!)); break;
    case "claim-matured": return claimMatured();
    default: throw new Error("Unknown command. See README.md for commands.");
  }
  await signAndBroadcast(prepared, signer);
}

main().catch((error) => { console.error(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); process.exitCode = 1; });
