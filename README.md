# Dohm Testnet Activity

link projek : https://testnet.dohm.finance/app/link

Script TypeScript untuk aktivitas satu wallet di Dohm Testnet/Bitcoin Regtest: membuat wallet terenkripsi, meminta BTC/frBTC faucet, bonding, claim bond matang, swap, stake/unstake, serta add/remove liquidity.

## Setup

```powershell
npm install
Copy-Item .env.example .env
# isi DOHM_WALLET_PASSWORD dengan password kuat
```

Jalankan menu interaktif:

```powershell
npm start
```

Menu menyediakan satu-run workflow seperti:

```text
[1] Create Wallet and Save Wallet
[2] Faucet BTC + frBTC
[3] Bonding
[4] Claim Matured Bonds
[5] Try Feature Swap
[6] Stake and Unstake
[7] Add Liquidity and Remove Liquidity
[8] Wallet Status
[9] Full Auto (All Actions)
[0] Exit
```

Untuk setup aset secara langsung:

```powershell
npm start -- faucet btc
npm start -- faucet frbtc
npm start -- status
```

Perintah CLI langsung juga tersedia dan langsung menandatangani serta broadcast transaksi:

```powershell
npm start -- bond --amount=10000
npm start -- swap --direction=dohm-to-frbtc --amount=1000000
npm start -- claim-matured
```

Jumlah default workflow diatur melalui `.env`. Pilihan `Full Auto` menjalankan faucet, bonding, swap, stake/unstake, add/remove liquidity, dan claim matured secara sequential.

`wallet.json` berisi keystore terenkripsi dan sengaja masuk `.gitignore`. Script tidak menyimpan atau mencetak mnemonic; simpan backup wallet secara offline. Jangan gunakan private key mainnet.

## Catatan

- Dohm menggunakan Bitcoin Regtest + ALKANES, bukan EVM/RPC Ethereum.
- Endpoint dan asset ID diambil dinamis dari endpoint konfigurasi Dohm.
- Satu wallet diproses sequentially; tidak ada proxy rotation, stealth header, atau mass-account mode.
- Waktu vesting/cooldown mengikuti tinggi block testnet; claim hanya dijalankan saat bond sudah matang.
- Semua aksi adalah transaksi nyata di testnet dan dapat memerlukan waktu indexing antar langkah.

## Disclaimer

Untuk testnet dan edukasi. Transaksi tetap dapat gagal karena saldo, fee, perubahan kontrak, atau perubahan layanan testnet.

  *==========================================*
    > Built by: Noya-xen (Github)
    > Follow me on X : @xinomixo
  *==========================================*
