import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as bip39 from "bip39";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { KeystoreSigner } from "@alkanes/ts-sdk";

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
  mnemonic?: string;
  keystore?: string;
  network: "regtest";
  address: string;
  publicKey: string;
  addressType: "p2wpkh";
  derivationPath?: string;
  createdAt: string;
};
type WalletStore = {
  version: 1;
  wallets: WalletInfo[];
};
type Config = {
  ids: Record<string, string>;
  params: Record<string, number | string>;
};
type BondMarket = {
  id: number;
  capacity: string;
  maxPayout: string;
  vestingBlocks: string;
  isLp: boolean;
  reserveId: string;
};
type PreparedTx = { psbtBase64: string; action: string };

const BACKEND = process.env.DOHM_BACKEND_URL ?? "https://dohmapi-next.localtests.xyz/api";
const RPC_URL = process.env.DOHM_RPC_URL ?? "https://dohmapi-next.localtests.xyz/rpc";
const ESPLORA_URL = process.env.DOHM_ESPLORA_URL ?? "https://dohmapi-next.localtests.xyz/esplora";
const DEV_API_URL = process.env.DOHM_DEV_API_URL ?? defaultDevApiUrl(BACKEND);
const WALLET_FILE = process.env.DOHM_WALLET_FILE ?? "wallet.json";
const MAX_WALLET_BATCH = 100;
const FEE_RATE = Number(process.env.DOHM_FEE_RATE ?? "2");
const DUST = 546;
const POLL_INTERVAL_MS = Number(process.env.DOHM_POLL_INTERVAL_MS ?? "10000");
const SETTLE_TIMEOUT_MS = Number(process.env.DOHM_SETTLE_TIMEOUT_MS ?? "900000");
const NETWORK = bitcoin.networks.regtest;
const DOHM_DERIVATION_PATH = "m/84'/0'/0'/0/0";
const LEGACY_DERIVATION_PATH = "m/84'/1'/0'/0/0";
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

function defaultDevApiUrl(backendUrl: string): string {
  try {
    return `${new URL(backendUrl).origin}/dev-api`;
  } catch {
    return "";
  }
}

function id(s: string): Id {
  const [block, tx] = s.split(":").map(BigInt);
  return { block, tx };
}

function normalizeAssetName(value: string): string {
  const aliases: Record<string, string> = { btc: "BTC", frbtc: "frBTC", frusd: "frUSD", dohm: "DOHM", sdohm: "sDOHM", diesel: "DIESEL", fire: "FIRE" };
  return aliases[value.trim().toLowerCase()] ?? value.trim();
}

function key(v: Id): string {
  return `${v.block}:${v.tx}`;
}

function deriveAccount(mnemonic: string, derivationPath = DOHM_DERIVATION_PATH): { address: string; publicKey: string; addressType: "p2wpkh" } {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Wallet contains an invalid recovery phrase.");
  const root = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic), NETWORK);
  const node = root.derivePath(derivationPath);
  const pubkey = Buffer.from(node.publicKey);
  const address = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address;
  if (!address) throw new Error("Could not derive a regtest wallet address.");
  return { address, publicKey: pubkey.toString("hex"), addressType: "p2wpkh" };
}

type SignedPsbt = {
  psbtHex: string;
  psbtBase64: string;
  txHex?: string;
};

class DohmSigner {
  private readonly root: ReturnType<typeof bip32.fromSeed>;

  constructor(private readonly mnemonic: string, private readonly derivationPath: string) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error("Wallet contains an invalid recovery phrase.");
    this.root = bip32.fromSeed(bip39.mnemonicToSeedSync(mnemonic), NETWORK);
  }

  exportMnemonic(): string {
    return this.mnemonic;
  }

  async signPsbt(psbtBase64: string, options?: { finalize?: boolean; extractTx?: boolean }): Promise<SignedPsbt> {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: NETWORK });
    const node = this.root.derivePath(this.derivationPath);
    const keyPair = ECPair.fromPrivateKey(Buffer.from(node.privateKey!), { network: NETWORK });
    let signedInputs = 0;
    for (let index = 0; index < psbt.inputCount; index += 1) {
      try {
        psbt.signInput(index, keyPair);
        signedInputs += 1;
      } catch {
        // An input that does not belong to this wallet is left untouched.
      }
    }
    if (signedInputs !== psbt.inputCount) {
      throw new Error(`Signer could not sign all PSBT inputs (${signedInputs}/${psbt.inputCount}).`);
    }
    if (options?.finalize !== false) psbt.finalizeAllInputs();
    const result: SignedPsbt = { psbtHex: psbt.toHex(), psbtBase64: psbt.toBase64() };
    if (options?.extractTx && options?.finalize !== false) result.txHex = psbt.extractTransaction().toHex();
    return result;
  }
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

