# Upify

[![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D_18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)](#)
[![Stars](https://img.shields.io/github/stars/Matheotaku4/Upify?color=gold)](https://github.com/Matheotaku4/Upify/stargazers)

![Screenshot](https://files.catbox.moe/8eslbp.png)

> [!WARNING]  
> This app is vibe coded by gpt-5.3-codex

Local web app to upload one file to multiple hosts in parallel:

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

Download the exe : [![Release](https://img.shields.io/github/v/release/Matheotaku4/Upify?color=blue&logo=github)](https://github.com/Matheotaku4/Upify/releases)

or

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
dist-electron/Upify.exe
```

## Documentation

- [API Guide](./API.md): explains where to get API keys/tokens and whether each one is required.

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

## Features

- **Branding & docs**: `logo.png` is rendered in the hero; the API help button opens the GitHub-hosted guide (`/API.md`) for API key hints.
- **Stats & history**: the hero shows “You have uploaded x Go” powered by `/api/stats`; stats update automatically when uploads finish.
- **Cancellations**: per-host “Cancel” buttons plus a global “Cancel all” stop the streaming upload request via `/api/upload/cancel`.
- **Exporting results**: new “Save links (.txt)” button writes the collected URLs with filename + timestamp.
- **Windows integration**: icon assets replaced with `icon.png`/`icon.ico`, the installer uses them, and the Windows “Envoyer a Upify” right-click entry launches/focuses Upify.

## Notes

- For `send.now`, the service returns a `file_code`. The app returns the `upload_result` URL.
- For `rootz.so`, multipart upload is used automatically from 4 MB (configurable with `multipartThreshold`).
- For `pixeldrain.com`, API upload requires an API key (`/user/api_keys`).
- The UI shows per-host progress bars while uploads are running.
- The streaming endpoint `POST /api/upload/stream` emits NDJSON events (`start`, `target_start`, `target_result`, `done`).
