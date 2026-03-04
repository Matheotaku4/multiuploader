# MultiUploader

Local web app to upload one file to multiple hosts in parallel:

- `gofile.io`
- `1fichier.com`
- `rootz.so`
- `send.now`
- `buzzheavier.com`
- `ranoz.gg`

## Requirements

- Node.js `>= 18`
- npm

## Installation

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
  "sendnow": { "link_rcpt": "mail@example.com" }
}
```

## Notes

- For `send.now`, the service returns a `file_code`. The app returns the `upload_result` URL.
- For `rootz.so`, multipart upload is used automatically from 4 MB (configurable with `multipartThreshold`).