async function loadWalletAt(index: number): Promise<{ signer: DohmSigner; info: WalletInfo }> {
  const wallets = await readWalletCollection();
  const info = wallets[index - 1];
  if (!info) {
    throw new Error(`Wallet index #${index} tidak tersedia. File berisi ${wallets.length} wallet.`);
  }
  if (info.network !== "regtest" || info.addressType !== "p2wpkh") {
    throw new Error("wallet.json is not a Dohm regtest P2WPKH wallet.");
  }
  const derivationPath = info.derivationPath ?? LEGACY_DERIVATION_PATH;
  const mnemonic = info.mnemonic
    ? info.mnemonic
    : (await KeystoreSigner.fromEncrypted(info.keystore!, requirePassword(), { network: "regtest", addressType: "p2wpkh" })).exportMnemonic();
  const signer = new DohmSigner(mnemonic, derivationPath);
  const account = deriveAccount(mnemonic, derivationPath);
  if (account.address !== info.address) {
    throw new Error("Wallet address does not match the recovery phrase.");
  }
  return { signer, info };
}

async function loadWallet(): Promise<{ signer: DohmSigner; info: WalletInfo }> {
  return loadWalletAt(selectedWalletIndex());
}

function parseWalletCount(raw: string | undefined): number {
  const count = Number(raw ?? "1");
  if (!Number.isInteger(count) || count < 1 || count > MAX_WALLET_BATCH) {
    throw new Error(`Jumlah wallet harus bilangan bulat 1-${MAX_WALLET_BATCH}.`);
  }
  return count;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}

function isWalletInfo(value: unknown): value is WalletInfo {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WalletInfo>;
  return item.network === "regtest"
    && item.addressType === "p2wpkh"
    && (typeof item.mnemonic === "string" || typeof item.keystore === "string")
    && typeof item.address === "string"
    && typeof item.publicKey === "string"
    && typeof item.createdAt === "string";
}

