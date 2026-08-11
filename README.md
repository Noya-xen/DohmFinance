# Dohm Testnet Activity

link projek : https://testnet.dohm.finance/app/link

Script TypeScript untuk aktivitas wallet aktif di Dohm Testnet/Bitcoin Regtest: membuat wallet terenkripsi, meminta BTC/frBTC faucet, bonding, claim bond matang, swap, stake/unstake, serta add/remove liquidity.

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
[A] List Wallets
[B] Backup Wallet Recovery Phrase
[0] Exit
```

Pilih `[1] Create Wallet and Save Wallet`, lalu masukkan jumlah wallet yang ingin dibuat. Semua wallet disimpan dalam satu file `wallet.json` sebagai keystore terenkripsi. Jika file sudah berisi wallet, wallet baru akan ditambahkan dan tidak menimpa wallet lama.

Pembuatan batch juga tersedia melalui CLI:

```powershell
npm start -- wallet create --count=3
npm start -- wallet list
```

Untuk memakai wallet tertentu pada aksi lain, gunakan index wallet. Index default adalah `1`:

```powershell
$env:DOHM_WALLET_INDEX = "2"
npm start -- wallet backup
# atau: npm start -- wallet backup --wallet-index=2
```

Jika memiliki `wallet.json` lama dengan format satu wallet, script tetap bisa membacanya. Jalankan `npm start -- wallet migrate` untuk menormalisasikannya ke format satu file yang mendukung banyak wallet.

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
- Wallet diproses satu per satu berdasarkan active wallet index; tidak ada proxy rotation atau stealth header.
- Waktu vesting/cooldown mengikuti tinggi block testnet; claim hanya dijalankan saat bond sudah matang.
- Semua aksi adalah transaksi nyata di testnet dan dapat memerlukan waktu indexing antar langkah.

## Disclaimer

Untuk testnet dan edukasi. Transaksi tetap dapat gagal karena saldo, fee, perubahan kontrak, atau perubahan layanan testnet.

  *==========================================*
    > Built by: Noya-xen (Github)
    > Follow me on X : @xinomixo
  *==========================================*
