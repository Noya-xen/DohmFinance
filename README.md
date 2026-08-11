# Dohm Testnet Activity

link projek : https://testnet.dohm.finance/app/link

Script TypeScript untuk aktivitas wallet aktif di Dohm Testnet/Bitcoin Regtest: membuat wallet testnet dengan recovery phrase plaintext, meminta BTC/frBTC faucet, bonding, claim bond matang, swap, stake/unstake, serta add/remove liquidity.

## Setup

```powershell
npm install
Copy-Item .env.example .env
# DOHM_WALLET_PASSWORD hanya diperlukan untuk wallet lama yang masih terenkripsi
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

Pilih `[1] Create Wallet and Save Wallet`, lalu masukkan jumlah wallet yang ingin dibuat. Semua wallet disimpan dalam satu file `wallet.json` dengan field `mnemonic` plaintext agar mudah diimpor ke website testnet. Script mengikuti derivation path Dohm `m/84'/0'/0'/0/0`, sehingga alamat `bcrt1q...` sama dengan website. Jika file sudah berisi wallet, wallet baru akan ditambahkan dan tidak menimpa wallet lama.

Pembuatan batch juga tersedia melalui CLI dan tidak memerlukan `DOHM_WALLET_PASSWORD` untuk wallet baru:

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

Menu dan perintah faucet juga hanya memakai satu wallet aktif dalam satu kali proses. Contoh untuk wallet #2:

```powershell
$env:DOHM_WALLET_INDEX = "2"
npm start -- faucet btc
# tunggu BTC terkonfirmasi, lalu jalankan:
npm start -- faucet frbtc
```

Faucet BTC dan frBTC tidak boleh dijalankan bersamaan: script akan menunggu UTXO BTC yang sudah terkonfirmasi sebelum mencoba mint frBTC.

Jika memiliki `wallet.json` lama dengan format satu wallet terenkripsi, script tetap bisa membacanya. Jalankan `npm start -- wallet migrate` untuk mengubahnya menjadi format plaintext; password lama hanya diperlukan satu kali saat migrasi.

Wallet lama yang dibuat sebelum penyesuaian derivation path tetap dibaca dengan path legacy `m/84'/1'/0'/0/0`. Untuk mendapatkan alamat yang sama dengan website, buat wallet baru setelah update lalu impor mnemonic baru tersebut ke website.

Jika `wallet.json` kosong, pilih menu `[1]` dan file akan diinisialisasi ulang dengan aman. Jika file berisi JSON rusak, jangan hapus sebelum memastikan ada backup karena file tersebut mungkin berisi wallet yang perlu dipulihkan.

Untuk mengimpor wallet script ke website Dohm, tampilkan recovery phrase secara lokal:

```powershell
npm start -- wallet backup
```

Atau pilih `[B] Backup Wallet Recovery Phrase` di menu. Salin 12 kata dari field `mnemonic` atau output backup ke kolom `Recovery phrase` pada form `Restore wallet`.

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

`wallet.json` berisi recovery phrase plaintext untuk kemudahan testnet dan sengaja masuk `.gitignore`. Jangan upload, commit, atau bagikan file ini. Jangan gunakan format plaintext ini untuk wallet mainnet.

## Catatan

- Dohm menggunakan Bitcoin Regtest + ALKANES, bukan EVM/RPC Ethereum.
- Endpoint dan asset ID diambil dinamis dari endpoint konfigurasi Dohm.
- Faucet mengikuti proxy deployment Dohm melalui `DOHM_DEV_API_URL` (default: `https://dohmapi-next.localtests.xyz/dev-api`), bukan endpoint backend `/api` secara langsung.
- Wallet diproses satu per satu berdasarkan active wallet index; tidak ada proxy rotation atau stealth header.
- Waktu vesting/cooldown mengikuti tinggi block testnet; claim hanya dijalankan saat bond sudah matang.
- Semua aksi adalah transaksi nyata di testnet dan dapat memerlukan waktu indexing antar langkah.

## Disclaimer

Untuk testnet dan edukasi. Transaksi tetap dapat gagal karena saldo, fee, perubahan kontrak, atau perubahan layanan testnet.

  *==========================================*
    > Built by: Noya-xen (Github)
    > Follow me on X : @xinomixo
  *==========================================*
