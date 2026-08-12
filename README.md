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
[2] Faucet BTC + frBTC untuk semua wallet secara serial
[3] Bonding
[4] Claim Matured Bonds
[5] Try Feature Swap
[6] Stake and Unstake
[7] Add Liquidity and Remove Liquidity
[8] Wallet Status
[9] Full Auto semua wallet secara serial
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

Pilihan `[2]` dan `[9]` memproses semua wallet dalam `wallet.json` satu per satu. Satu akun harus menyelesaikan langkahnya terlebih dahulu sebelum akun berikutnya dimulai; tidak ada proses paralel.

Urutan `[9] Full Auto` adalah:

```text
BTC faucet → tunggu BTC terkonfirmasi → frBTC faucet/mint → tunggu saldo
→ swap frBTC → DOHM → tunggu settle
→ swap DOHM → DIESEL/FIRE → tunggu settle
→ bond signed → tunggu bond settle → stake → tunggu → unstake → tunggu
→ add/remove liquidity → claim matured bond
```

Untuk memakai wallet tertentu pada aksi lain, gunakan index wallet. Index default adalah `1`:

```powershell
$env:DOHM_WALLET_INDEX = "2"
npm start -- wallet backup
# atau: npm start -- wallet backup --wallet-index=2
```

Perintah faucet langsung memakai satu wallet aktif. Contoh untuk wallet #2:

```powershell
$env:DOHM_WALLET_INDEX = "2"
npm start -- faucet btc
# tunggu BTC terkonfirmasi, lalu jalankan:
npm start -- faucet frbtc
```

Faucet BTC dan frBTC tidak dijalankan bersamaan: script menunggu UTXO BTC terkonfirmasi dan menunggu saldo frBTC terindeks sebelum melanjutkan.

Jika faucet BTC sedang cooldown tetapi wallet sudah memiliki UTXO fee terkonfirmasi, workflow akan memakai UTXO tersebut dan tidak mengulang klaim. Jika belum ada UTXO fee, akun dilewati sampai cooldown selesai. Pembacaan aset memakai pemanggilan `alkanes_protorunesbyoutpoint` per UTXO karena endpoint RPC publik Dohm tidak mengizinkan `sandshrew_multicall`; respons Esplora 502/503/504 juga dicoba ulang otomatis.

Konfigurasi workflow utama ada di `.env`: `DOHM_BOND_ASSET=DIESEL` atau `FIRE`, persentase swap/stake, `DOHM_DEFAULT_BOND_AMOUNT`, `DOHM_SETTLE_TIMEOUT_MS`, dan `DOHM_ACCOUNT_DELAY_MS`. Timeout settle default 15 menit karena status swap di website dapat berada pada tahap `SETTLING` beberapa menit.

Semua nominal swap dan stake pada menu serta Full Auto dihitung dari saldo aset yang terbaca tepat sebelum transaksi:

```env
# Swap manual/menu [5], atau CLI swap tanpa --amount
DOHM_SWAP_PERCENT=25

# Full Auto: frBTC -> DOHM, lalu DOHM -> DIESEL/FIRE
DOHM_FRBTC_SWAP_PERCENT=50
DOHM_DOHM_SWAP_PERCENT=50

# Menu [6] dan Full Auto stake/unstake
DOHM_STAKE_PERCENT=25
```

Persentase boleh memakai angka desimal sampai dua digit, harus lebih dari 0 dan maksimal 100. Untuk perintah CLI, `--percent=10` dapat dipakai sebagai override sekali jalan; `--amount=...` tetap tersedia sebagai override nominal eksplisit jika diperlukan.

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
npm start -- full-auto
```

Perintah CLI langsung juga tersedia dan langsung menandatangani serta broadcast transaksi:

```powershell
npm start -- bond --amount=10000
npm start -- swap --direction=frbtc-to-dohm
npm start -- swap --direction=dohm-to-fire --percent=25
npm start -- stake --percent=25
npm start -- unstake --percent=25
npm start -- claim-matured
```

Persentase swap/stake dan jumlah bond/liquidity diatur melalui `.env`. Bond single-asset mengikuti market aktif Dohm dan memakai attestation endpoint `/api/bond/attest`; market yang dipilih hanya DIESEL atau FIRE. Swap menunggu saldo output terindeks sebagai tanda settle sebelum langkah berikutnya.

`wallet.json` berisi recovery phrase plaintext untuk kemudahan testnet dan sengaja masuk `.gitignore`. Jangan upload, commit, atau bagikan file ini. Jangan gunakan format plaintext ini untuk wallet mainnet.

## Catatan

- Dohm menggunakan Bitcoin Regtest + ALKANES, bukan EVM/RPC Ethereum.
- Endpoint dan asset ID diambil dinamis dari endpoint konfigurasi Dohm.
- Faucet mengikuti proxy deployment Dohm melalui `DOHM_DEV_API_URL` (default: `https://dohmapi-next.localtests.xyz/dev-api`), bukan endpoint backend `/api` secara langsung.
- Menu Full Auto dan Faucet memproses semua wallet satu per satu; perintah CLI individual tetap memakai active wallet index. Tidak ada proxy rotation atau stealth header.
- Waktu vesting/cooldown mengikuti tinggi block testnet; claim hanya dijalankan saat bond sudah matang.
- Semua aksi adalah transaksi nyata di testnet dan dapat memerlukan waktu indexing antar langkah.

## Disclaimer

Untuk testnet dan edukasi. Transaksi tetap dapat gagal karena saldo, fee, perubahan kontrak, atau perubahan layanan testnet.

  *==========================================*
    > Built by: Noya-xen (Github)
    > Follow me on X : @xinomixo
  *==========================================*
