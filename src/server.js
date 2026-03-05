const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
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
const PROJECT_ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(os.tmpdir(), "upify-tmp");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const API_DOC_FILE = path.join(PROJECT_ROOT, "API.md");
const LOGO_FILE = path.join(PROJECT_ROOT, "logo.png");
const activeUploadJobs = new Map();

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

function sanitizeStatsPayload(value) {
  const source = value && typeof value === "object" ? value : {};
  const raw = Number(source.totalUploadedBytes);
  const totalUploadedBytes = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return { totalUploadedBytes };
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

async function readStatsFromDisk(preferencesDir) {
  const statsFile = path.join(preferencesDir, "stats.json");
  try {
    const raw = await fs.readFile(statsFile, "utf8");
    return sanitizeStatsPayload(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { totalUploadedBytes: 0 };
    }
    return { totalUploadedBytes: 0 };
  }
}

async function writeStatsToDisk(preferencesDir, payload) {
  const statsFile = path.join(preferencesDir, "stats.json");
  const stats = sanitizeStatsPayload(payload);
  await fs.mkdir(preferencesDir, { recursive: true });
  await fs.writeFile(statsFile, JSON.stringify(stats, null, 2), "utf8");
  return stats;
}

async function addUploadedBytes(preferencesDir, uploadedBytes) {
  const increment = Number(uploadedBytes);
  if (!Number.isFinite(increment) || increment <= 0) {
    return readStatsFromDisk(preferencesDir);
  }
  const current = await readStatsFromDisk(preferencesDir);
  return writeStatsToDisk(preferencesDir, {
    totalUploadedBytes: current.totalUploadedBytes + increment
  });
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

function buildCanceledResult(normalized) {
  return {
    ok: false,
    canceled: true,
    target: normalized,
    error: "Canceled",
    details: null
  };
}

function countSuccessfulTargets(results) {
  return Object.values(results || {}).filter((entry) => entry && entry.ok).length;
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
  const envDir = process.env.UPIFY_DATA_DIR || process.env.MULTIUPLOADER_DATA_DIR;
  if (envDir && String(envDir).trim()) {
    return String(envDir).trim();
  }
  return path.join(os.homedir(), ".upify");
}

function createApp(options = {}) {
  const preferencesDir = resolvePreferencesDir(options);

  const app = express();
  const upload = multer({ dest: TMP_DIR });

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/API.md", (_req, res) => {
    res.sendFile(API_DOC_FILE);
  });

  app.get("/logo.png", (_req, res) => {
    res.sendFile(LOGO_FILE);
  });

  app.get("/api/targets", (_req, res) => {
    res.json({ targets: supportedTargets });
  });

  app.get("/api/stats", async (_req, res) => {
    const stats = await readStatsFromDisk(preferencesDir);
    res.json({ stats });
  });

  app.get("/api/preferences", async (_req, res) => {
    const preferences = await readPreferencesFromDisk(preferencesDir);
    res.json({ preferences });
  });

  app.post("/api/preferences", async (req, res) => {
    const preferences = await writePreferencesToDisk(preferencesDir, req.body);
    res.json({ ok: true, preferences });
  });

  app.post("/api/upload/cancel", (req, res) => {
    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) {
      res.status(400).json({ error: "jobId is required." });
      return;
    }

    const job = activeUploadJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Upload job not found or already completed." });
      return;
    }

    const targetRaw = req.body?.target;
    if (targetRaw == null || String(targetRaw).trim() === "") {
      job.canceledAll = true;
      for (const controller of job.controllers.values()) {
        controller.abort();
      }
      res.json({ ok: true, jobId, canceledAll: true });
      return;
    }

    const targetNormalized = normalizeTarget(String(targetRaw).trim()) || String(targetRaw).trim().toLowerCase();
    job.canceledTargets.add(targetNormalized);
    const controller = job.controllers.get(targetNormalized);
    if (controller) {
      controller.abort();
    }

    res.json({ ok: true, jobId, target: targetNormalized });
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

      const successfulCount = countSuccessfulTargets(results);
      const stats = await addUploadedBytes(preferencesDir, file.size * successfulCount);

      res.status(200).json({
        file: {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        },
        results,
        stats
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
    const requestedJobId = String(req.body.jobId || "").trim();
    const jobId = requestedJobId || randomUUID();
    const jobState = {
      id: jobId,
      canceledAll: false,
      canceledTargets: new Set(),
      controllers: new Map()
    };

    activeUploadJobs.set(jobId, jobState);
    const cleanupJob = () => {
      const current = activeUploadJobs.get(jobId);
      if (current === jobState) {
        activeUploadJobs.delete(jobId);
      }
    };

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
      jobId,
      targets: normalizedTargets.map((item) => ({
        requested: item.requested,
        normalized: item.normalized
      }))
    });

    try {
      await Promise.all(
        normalizedTargets.map(async ({ requested, normalized }) => {
          if (jobState.canceledAll || jobState.canceledTargets.has(normalized)) {
            const targetResult = buildCanceledResult(normalized);
            results[requested] = targetResult;
            writeNdjsonLine(res, {
              type: "target_result",
              requestedTarget: requested,
              result: targetResult
            });
            return;
          }

          writeNdjsonLine(res, {
            type: "target_start",
            requestedTarget: requested,
            normalizedTarget: normalized
          });

          const controller = new AbortController();
          jobState.controllers.set(normalized, controller);

          const options = {
            ...(
            optionsByTarget[requested] ||
            optionsByTarget[normalized] ||
            {}
            ),
            signal: controller.signal
          };

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
            const canceled =
              controller.signal.aborted ||
              jobState.canceledAll ||
              jobState.canceledTargets.has(normalized) ||
              error?.code === "ERR_CANCELED";
            const targetResult = canceled
              ? buildCanceledResult(normalized)
              : buildTargetResultFromError(normalized, error);
            results[requested] = targetResult;
            writeNdjsonLine(res, {
              type: "target_result",
              requestedTarget: requested,
              result: targetResult
            });
          } finally {
            if (jobState.controllers.get(normalized) === controller) {
              jobState.controllers.delete(normalized);
            }
          }
        })
      );

      const successfulCount = countSuccessfulTargets(results);
      const stats = await addUploadedBytes(preferencesDir, file.size * successfulCount);

      writeNdjsonLine(res, {
        type: "done",
        jobId,
        file: {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        },
        results,
        stats
      });
      res.end();
    } finally {
      cleanupJob();
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
        console.log(`Upify online at ${url}`);
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
