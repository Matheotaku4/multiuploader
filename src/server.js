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

function sanitizePreferencePayload(value) {
  const source = value && typeof value === "object" ? value : {};

  let targets = [];
  if (Array.isArray(source.targets)) {
    targets = source.targets
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  const fields = {};
  if (source.fields && typeof source.fields === "object" && !Array.isArray(source.fields)) {
    for (const [key, rawValue] of Object.entries(source.fields)) {
      const fieldKey = String(key || "").trim();
      if (!fieldKey) {
        continue;
      }
      const valueAsString = rawValue == null ? "" : String(rawValue);
      fields[fieldKey] = valueAsString;
    }
  }

  return {
    targets,
    fields,
    advancedOpen: Boolean(source.advancedOpen)
  };
}

async function readPreferencesFromDisk(preferencesDir) {
  const preferencesFile = path.join(preferencesDir, "preferences.json");

  try {
    const raw = await fs.readFile(preferencesFile, "utf8");
    const parsed = JSON.parse(raw);
    return sanitizePreferencePayload(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writePreferencesToDisk(preferencesDir, payload) {
  const preferencesFile = path.join(preferencesDir, "preferences.json");
  const sanitized = sanitizePreferencePayload(payload);
  await fs.mkdir(preferencesDir, { recursive: true });
  await fs.writeFile(preferencesFile, JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
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

function resolveUploadTargets(requestedTargets) {
  return requestedTargets
    .map((target) => ({
      requested: target,
      normalized: normalizeTarget(target)
    }))
    .filter((item) => item.normalized);
}

function buildTargetResultFromError(normalized, error) {
  const isUploadError = error instanceof UploadError;
  return {
    ok: false,
    target: normalized,
    error: error.message || "Unknown error",
    details: isUploadError ? (error.details || null) : null
  };
}

function writeNdjsonLine(res, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`${JSON.stringify(payload)}\n`);
}

function resolvePreferencesDir(options = {}) {
  if (options.preferencesDir && String(options.preferencesDir).trim()) {
    return String(options.preferencesDir).trim();
  }
  const envDir = process.env.MULTIUPLOADER_DATA_DIR;
  if (envDir && String(envDir).trim()) {
    return String(envDir).trim();
  }
  return path.join(os.homedir(), ".multiuploader");
}

function createApp(options = {}) {
  const preferencesDir = resolvePreferencesDir(options);

  const app = express();
  const upload = multer({ dest: TMP_DIR });

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/targets", (_req, res) => {
    res.json({ targets: supportedTargets });
  });

  app.get("/api/preferences", async (_req, res) => {
    const preferences = await readPreferencesFromDisk(preferencesDir);
    res.json({ preferences });
  });

  app.post("/api/preferences", async (req, res) => {
    const preferences = await writePreferencesToDisk(preferencesDir, req.body);
    res.json({ ok: true, preferences });
  });

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "No file received (expected field: file)." });
      return;
    }

    let requestedTargets = parseTargets(req.body.targets);
    if (!requestedTargets.length) {
      requestedTargets = [...supportedTargets];
    }

    const normalizedTargets = resolveUploadTargets(requestedTargets);

    if (!normalizedTargets.length) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({
        error: "No valid target selected.",
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
            results[requested] = buildTargetResultFromError(normalized, error);
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

  app.post("/api/upload/stream", upload.single("file"), async (req, res) => {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "No file received (expected field: file)." });
      return;
    }

    let requestedTargets = parseTargets(req.body.targets);
    if (!requestedTargets.length) {
      requestedTargets = [...supportedTargets];
    }

    const normalizedTargets = resolveUploadTargets(requestedTargets);
    if (!normalizedTargets.length) {
      await fs.unlink(file.path).catch(() => {});
      res.status(400).json({
        error: "No valid target selected.",
        supportedTargets
      });
      return;
    }

    const optionsByTarget = parseJsonField(req.body.options, {});
    const results = {};

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    writeNdjsonLine(res, {
      type: "start",
      file: {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      },
      targets: normalizedTargets.map((item) => ({
        requested: item.requested,
        normalized: item.normalized
      }))
    });

    try {
      await Promise.all(
        normalizedTargets.map(async ({ requested, normalized }) => {
          writeNdjsonLine(res, {
            type: "target_start",
            requestedTarget: requested,
            normalizedTarget: normalized
          });

          const options =
            optionsByTarget[requested] ||
            optionsByTarget[normalized] ||
            {};

          try {
            const uploadResult = await uploadToTarget(normalized, file, options);
            const targetResult = {
              ok: true,
              target: normalized,
              url: uploadResult.url || null,
              raw: uploadResult.raw || null
            };
            results[requested] = targetResult;
            writeNdjsonLine(res, {
              type: "target_result",
              requestedTarget: requested,
              result: targetResult
            });
          } catch (error) {
            const targetResult = buildTargetResultFromError(normalized, error);
            results[requested] = targetResult;
            writeNdjsonLine(res, {
              type: "target_result",
              requestedTarget: requested,
              result: targetResult
            });
          }
        })
      );

      writeNdjsonLine(res, {
        type: "done",
        file: {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        },
        results
      });
      res.end();
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

  const app = createApp({
    preferencesDir: options.preferencesDir || null
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      const safeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
      const url = `http://${safeHost}:${activePort}`;

      if (!silent) {
        // eslint-disable-next-line no-console
        console.log(`MultiUploader online at ${url}`);
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
    console.error("Startup error:", error);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
  stopServer
};
