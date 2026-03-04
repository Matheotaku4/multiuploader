const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const {
  UploadError,
  supportedTargets,
  normalizeTarget,
  uploadToTarget
} = require("./adapters");

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";
const TMP_DIR = path.join(os.tmpdir(), "multiupload-tmp");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

function parseJsonField(value, fallback = {}) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_err) {
      return fallback;
    }
  }
  return fallback;
}

function parseTargets(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_err) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function createApp() {
  const app = express();
  const upload = multer({ dest: TMP_DIR });

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/targets", (_req, res) => {
    res.json({ targets: supportedTargets });
  });

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "Aucun fichier recu (champ attendu: file)." });
      return;
    }

    let requestedTargets = parseTargets(req.body.targets);
    if (!requestedTargets.length) {
      requestedTargets = [...supportedTargets];
    }

    const normalizedTargets = requestedTargets
      .map((target) => ({
        requested: target,
        normalized: normalizeTarget(target)
      }))
      .filter((item) => item.normalized);

    if (!normalizedTargets.length) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({
        error: "Aucune cible valide selectionnee.",
        supportedTargets
      });
      return;
    }

    const optionsByTarget = parseJsonField(req.body.options, {});
    const results = {};

    try {
      await Promise.all(
        normalizedTargets.map(async ({ requested, normalized }) => {
          const options =
            optionsByTarget[requested] ||
            optionsByTarget[normalized] ||
            {};

          try {
            const uploadResult = await uploadToTarget(normalized, file, options);
            results[requested] = {
              ok: true,
              target: normalized,
              url: uploadResult.url || null,
              raw: uploadResult.raw || null
            };
          } catch (error) {
            const isUploadError = error instanceof UploadError;
            results[requested] = {
              ok: false,
              target: normalized,
              error: error.message || "Erreur inconnue",
              details: isUploadError ? (error.details || null) : null
            };
          }
        })
      );

      res.status(200).json({
        file: {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        },
        results
      });
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }
  });

  return app;
}

async function startServer(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  const host = String(options.host || DEFAULT_HOST);
  const silent = Boolean(options.silent);

  await ensureTmpDir();

  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      const safeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
      const url = `http://${safeHost}:${activePort}`;

      if (!silent) {
        // eslint-disable-next-line no-console
        console.log(`MultiUploader en ligne sur ${url}`);
      }

      resolve({ app, server, host: safeHost, port: activePort, url });
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Erreur au demarrage:", error);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
  stopServer
};
