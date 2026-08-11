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
[B] Backup Wallet Recovery Phrase
[0] Exit
```

Untuk mengimpor wallet script ke website Dohm, tampilkan recovery phrase secara lokal:

```powershell
npm start -- wallet backup
```

Atau pilih `[B] Backup Wallet Recovery Phrase` di menu. Salin 12 kata tersebut ke kolom `Recovery phrase` pada form `Restore wallet`. Password website boleh berbeda dari `DOHM_WALLET_PASSWORD` karena keduanya hanya mengenkripsi wallet di tempat masing-masing.

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

`wallet.json` berisi keystore terenkripsi dan sengaja masuk `.gitignore`. Recovery phrase hanya ditampilkan melalui perintah backup yang eksplisit; simpan di password manager/catatan terenkripsi dan jangan gunakan private key mainnet.

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
