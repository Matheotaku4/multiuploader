# Upify

[![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D_18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](#)
[![Stars](https://img.shields.io/github/stars/Matheotaku4/Upify?color=gold)](https://github.com/Matheotaku4/Upify/stargazers)

![Screenshot](https://files.catbox.moe/6qs9ln.png)
https://files.catbox.moe/8eslbp.png
Local desktop/web uploader for sending one file to multiple hosts in parallel:

- `gofile.io`
- `1fichier.com`
- `rootz.so`
- `send.now`
- `buzzheavier.com`
- `ranoz.gg`
- `vikingfile.com`
- `filemirage.com`
- `pixeldrain.com`
- `bowfile.com`

## Requirements

- Node.js `>= 18`
- npm

## Installation

Download the latest binaries from Releases:

[![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)

Or clone and run locally:

```bash
git clone https://github.com/Matheotaku4/Upify.git
cd Upify
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Desktop Build

Build portable + setup artifacts:

```bash
npm run build:release
```

Main outputs:

```text
dist-electron/Upify-<version>-portable.exe
dist-electron/Upify-<version>-setup.exe
```

## Documentation

- [API Guide](./API.md): where to get API keys/tokens and whether they are required.

## Features

- Per-host parallel upload with detailed result cards.
- Per-host progress bars and host-level cancellation.
- Global "Cancel all" for a full running job.
- "Copy all links" and "Save links (.txt)" actions after upload.
- Persistent preferences: selected hosts, API fields, advanced panel state.
- Upload stats counter: "You have uploaded x Go".
- Desktop mode: local server started in background with an integrated Electron window.
- Windows notifications when upload is complete.
- External links open in your default browser.
- BowFile integration via `/api/v2/authorize` + `/api/v2/file/upload`.

## Local API

### `POST /api/upload`

`multipart/form-data` fields:

- `file`: uploaded file
- `targets`: JSON array (example: `["gofile","1fichier"]`)
- `options`: JSON object keyed by target (optional)

Example:

```json
{
  "gofile": { "token": "..." },
  "1fichier": { "apiKey": "..." },
  "rootz": { "folderId": "..." },
  "buzzheavier": { "locationId": "3eb9t1559lkv" },
  "sendnow": { "link_rcpt": "mail@example.com" },
  "vikingfile": { "user": "" },
  "filemirage": { "apiToken": "..." },
  "pixeldrain": { "apiKey": "..." },
  "bowfile": { "key1": "...", "key2": "...", "folderId": "optional" }
}
```
