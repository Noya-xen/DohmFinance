# Dohm Testnet Activity

link projek : https://testnet.dohm.finance/app/link

Script TypeScript untuk aktivitas satu wallet di Dohm Testnet/Bitcoin Regtest: membuat wallet terenkripsi, meminta BTC/frBTC faucet, bonding, claim bond matang, swap, stake/unstake, serta add/remove liquidity.

## Setup

```powershell
npm install
Copy-Item .env.example .env
# isi DOHM_WALLET_PASSWORD dengan password kuat
```

Buat wallet baru:

```powershell
npm start -- wallet create
```

Siapkan aset testnet lalu cek saldo:

```powershell
npm start -- faucet btc --confirm
npm start -- faucet frbtc --confirm
npm start -- status
```

Faucet dan perintah transaksi selalu dry-run secara default. Tambahkan `--confirm` hanya setelah memeriksa hasilnya:

```powershell
npm start -- bond --amount=10000 --confirm
npm start -- swap --direction=dohm-to-frbtc --amount=1000000 --confirm
npm start -- stake --amount=1000000 --confirm
npm start -- unstake --amount=1000000 --confirm
npm start -- add-liquidity --dohm=1000000 --frbtc=1000000 --confirm
npm start -- remove-liquidity --amount=1000 --confirm
npm start -- claim-matured --confirm
```

`wallet.json` berisi keystore terenkripsi dan sengaja masuk `.gitignore`. Script tidak menyimpan atau mencetak mnemonic; simpan backup wallet secara offline. Jangan gunakan private key mainnet.

## Catatan

- Dohm menggunakan Bitcoin Regtest + ALKANES, bukan EVM/RPC Ethereum.
- Endpoint dan asset ID diambil dinamis dari endpoint konfigurasi Dohm.
- Satu wallet diproses sequentially; tidak ada proxy rotation, stealth header, atau mass-account mode.
- Waktu vesting/cooldown mengikuti tinggi block testnet; jalankan `claim-matured` setelah bond/unstake matang.

## Disclaimer

Untuk testnet dan edukasi. Transaksi tetap dapat gagal karena saldo, fee, perubahan kontrak, atau perubahan layanan testnet.

  *==========================================*
    > Built by: Noya-xen (Github)
    > Follow me on X : @xinomixo
  *==========================================*