async function readWalletCollection(): Promise<WalletInfo[]> {
  const content = await fs.readFile(WALLET_FILE, "utf8");
  if (!content.trim()) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${WALLET_FILE} berisi JSON tidak valid atau belum lengkap. Pulihkan dari backup wallet sebelum melanjutkan.`);
  }
  if (isWalletInfo(raw)) return [raw];
  if (
    raw && typeof raw === "object"
    && (raw as Partial<WalletStore>).version === 1
    && Array.isArray((raw as Partial<WalletStore>).wallets)
    && (raw as Partial<WalletStore>).wallets!.every(isWalletInfo)
  ) {
    return (raw as WalletStore).wallets;
  }
  throw new Error(`${WALLET_FILE} bukan wallet Dohm yang valid.`);
}

async function readWalletCollectionOrEmpty(): Promise<WalletInfo[]> {
  return (await fileExists(WALLET_FILE)) ? readWalletCollection() : [];
}

async function writeWalletCollection(wallets: WalletInfo[]): Promise<void> {
  const store: WalletStore = { version: 1, wallets };
  await writePrivateJson(WALLET_FILE, store);
}

function selectedWalletIndex(): number {
  const raw = process.env.DOHM_WALLET_INDEX ?? arg("wallet-index", "1");
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error("DOHM_WALLET_INDEX/--wallet-index harus bilangan bulat mulai dari 1.");
  }
  return index;
}

async function createWallet(count = 1): Promise<void> {
  const existingWallets = await readWalletCollectionOrEmpty();
  const wallets = [...existingWallets];
  let saved = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      const signer = KeystoreSigner.generate({ network: "regtest", addressType: "p2wpkh" }, 12);
      const mnemonic = signer.exportMnemonic();
      const account = deriveAccount(mnemonic, DOHM_DERIVATION_PATH);
      const info: WalletInfo = {
        mnemonic,
        network: "regtest",
        address: account.address,
        publicKey: account.publicKey,
        addressType: "p2wpkh",
        derivationPath: DOHM_DERIVATION_PATH,
        createdAt: new Date().toISOString(),
      };
      wallets.push(info);
      saved += 1;
      console.log(`\x1b[32m[✓] Wallet baru ${index + 1}/${count} dibuat | index #${wallets.length}\x1b[0m`);
      console.log(`[i] Address: ${account.address}`);
    } catch (error) {
      console.log(`\x1b[31m[✗] Wallet ${index + 1}/${count} gagal: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    }
  }
  if (saved > 0) await writeWalletCollection(wallets);
  console.log(`[i] Selesai membuat wallet: ${saved}/${count}`);
  console.log(`[i] Total wallet tersimpan dalam ${WALLET_FILE}: ${wallets.length}`);
  console.log(`[!] Recovery phrase tersimpan plaintext di ${WALLET_FILE} untuk kebutuhan import testnet. Jangan upload file ini.`);
}

async function listWallets(): Promise<void> {
  const wallets = await readWalletCollection();
  const active = selectedWalletIndex();
  console.log(`\n[i] Wallet store: ${WALLET_FILE}`);
  for (const [index, wallet] of wallets.entries()) {
    const marker = index + 1 === active ? " (active)" : "";
    console.log(`[#${index + 1}]${marker} ${wallet.address} | created ${wallet.createdAt}`);
  }
  console.log(`[i] Total wallet: ${wallets.length}`);
}

async function migrateWalletStore(): Promise<void> {
  const wallets = await readWalletCollection();
  const encryptedWallets = wallets.filter((wallet) => !wallet.mnemonic);
  const password = encryptedWallets.length > 0 ? requirePassword() : undefined;
  const normalized: WalletInfo[] = [];
  for (const wallet of wallets) {
    if (wallet.mnemonic) {
      normalized.push(wallet);
      continue;
    }
    const signer = await KeystoreSigner.fromEncrypted(wallet.keystore!, password!, { network: "regtest", addressType: "p2wpkh" });
    normalized.push({ ...wallet, mnemonic: signer.exportMnemonic(), keystore: undefined });
  }
  await writeWalletCollection(normalized);
  console.log(`[✓] Wallet store dinormalisasi ke format plaintext: ${WALLET_FILE}`);
  console.log(`[i] Total wallet: ${normalized.length} | Dikonversi: ${encryptedWallets.length}`);
}

async function backupWallet(): Promise<void> {
  const index = selectedWalletIndex();
  const { signer, info } = await loadWallet();
  console.log("\n\x1b[33m[!] Recovery phrase adalah kunci penuh wallet. Jangan kirim atau upload ke siapa pun.\x1b[0m");
  console.log(`[i] Wallet index: ${index}`);
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

async function getBondMarkets(): Promise<BondMarket[]> {
  const response = await fetch(`${BACKEND.replace(/\/$/, "")}/markets`);
  if (!response.ok) throw new Error(`markets HTTP ${response.status}`);
  const raw = await response.json() as { data?: BondMarket[] };
  if (!Array.isArray(raw.data)) throw new Error("Response markets Dohm tidak valid.");
  return raw.data;
}

async function resolveBondMarket(cfg: Config, assetName: "DIESEL" | "FIRE"): Promise<BondMarket> {
  const reserveId = cfg.ids[assetName];
  const markets = await getBondMarkets();
  const market = markets
    .filter((item) => !item.isLp && item.reserveId === reserveId)
    .find((item) => BigInt(item.capacity) > 0n);
  if (!market) throw new Error(`Market bond ${assetName} tidak tersedia atau sudah sold out.`);
  return market;
}

async function getBondAttestation(marketId: number): Promise<bigint[]> {
  const response = await fetch(`${BACKEND.replace(/\/$/, "")}/bond/attest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId }),
  });
  const body = await response.json().catch(() => ({})) as { attestation?: Array<string | number> };
  if (!response.ok || !Array.isArray(body.attestation)) {
    throw new Error(`bond attestation HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const attestation = body.attestation.map((value) => BigInt(value));
  if (attestation.length !== 11) throw new Error("Bond attestation tidak berisi 11 u128 words.");
  return attestation;
}

function reverseTxid(txid: string): string {
  return txid.match(/../g)!.reverse().join("");
}

async function walletUtxos(address: string): Promise<Utxo[]> {
  let response: Response | undefined;
  let lastStatus = "unknown";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(`${ESPLORA_URL.replace(/\/$/, "")}/address/${address}/utxo`);
    if (response.ok) break;
    lastStatus = String(response.status);
    if (![502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`UTXO HTTP ${response.status}`);
    }
    await delay(attempt * 1000);
  }
  if (!response?.ok) throw new Error(`UTXO HTTP ${lastStatus}`);
  const raw = (await response.json()) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_hash?: string } }>;
  const confirmed = raw.filter((u) => u.status?.confirmed);
  // Public Dohm RPC tidak mengizinkan sandshrew_multicall. Gunakan endpoint
  // per-outpoint yang didukung publik agar status, fee selection, dan settle
  // polling tetap bisa berjalan.
  const assets: unknown[] = [];
  for (const u of confirmed) {
    assets.push(await rpc<unknown>("alkanes_protorunesbyoutpoint", [{
      txid: reverseTxid(u.txid),
      vout: u.vout,
      protocolTag: "1",
    }]));
  }
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

async function prepareBond(account: WalletInfo, cfg: Config, amount: bigint, marketId: number, reserveId: string, attestation: bigint[]): Promise<PreparedTx> {
  if (attestation.length !== 11) throw new Error("Bond attestation tidak berisi 11 u128 words.");
  const utxos = await walletUtxos(account.address);
  const picked = chooseAsset(utxos, reserveId, amount);
  const fee = feeUtxo(utxos, picked.selected);
  const script = protostone(cell(id(cfg.ids.bonds), 15, [BigInt(marketId), amount, 0n, BigInt(attestation.length), ...attestation]), assetEdict(id(reserveId), picked.carried));
  return buildPsbt(account, [...picked.selected, fee], script, 1, "bond-signed");
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

async function prepareSwap(account: WalletInfo, cfg: Config, amount: bigint, tokenInName: string, tokenOutName: string, minOut = 0n): Promise<PreparedTx> {
  tokenInName = normalizeAssetName(tokenInName);
  tokenOutName = normalizeAssetName(tokenOutName);
  const tokenIn = id(cfg.ids[tokenInName]);
  const tokenOut = id(cfg.ids[tokenOutName]);
  const args = [2n, tokenIn.block, tokenIn.tx, tokenOut.block, tokenOut.tx, amount, minOut, 10000000000n];
  const script = protostone(cell(id(cfg.ids.ammRouter), 13, args), assetEdict(tokenIn, amount));
  return prepareAssetTx(account, key(tokenIn), amount, script, `swap:${tokenInName}->${tokenOutName}`);
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
  const otherAssets = new Map<string, bigint>();
  for (const utxo of picked.selected) {
    for (const [asset, assetAmount] of Object.entries(utxo.alkanes)) {
      if (asset !== key(pool) && assetAmount > 0n) otherAssets.set(asset, (otherAssets.get(asset) ?? 0n) + assetAmount);
    }
  }
  const carriedEdicts = [...otherAssets.entries()].flatMap(([asset, assetAmount]) => assetEdict(id(asset), assetAmount, 1));
  const script = protostone(cell(id(cfg.ids.ammRouter), 12, args), [...assetEdict(pool, picked.carried, 1), ...carriedEdicts]);
  return buildPsbt(account, [...picked.selected, fee], script, 2, "remove-liquidity");
}

async function prepareFrbtcMint(account: WalletInfo, cfg: Config, attestation: bigint[]): Promise<PreparedTx> {
  const utxos = await walletUtxos(account.address);
  const fee = feeUtxo(utxos, []);
  const script = protostone(cell(id(cfg.ids.frBTC), 78, [BigInt(attestation.length), ...attestation]));
  return buildPsbt(account, [fee], script, 1, "frBTC-mint");
}

async function signAndBroadcast(prepared: PreparedTx, signer: DohmSigner): Promise<string> {
  console.log(`[~] ${prepared.action} | signing and broadcasting...`);
  const signed = await signer.signPsbt(prepared.psbtBase64, { finalize: true, extractTx: true });
  if (!signed.txHex) throw new Error("Signer did not return an extracted transaction.");
  const txid = await rpc<string>("btc_sendrawtransaction", [signed.txHex]);
  console.log(`\x1b[32m[✓] Broadcast: ${txid}\x1b[0m`);
  return txid;
}

async function faucet(address: string, kind: "btc" | "frbtc", info?: WalletInfo, cfg?: Config, signer?: DohmSigner): Promise<void> {
  if (!DEV_API_URL) throw new Error("DOHM_DEV_API_URL tidak valid. Isi dengan URL proxy faucet Dohm, contoh: https://dohmapi-next.localtests.xyz/dev-api");
  const endpoint = kind === "btc" ? "/api/faucet-btc" : "/api/frbtc/attest";
  const response = await fetch(`${DEV_API_URL.replace(/\/$/, "")}${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "btc" ? { address } : {}) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 429) {
    throw new Error(`${kind} faucet cooldown${body.remainingSeconds ? `: tunggu ${body.remainingSeconds} detik` : ""}.`);
  }
  if (response.status === 503) {
    throw new Error(`${kind} faucet sedang kehabisan dana${body.retryAfterSeconds ? `: coba lagi dalam ${body.retryAfterSeconds} detik` : "."}`);
  }
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

async function claimMaturedForWallet(info: WalletInfo, cfg: Config, signer: DohmSigner): Promise<void> {
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

async function claimMatured(): Promise<void> {
  const { signer, info } = await loadWallet();
  const cfg = await getConfig();
  return claimMaturedForWallet(info, cfg, signer);
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

function percentageAmount(balance: bigint, envName: string, fallback: string, override?: string): bigint {
  if (balance <= 0n) throw new Error(`Saldo kosong untuk menghitung ${envName}.`);
  const raw = override ?? process.env[envName] ?? fallback;
  const percentage = Number(raw);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error(`${envName} harus berupa persentase lebih dari 0 sampai 100.`);
  }
  const basisPoints = BigInt(Math.round(percentage * 100));
  const amount = balance * basisPoints / 10000n;
  if (amount <= 0n) throw new Error(`${envName} menghasilkan nominal 0 dari saldo ${balance}.`);
  return amount;
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
  console.log("[A] List Wallets");
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

async function assetBalance(address: string, asset: string): Promise<bigint> {
  const utxos = await walletUtxos(address);
  return utxos.reduce((sum, utxo) => sum + (utxo.alkanes[asset] ?? 0n), 0n);
}

async function waitForAssetBalance(address: string, asset: string, minimum: bigint, timeoutMs = SETTLE_TIMEOUT_MS): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await assetBalance(address, asset);
    if (balance >= minimum) return balance;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Asset ${asset} belum terindeks setelah ${Math.floor(timeoutMs / 1000)} detik.`);
}

async function waitForAssetIncrease(address: string, asset: string, previous: bigint, timeoutMs = SETTLE_TIMEOUT_MS): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await assetBalance(address, asset);
    if (balance > previous) return balance;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Settle ${asset} belum selesai setelah ${Math.floor(timeoutMs / 1000)} detik.`);
}

async function waitForAssetDecrease(address: string, asset: string, previous: bigint, timeoutMs = SETTLE_TIMEOUT_MS): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await assetBalance(address, asset);
    if (balance < previous) return balance;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Perubahan saldo ${asset} belum terindeks setelah ${Math.floor(timeoutMs / 1000)} detik.`);
}

async function waitForBtcUtxo(address: string, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await walletUtxos(address);
    if (utxos.some((utxo) => Object.values(utxo.alkanes).every((value) => value === 0n) && utxo.sats > DUST)) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("BTC faucet belum menghasilkan UTXO fee yang terkonfirmasi.");
}

async function runStakeUnstake(info: WalletInfo, cfg: Config, signer: DohmSigner, results: StepResult[]): Promise<boolean> {
  const dohmBalance = await assetBalance(info.address, cfg.ids.DOHM);
  const amount = percentageAmount(dohmBalance, "DOHM_STAKE_PERCENT", "25");
  console.log(`[i] Stake ${process.env.DOHM_STAKE_PERCENT ?? "25"}% dari saldo DOHM ${dohmBalance} = ${amount}`);
  const beforeStake = await assetBalance(info.address, cfg.ids.sDOHM);
  const staked = await runStep(results, `Stake ${amount}`, async () => {
    const prepared = await prepareStake(info, cfg, amount, false);
    await signAndBroadcast(prepared, signer);
  });
  if (!staked) return false;
  const stakeSettled = await runStep(results, "Wait for stake settle", async () => {
    await waitForAssetIncrease(info.address, cfg.ids.sDOHM, beforeStake);
  });
  if (!stakeSettled) return false;
  const beforeUnstake = await assetBalance(info.address, cfg.ids.sDOHM);
  const unstakeAmount = percentageAmount(beforeUnstake, "DOHM_STAKE_PERCENT", "25");
  console.log(`[i] Unstake ${process.env.DOHM_STAKE_PERCENT ?? "25"}% dari saldo sDOHM ${beforeUnstake} = ${unstakeAmount}`);
  const unstaked = await runStep(results, `Unstake ${unstakeAmount}`, async () => {
    const prepared = await prepareStake(info, cfg, unstakeAmount, true);
    await signAndBroadcast(prepared, signer);
  });
  if (!unstaked) return false;
  return runStep(results, "Wait for unstake settle", async () => {
    await waitForAssetDecrease(info.address, cfg.ids.sDOHM, beforeUnstake);
  });
}

async function runLiquidityCycle(info: WalletInfo, cfg: Config, signer: DohmSigner, results: StepResult[]): Promise<void> {
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

function configuredAmount(name: string, fallback: string): bigint {
  return amountEnv(name, fallback);
}

function ensureBalance(balance: bigint, required: bigint, assetName: string): void {
  if (balance < required) throw new Error(`Saldo ${assetName} tidak cukup: perlu ${required}, tersedia ${balance}.`);
}

async function waitForNewBondNote(address: string, previous: Set<string>, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await walletUtxos(address);
    const newOrbital = current.flatMap((utxo) => Object.keys(utxo.alkanes).filter((asset) => asset.startsWith("2:") && !previous.has(asset)));
    if (newOrbital.length > 0) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Bond belum settle setelah ${Math.floor(timeoutMs / 1000)} detik.`);
}

async function runFaucetCycle(info: WalletInfo, cfg: Config, signer: DohmSigner, results: StepResult[]): Promise<boolean> {
  const btcRequested = await runStep(results, "BTC faucet", async () => faucet(info.address, "btc"));
  const btcReady = await runStep(results, "Wait for confirmed BTC fee UTXO", async () => {
    if (!btcRequested) {
      const existing = await walletUtxos(info.address);
      const hasFeeUtxo = existing.some((utxo) => Object.values(utxo.alkanes).every((value) => value === 0n) && utxo.sats > DUST);
      if (!hasFeeUtxo) throw new Error("BTC faucet tidak berhasil dan wallet belum memiliki UTXO fee yang dapat dipakai.");
      console.log("[i] BTC faucet cooldown/error; memakai UTXO fee yang sudah ada.");
      return;
    }
    await waitForBtcUtxo(info.address);
  });
  if (!btcReady) return false;

  const previousFrbtc = await assetBalance(info.address, cfg.ids.frBTC);
  const frbtcRequested = await runStep(results, "frBTC faucet and mint", async () => faucet(info.address, "frbtc", info, cfg, signer));
  const frbtcReady = await runStep(results, "Wait for frBTC faucet settle", async () => {
    const current = await assetBalance(info.address, cfg.ids.frBTC);
    if (current > previousFrbtc) return;
    if (!frbtcRequested && current > 0n) return;
    if (!frbtcRequested) throw new Error("frBTC faucet gagal dan saldo frBTC belum mencukupi.");
    await waitForAssetIncrease(info.address, cfg.ids.frBTC, previousFrbtc);
  });
  return frbtcReady;
}

async function runFullAuto(info: WalletInfo, cfg: Config, signer: DohmSigner, accountIndex: number): Promise<void> {
  const results: StepResult[] = [];
  console.log(`\n\x1b[36m>>> Memulai workflow akun #${accountIndex}: ${info.address}\x1b[0m`);
  if (!await runFaucetCycle(info, cfg, signer, results)) {
    printSummary(results);
    return;
  }

  const frbtcBalance = await assetBalance(info.address, cfg.ids.frBTC);
  const frbtcSwapAmount = percentageAmount(frbtcBalance, "DOHM_FRBTC_SWAP_PERCENT", "50");
  console.log(`[i] Swap frBTC ${process.env.DOHM_FRBTC_SWAP_PERCENT ?? "50"}% dari saldo ${frbtcBalance} = ${frbtcSwapAmount}`);
  const previousDohm = await assetBalance(info.address, cfg.ids.DOHM);
  const frbtcSwap = await runStep(results, `Swap frBTC -> DOHM (${frbtcSwapAmount})`, async () => {
    const prepared = await prepareSwap(info, cfg, frbtcSwapAmount, "frBTC", "DOHM");
    await signAndBroadcast(prepared, signer);
  });
  if (!frbtcSwap) {
    printSummary(results);
    return;
  }
  if (!await runStep(results, "Wait for frBTC -> DOHM settle", async () => { await waitForAssetIncrease(info.address, cfg.ids.DOHM, previousDohm); })) {
    printSummary(results);
    return;
  }

  const bondAsset = (process.env.DOHM_BOND_ASSET ?? "DIESEL").toUpperCase();
  if (bondAsset !== "DIESEL" && bondAsset !== "FIRE") throw new Error("DOHM_BOND_ASSET hanya boleh DIESEL atau FIRE.");
  const dohmBalance = await assetBalance(info.address, cfg.ids.DOHM);
  const reserveSwapAmount = percentageAmount(dohmBalance, "DOHM_DOHM_SWAP_PERCENT", "50");
  console.log(`[i] Swap DOHM ${process.env.DOHM_DOHM_SWAP_PERCENT ?? "50"}% dari saldo ${dohmBalance} = ${reserveSwapAmount}`);
  const previousReserve = await assetBalance(info.address, cfg.ids[bondAsset]);
  const reserveSwap = await runStep(results, `Swap DOHM -> ${bondAsset} (${reserveSwapAmount})`, async () => {
    const prepared = await prepareSwap(info, cfg, reserveSwapAmount, "DOHM", bondAsset);
    await signAndBroadcast(prepared, signer);
  });
  if (!reserveSwap) {
    printSummary(results);
    return;
  }
  if (!await runStep(results, `Wait for DOHM -> ${bondAsset} settle`, async () => { await waitForAssetIncrease(info.address, cfg.ids[bondAsset], previousReserve); })) {
    printSummary(results);
    return;
  }

  const market = await resolveBondMarket(cfg, bondAsset);
  const attestation = await getBondAttestation(market.id);
  const reserveBalance = await assetBalance(info.address, cfg.ids[bondAsset]);
  const bondAmount = configuredAmount("DOHM_DEFAULT_BOND_AMOUNT", process.env.DOHM_DEFAULT_BOND_SATS ?? "10000");
  ensureBalance(reserveBalance, bondAmount, bondAsset);
  const beforeBond = new Set((await walletUtxos(info.address)).flatMap((utxo) => Object.keys(utxo.alkanes).filter((asset) => asset.startsWith("2:"))));
  const bonded = await runStep(results, `Bond ${bondAsset} market #${market.id}`, async () => {
    const prepared = await prepareBond(info, cfg, bondAmount, market.id, cfg.ids[bondAsset], attestation);
    await signAndBroadcast(prepared, signer);
  });
  if (!bonded) {
    printSummary(results);
    return;
  }
  if (!await runStep(results, "Wait for bond settle", async () => { await waitForNewBondNote(info.address, beforeBond); })) {
    printSummary(results);
    return;
  }

  if (!await runStakeUnstake(info, cfg, signer, results)) {
    printSummary(results);
    return;
  }
  await runLiquidityCycle(info, cfg, signer, results);
  await runStep(results, "Claim matured bonds", async () => claimMaturedForWallet(info, cfg, signer));
  printSummary(results);
}

async function runAllWalletFaucets(): Promise<void> {
  const wallets = await readWalletCollection();
  const cfg = await getConfig();
  for (let index = 1; index <= wallets.length; index += 1) {
    const results: StepResult[] = [];
    try {
      const { signer, info } = await loadWalletAt(index);
      console.log(`\n\x1b[36m>>> Faucet akun #${index}/${wallets.length}: ${info.address}\x1b[0m`);
      await runFaucetCycle(info, cfg, signer, results);
    } catch (error) {
      results.push({ label: "Wallet faucet", success: false });
      console.log(`\x1b[31m[✗] Akun #${index} gagal: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    }
    printSummary(results);
    if (index < wallets.length) await delay(Number(process.env.DOHM_ACCOUNT_DELAY_MS ?? "2000"));
  }
}

async function runFullAutoAllWallets(): Promise<void> {
  const wallets = await readWalletCollection();
  const cfg = await getConfig();
  for (let index = 1; index <= wallets.length; index += 1) {
    try {
      const { signer, info } = await loadWalletAt(index);
      await runFullAuto(info, cfg, signer, index);
    } catch (error) {
      console.log(`\x1b[31m[✗] Akun #${index} dihentikan: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    }
    if (index < wallets.length) {
      console.log(`\x1b[33m[~] Menunggu sebelum akun #${index + 1}...\x1b[0m`);
      await delay(Number(process.env.DOHM_ACCOUNT_DELAY_MS ?? "2000"));
    }
  }
}

async function interactiveMenu(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      printMenu();
      const choice = await askLine(rl, "Select option");
      if (choice === "0") return;
      if (choice === "1") {
        try {
          const count = parseWalletCount(await askLine(rl, `Jumlah wallet (1-${MAX_WALLET_BATCH})`, "1"));
          await createWallet(count);
        } catch (error) { console.log(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
        continue;
      }
      if (choice === "9") {
        try { await runFullAutoAllWallets(); } catch (error) { console.log(`\x1b[31m[✗] Full Auto gagal: ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
        continue;
      }
      if (choice === "2") {
        try { await runAllWalletFaucets(); } catch (error) { console.log(`\x1b[31m[✗] Faucet semua wallet gagal: ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
        continue;
      }
      if (choice.toLowerCase() === "a") {
        try { await listWallets(); } catch (error) { console.log(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); }
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
        case "3":
          await runStep(results, "Bonding", async () => {
            const bondAsset = (process.env.DOHM_BOND_ASSET ?? "DIESEL").toUpperCase();
            if (bondAsset !== "DIESEL" && bondAsset !== "FIRE") throw new Error("DOHM_BOND_ASSET hanya boleh DIESEL atau FIRE.");
            const market = await resolveBondMarket(cfg, bondAsset);
            const attestation = await getBondAttestation(market.id);
            const amount = configuredAmount("DOHM_DEFAULT_BOND_AMOUNT", process.env.DOHM_DEFAULT_BOND_SATS ?? "10000");
            const prepared = await prepareBond(info, cfg, amount, market.id, cfg.ids[bondAsset], attestation);
            await signAndBroadcast(prepared, signer);
          });
          break;
        case "4": await runStep(results, "Claim matured bonds", async () => claimMatured()); break;
        case "5":
          await runStep(results, "Swap", async () => {
            const direction = process.env.DOHM_SWAP_DIRECTION ?? "frbtc-to-dohm";
            const [rawTokenIn, rawTokenOut] = direction.split("-to-");
            const tokenIn = rawTokenIn ? normalizeAssetName(rawTokenIn) : "";
            const tokenOut = rawTokenOut ? normalizeAssetName(rawTokenOut) : "";
            if (!tokenIn || !tokenOut || !cfg.ids[tokenIn] || !cfg.ids[tokenOut]) throw new Error("DOHM_SWAP_DIRECTION contoh: frbtc-to-dohm atau dohm-to-frbtc.");
            const balance = await assetBalance(info.address, cfg.ids[tokenIn]);
            const amount = percentageAmount(balance, "DOHM_SWAP_PERCENT", "25");
            console.log(`[i] Swap ${tokenIn} ${process.env.DOHM_SWAP_PERCENT ?? "25"}% dari saldo ${balance} = ${amount}`);
            const prepared = await prepareSwap(info, cfg, amount, tokenIn, tokenOut);
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
  if (command === "wallet" && subcommand === "create") return createWallet(parseWalletCount(arg("count")));
  if (command === "wallet" && subcommand === "list") return listWallets();
  if (command === "wallet" && subcommand === "migrate") return migrateWalletStore();
  if (command === "wallet" && subcommand === "backup") return backupWallet();
  if (command === "full-auto") return runFullAutoAllWallets();
  if (command === "faucet") {
    if (subcommand !== "btc" && subcommand !== "frbtc") {
      throw new Error("Usage: npm start -- faucet btc | npm start -- faucet frbtc");
    }
    const { signer, info } = await loadWallet();
    const cfg = subcommand === "frbtc" ? await getConfig() : undefined;
    return faucet(info.address, subcommand, info, cfg, signer);
  }
  if (command === "status") return status();
  const { signer, info } = await loadWallet();
  const cfg = await getConfig();
  const amount = BigInt(arg("amount", "0")!);
  const amountArg = arg("amount");
  let prepared: PreparedTx;
  switch (command) {
    case "bond": {
      const bondAsset = (process.env.DOHM_BOND_ASSET ?? "DIESEL").toUpperCase();
      if (bondAsset !== "DIESEL" && bondAsset !== "FIRE") throw new Error("DOHM_BOND_ASSET hanya boleh DIESEL atau FIRE.");
      const market = await resolveBondMarket(cfg, bondAsset);
      const attestation = await getBondAttestation(market.id);
      prepared = await prepareBond(info, cfg, amount || BigInt(process.env.DOHM_DEFAULT_BOND_AMOUNT ?? process.env.DOHM_DEFAULT_BOND_SATS ?? "10000"), market.id, cfg.ids[bondAsset], attestation);
      break;
    }
    case "swap": {
      const direction = arg("direction", "frbtc-to-dohm")!;
      const [rawTokenIn, rawTokenOut] = direction.split("-to-");
      const tokenIn = rawTokenIn ? normalizeAssetName(rawTokenIn) : "";
      const tokenOut = rawTokenOut ? normalizeAssetName(rawTokenOut) : "";
      if (!tokenIn || !tokenOut || !cfg.ids[tokenIn] || !cfg.ids[tokenOut]) throw new Error("direction contoh: frbtc-to-dohm atau dohm-to-fire.");
      const balance = await assetBalance(info.address, cfg.ids[tokenIn]);
      const swapAmount = amountArg === undefined
        ? percentageAmount(balance, "DOHM_SWAP_PERCENT", "25", arg("percent"))
        : amount;
      console.log(`[i] Swap ${tokenIn} ${amountArg === undefined ? `${arg("percent", process.env.DOHM_SWAP_PERCENT ?? "25")}%` : "nominal manual"} dari saldo ${balance} = ${swapAmount}`);
      prepared = await prepareSwap(info, cfg, swapAmount, tokenIn, tokenOut, BigInt(arg("min-out", "0")!));
      break;
    }
    case "stake": {
      const balance = await assetBalance(info.address, cfg.ids.DOHM);
      const stakeAmount = amountArg === undefined
        ? percentageAmount(balance, "DOHM_STAKE_PERCENT", "25", arg("percent"))
        : amount;
      console.log(`[i] Stake ${amountArg === undefined ? `${arg("percent", process.env.DOHM_STAKE_PERCENT ?? "25")}%` : "nominal manual"} dari saldo DOHM ${balance} = ${stakeAmount}`);
      prepared = await prepareStake(info, cfg, stakeAmount, false);
      break;
    }
    case "unstake": {
      const balance = await assetBalance(info.address, cfg.ids.sDOHM);
      const unstakeAmount = amountArg === undefined
        ? percentageAmount(balance, "DOHM_STAKE_PERCENT", "25", arg("percent"))
        : amount;
      console.log(`[i] Unstake ${amountArg === undefined ? `${arg("percent", process.env.DOHM_STAKE_PERCENT ?? "25")}%` : "nominal manual"} dari saldo sDOHM ${balance} = ${unstakeAmount}`);
      prepared = await prepareStake(info, cfg, unstakeAmount, true);
      break;
    }
    case "add-liquidity": prepared = await prepareAddLiquidity(info, cfg, BigInt(arg("dohm", "0")!), BigInt(arg("frbtc", "0")!), BigInt(arg("min-dohm", "0")!), BigInt(arg("min-frbtc", "0")!)); break;
    case "remove-liquidity": prepared = await prepareRemoveLiquidity(info, cfg, amount, BigInt(arg("min-dohm", "0")!), BigInt(arg("min-frbtc", "0")!)); break;
    case "claim-matured": return claimMatured();
    default: throw new Error("Unknown command. See README.md for commands.");
  }
  await signAndBroadcast(prepared, signer);
}

main().catch((error) => { console.error(`\x1b[31m[✗] ${error instanceof Error ? error.message : String(error)}\x1b[0m`); process.exitCode = 1; });
