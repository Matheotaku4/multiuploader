# Upify

[![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D_18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](#)
[![Stars](https://img.shields.io/github/stars/Matheotaku4/Upify?color=gold)](https://github.com/Matheotaku4/Upify/stargazers)


> [!WARNING]  
> This app is vibe coded  

Local web app to upload one file to multiple hosts in parallel:

[![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?style=for-the-badge&color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D_18-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](#)
[![Stars](https://img.shields.io/github/stars/Matheotaku4/Upify?style=for-the-badge&color=gold)](https://github.com/Matheotaku4/Upify/stargazers)


- `gofile.io`
- `1fichier.com`
- `rootz.so`
- `send.now`
- `buzzheavier.com`
- `ranoz.gg`
- `vikingfile.com`
- `filemirage.com`
- `pixeldrain.com`

## Requirements

- Node.js `>= 18`
- npm

## Installation

Clone the repository 
```bash
git clone https://github.com/Matheotaku4/upify.git
```
Next,
```bash
npm install
```

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Desktop version (.exe)

Build the portable executable (embedded server + integrated window):

```bash
npm run build:exe
```

Generated file:

```text
dist-electron/MultiUploader.exe
```

## Local API

### `POST /api/upload`

`multipart/form-data` request:

- `file`: file to upload
- `targets`: JSON array of targets (example: `["gofile","1fichier"]`)
- `options`: JSON object per target (optional)

Example `options`:

```json
{
  "gofile": { "token": "..." },
  "1fichier": { "apiKey": "..." },
  "rootz": { "folderId": "..." },
  "buzzheavier": { "locationId": "3eb9t1559lkv" },
  "sendnow": { "link_rcpt": "mail@example.com" },
  "vikingfile": { "user": "" },
  "filemirage": { "apiToken": "..." },
  "pixeldrain": { "apiKey": "..." }
}
```

## Notes

- For `send.now`, the service returns a `file_code`. The app returns the `upload_result` URL.
- For `rootz.so`, multipart upload is used automatically from 4 MB (configurable with `multipartThreshold`).
- For `pixeldrain.com`, API upload requires an API key (`/user/api_keys`).
- The UI shows per-host progress bars while uploads are running.
- The streaming endpoint `POST /api/upload/stream` emits NDJSON events (`start`, `target_start`, `target_result`, `done`).
