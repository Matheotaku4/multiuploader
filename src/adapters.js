const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const HTTP_TIMEOUT_MS = 180_000;

const http = axios.create({
  timeout: HTTP_TIMEOUT_MS,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  validateStatus: () => true
});

function mergeSignal(config, signal) {
  if (!signal) {
    return config || {};
  }
  return { ...(config || {}), signal };
}

const supportedTargets = [
  "gofile",
  "1fichier",
  "rootz",
  "sendnow",
  "buzzheavier",
  "ranoz",
  "vikingfile",
  "filemirage",
  "pixeldrain",
  "bowfile",
  "akirabox"
];

const targetAliases = {
  "gofile.io": "gofile",
  gofile: "gofile",
  "1fichier": "1fichier",
  onefichier: "1fichier",
  "1fichier.com": "1fichier",
  "rootz.so": "rootz",
  rootz: "rootz",
  "send.now": "sendnow",
  sendnow: "sendnow",
  buzzheavier: "buzzheavier",
  "buzzheavier.com": "buzzheavier",
  ranoz: "ranoz",
  "ranoz.gg": "ranoz",
  vikingfile: "vikingfile",
  "vikingfile.com": "vikingfile",
  filemirage: "filemirage",
  "filemirage.com": "filemirage",
  pixeldrain: "pixeldrain",
  "pixeldrain.com": "pixeldrain",
  bowfile: "bowfile",
  "bowfile.com": "bowfile",
  "www.bowfile.com": "bowfile",
  akirabox: "akirabox",
  "akirabox.com": "akirabox"
};

class UploadError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "UploadError";
    this.details = details;
  }
}

class MultipartRequiredError extends UploadError {
  constructor(message, details = null) {
    super(message, details);
    this.name = "MultipartRequiredError";
  }
}

function normalizeTarget(input) {
  if (!input || typeof input !== "string") {
    return null;
  }
  const key = input.trim().toLowerCase();
  return targetAliases[key] || null;
}

function parseJsonLoose(value) {
  if (value && typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch (_err) {
      return null;
    }
  }
  return null;
}

function makeErrorFromResponse(prefix, response, parsedBody = null) {
  const status = response?.status || "unknown";
  const body = parsedBody ?? parseJsonLoose(response?.data) ?? response?.data ?? null;
  return new UploadError(`${prefix} (HTTP ${status})`, body);
}

function toSafeFileName(name) {
  return name.replace(/[\/\\]/g, "_");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&#34;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&#x3D;|&#61;/gi, "=")
    .replace(/&#x2B;|&#43;/gi, "+");
}

function parseHtmlAttributes(tag) {
  const attributes = {};
  const body = String(tag || "")
    .replace(/^<\w+\s*/i, "")
    .replace(/\/?>\s*$/i, "");
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

  let match = null;
  while ((match = regex.exec(body)) !== null) {
    const name = String(match[1] || "").trim().toLowerCase();
    if (!name) {
      continue;
    }
    const rawValue = match[2] ?? match[3] ?? match[4];
    attributes[name] = rawValue === undefined ? true : decodeHtmlEntities(rawValue);
  }

  return attributes;
}

function extractSendNowForm(html) {
  const source = String(html || "");
  let formMatch = source.match(/<form\b[^>]*id=["']uploadfile["'][^>]*>[\s\S]*?<\/form>/i);

  if (!formMatch) {
    formMatch = source.match(/<form\b[^>]*action=["'][^"']*upload[^"']*["'][^>]*>[\s\S]*?<\/form>/i);
  }
  if (!formMatch) {
    return null;
  }

  const formBlock = formMatch[0];
  const openTag = formBlock.match(/^<form\b[^>]*>/i)?.[0] || null;
  if (!openTag) {
    return null;
  }

  const attributes = parseHtmlAttributes(openTag);
  const innerHtml = formBlock
    .replace(/^<form\b[^>]*>/i, "")
    .replace(/<\/form>\s*$/i, "");

  return {
    action: attributes.action ? String(attributes.action) : null,
    innerHtml
  };
}

function collectSendNowFields(formHtml) {
  const fields = {};
  const source = String(formHtml || "");

  const inputRegex = /<input\b[^>]*>/gi;
  let inputMatch = null;
  while ((inputMatch = inputRegex.exec(source)) !== null) {
    const attrs = parseHtmlAttributes(inputMatch[0]);
    const name = attrs.name;
    if (!name || typeof name !== "string") {
      continue;
    }
    const type = String(attrs.type || "text").toLowerCase();
    if (type === "file") {
      continue;
    }
    if (type === "checkbox") {
      const checked = Object.prototype.hasOwnProperty.call(attrs, "checked");
      fields[name] = checked ? String(attrs.value ?? "1") : "";
      continue;
    }
    fields[name] = attrs.value === true || attrs.value == null ? "" : String(attrs.value);
  }

  const selectRegex = /<select\b[^>]*>[\s\S]*?<\/select>/gi;
  let selectMatch = null;
  while ((selectMatch = selectRegex.exec(source)) !== null) {
    const selectBlock = selectMatch[0];
    const openTag = selectBlock.match(/^<select\b[^>]*>/i)?.[0] || null;
    if (!openTag) {
      continue;
    }

    const selectAttrs = parseHtmlAttributes(openTag);
    const name = selectAttrs.name;
    if (!name || typeof name !== "string") {
      continue;
    }

    const optionsHtml = selectBlock
      .replace(/^<select\b[^>]*>/i, "")
      .replace(/<\/select>\s*$/i, "");

    const optionRegex = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
    let optionMatch = null;
    let firstValue = "";
    let selectedValue = null;

    while ((optionMatch = optionRegex.exec(optionsHtml)) !== null) {
      const optionAttrs = parseHtmlAttributes(optionMatch[0]);
      const textValue = decodeHtmlEntities(optionMatch[1]).trim();
      const value = optionAttrs.value === true || optionAttrs.value == null
        ? textValue
        : String(optionAttrs.value);

      if (firstValue === "") {
        firstValue = value;
      }

      if (Object.prototype.hasOwnProperty.call(optionAttrs, "selected")) {
        selectedValue = value;
        break;
      }
    }

    fields[name] = selectedValue ?? firstValue;
  }

  const textAreaRegex = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi;
  let textAreaMatch = null;
  while ((textAreaMatch = textAreaRegex.exec(source)) !== null) {
    const openTag = textAreaMatch[0].match(/^<textarea\b[^>]*>/i)?.[0] || null;
    if (!openTag) {
      continue;
    }
    const attrs = parseHtmlAttributes(openTag);
    const name = attrs.name;
    if (!name || typeof name !== "string") {
      continue;
    }
    fields[name] = decodeHtmlEntities(textAreaMatch[1] || "").trim();
  }

  return fields;
}

async function ensureGofileFolderPublic(token, folderId, signal = null) {
  if (!token || !folderId) {
    return;
  }

  const response = await http.put(
    `https://api.gofile.io/contents/${encodeURIComponent(folderId)}/update`,
    {
      attribute: "public",
      attributeValue: true
    },
    mergeSignal({
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }, signal)
  );
  const body = parseJsonLoose(response.data);

  if (response.status < 200 || response.status >= 300 || body?.status !== "ok") {
    throw makeErrorFromResponse("Gofile: failed to set folder public", response, body);
  }
}

async function uploadToGofile(file, options = {}) {
  let token = options.token || null;
  let accountRootFolder = null;
  const signal = options.signal || null;

  if (!token) {
    const createResp = await http.post(
      "https://api.gofile.io/accounts",
      {},
      mergeSignal({}, signal)
    );
    const createBody = parseJsonLoose(createResp.data);
    if (createResp.status < 200 || createResp.status >= 300 || createBody?.status !== "ok") {
      throw makeErrorFromResponse("Gofile: failed to create temporary account", createResp, createBody);
    }
    token = createBody.data?.token;
    if (!token) {
      throw new UploadError("Gofile: missing token in account creation response", createBody);
    }
    accountRootFolder = createBody.data?.rootFolder || null;
  }

  let folderId = options.folderId || accountRootFolder || null;
  if (!folderId) {
    const accountResp = await http.get("https://api.gofile.io/accounts/website", mergeSignal({
      headers: { Authorization: `Bearer ${token}` }
    }, signal));
    const accountBody = parseJsonLoose(accountResp.data);
    if (accountResp.status < 200 || accountResp.status >= 300 || accountBody?.status !== "ok") {
      throw makeErrorFromResponse("Gofile: failed to read account data", accountResp, accountBody);
    }
    folderId = accountBody.data?.rootFolder || null;
  }

  if (folderId) {
    await ensureGofileFolderPublic(token, folderId, signal);
  }

  const form = new FormData();
  form.append("token", token);
  if (folderId) {
    form.append("folderId", folderId);
  }
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });

  const uploadResp = await http.post("https://upload.gofile.io/uploadfile", form, {
    headers: form.getHeaders(),
    ...mergeSignal({}, signal)
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  if (uploadResp.status >= 200 && uploadResp.status < 300 && uploadBody?.status === "ok") {
    return {
      url: uploadBody.data?.downloadPage || null,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("Gofile: upload failed", uploadResp, uploadBody);
}

async function uploadTo1fichier(file, options = {}) {
  const signal = options.signal || null;
  const serverResp = await http.post(
    "https://api.1fichier.com/v1/upload/get_upload_server.cgi",
    {},
    mergeSignal({ headers: { "Content-Type": "application/json" } }, signal)
  );
  const serverBody = parseJsonLoose(serverResp.data);
  if (serverResp.status < 200 || serverResp.status >= 300 || !serverBody?.url || !serverBody?.id) {
    throw makeErrorFromResponse(
      "1fichier: unable to get upload server",
      serverResp,
      serverBody
    );
  }

  const uploadHost = String(serverBody.url).trim();
  const uploadId = String(serverBody.id).trim();

  const form = new FormData();
  form.append("file[]", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });

  if (options.did !== undefined && options.did !== null && options.did !== "") {
    form.append("did", String(options.did));
  }
  if (options.mail) {
    form.append("mail", String(options.mail));
  }
  if (options.user) {
    form.append("user", String(options.user));
  }
  if (options.pass) {
    form.append("pass", String(options.pass));
  }
  if (options.dpass) {
    form.append("dpass", String(options.dpass));
  }

  const headers = form.getHeaders();
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const uploadResp = await http.post(`https://${uploadHost}/upload.cgi?id=${encodeURIComponent(uploadId)}`, form, {
    headers,
    maxRedirects: 0,
    ...mergeSignal({}, signal)
  });

  if (uploadResp.status !== 302 && uploadResp.status !== 200) {
    throw makeErrorFromResponse("1fichier: upload rejected", uploadResp);
  }

  const reportResp = await http.get(`https://${uploadHost}/end.pl`, {
    params: { xid: uploadId },
    headers: { JSON: "1" },
    ...mergeSignal({}, signal)
  });
  const reportBody = parseJsonLoose(reportResp.data);
  const firstLink = reportBody?.links?.[0]?.download || null;

  if (reportResp.status >= 200 && reportResp.status < 300 && firstLink) {
    return {
      url: firstLink,
      raw: reportBody
    };
  }

  throw makeErrorFromResponse("1fichier: invalid completion report", reportResp, reportBody);
}

async function uploadToRootzRegular(file, options = {}) {
  const signal = options.signal || null;
  const form = new FormData();
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });
  if (options.folderId) {
    form.append("folderId", options.folderId);
  }

  const response = await http.post("https://rootz.so/api/files/upload", form, {
    headers: form.getHeaders(),
    ...mergeSignal({}, signal)
  });
  const body = parseJsonLoose(response.data);

  const asksMultipart =
    response.status === 413 ||
    Boolean(body?.useMultipartUpload) ||
    (typeof body?.error === "string" && body.error.toLowerCase().includes("multipart"));

  if (asksMultipart) {
    throw new MultipartRequiredError("Rootz: multipart upload required", body);
  }

  if (response.status >= 200 && response.status < 300 && body?.success) {
    const shortId = body.data?.shortId;
    const url = shortId ? `https://rootz.so/d/${shortId}` : body.data?.url;
    if (!url) {
      throw new UploadError("Rootz: missing link in upload response", body);
    }
    return { url, raw: body };
  }

  throw makeErrorFromResponse("Rootz: standard upload failed", response, body);
}

async function readChunk(fileHandle, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function uploadToRootzMultipart(file, options = {}) {
  const signal = options.signal || null;
  const initResp = await http.post("https://rootz.so/api/files/multipart/init", {
    fileName: file.originalname,
    fileSize: file.size,
    fileType: file.mimetype || "application/octet-stream",
    folderId: options.folderId || null
  }, mergeSignal({}, signal));
  const initBody = parseJsonLoose(initResp.data);
  if (initResp.status < 200 || initResp.status >= 300 || !initBody?.success) {
    throw makeErrorFromResponse("Rootz: multipart init failed", initResp, initBody);
  }

  const uploadId = initBody.uploadId;
  const key = initBody.key;
  const chunkSize = Number(initBody.chunkSize);
  const totalParts = Number(initBody.totalParts);

  if (!uploadId || !key || !chunkSize || !totalParts) {
    throw new UploadError("Rootz: incomplete multipart init response", initBody);
  }

  const urlsResp = await http.post("https://rootz.so/api/files/multipart/batch-urls", {
    key,
    uploadId,
    totalParts,
    expiresIn: 7200
  }, mergeSignal({}, signal));
  const urlsBody = parseJsonLoose(urlsResp.data);
  if (urlsResp.status < 200 || urlsResp.status >= 300 || !urlsBody?.success) {
    throw makeErrorFromResponse("Rootz: unable to get chunk URLs", urlsResp, urlsBody);
  }

  const partUrls = { ...(urlsBody.urls || {}) };
  const parts = [];
  const handle = await fsp.open(file.path, "r");

  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      let signedUrl = partUrls[partNumber] || partUrls[String(partNumber)] || null;
      if (!signedUrl) {
        const singleResp = await http.post("https://rootz.so/api/files/multipart/part-url", {
          key,
          uploadId,
          partNumber,
          expiresIn: 7200
        }, mergeSignal({}, signal));
        const singleBody = parseJsonLoose(singleResp.data);
        if (singleResp.status < 200 || singleResp.status >= 300 || !singleBody?.success || !singleBody?.url) {
          throw makeErrorFromResponse(
            `Rootz: missing URL for part ${partNumber}`,
            singleResp,
            singleBody
          );
        }
        signedUrl = singleBody.url;
      }

      const start = (partNumber - 1) * chunkSize;
      const length = Math.min(chunkSize, file.size - start);
      const chunk = await readChunk(handle, start, length);

      const putResp = await http.put(signedUrl, chunk, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.length)
        },
        timeout: Math.max(HTTP_TIMEOUT_MS, 300_000),
        ...mergeSignal({}, signal)
      });
      if (putResp.status < 200 || putResp.status >= 300) {
        throw makeErrorFromResponse(`Rootz: chunk ${partNumber} upload failed`, putResp);
      }

      const etagRaw = putResp.headers?.etag || putResp.headers?.ETag;
      if (!etagRaw) {
        throw new UploadError(`Rootz: missing ETag for part ${partNumber}`);
      }
      parts.push({
        partNumber,
        etag: String(etagRaw).replace(/"/g, "")
      });
    }
  } finally {
    await handle.close();
  }

  const completeResp = await http.post("https://rootz.so/api/files/multipart/complete", {
    key,
    uploadId,
    parts: parts.sort((a, b) => a.partNumber - b.partNumber),
    fileName: file.originalname,
    fileSize: file.size,
    contentType: file.mimetype || "application/octet-stream",
    folderId: options.folderId || null
  }, mergeSignal({}, signal));
  const completeBody = parseJsonLoose(completeResp.data);
  if (completeResp.status < 200 || completeResp.status >= 300 || !completeBody?.success) {
    throw makeErrorFromResponse("Rootz: multipart completion failed", completeResp, completeBody);
  }

  const outFile = completeBody.file || completeBody.data || {};
  const url = outFile.shortId
    ? `https://rootz.so/d/${outFile.shortId}`
    : (outFile.downloadUrl || outFile.url || null);

  if (!url) {
    throw new UploadError("Rootz: missing link after multipart completion", completeBody);
  }

  return { url, raw: completeBody };
}

async function uploadToRootz(file, options = {}) {
  const threshold = Number(options.multipartThreshold || 4 * 1024 * 1024);

  if (file.size >= threshold) {
    return uploadToRootzMultipart(file, options);
  }

  try {
    return await uploadToRootzRegular(file, options);
  } catch (err) {
    if (err instanceof MultipartRequiredError) {
      return uploadToRootzMultipart(file, options);
    }
    throw err;
  }
}

function parseSendNowPayload(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    return [raw];
  }
  if (typeof raw !== "string") {
    return null;
  }

  const direct = parseJsonLoose(raw);
  if (Array.isArray(direct)) {
    return direct;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const lastJson = parseJsonLoose(lines[lines.length - 1]);
  return Array.isArray(lastJson) ? lastJson : null;
}

async function uploadToSendNow(file, options = {}) {
  const signal = options.signal || null;
  const uploadPageResp = await http.get("https://send.now/upload", mergeSignal({}, signal));
  if (uploadPageResp.status < 200 || uploadPageResp.status >= 300) {
    throw makeErrorFromResponse("Send.now: unable to load upload page", uploadPageResp);
  }

  const parsedForm = extractSendNowForm(uploadPageResp.data);
  const actionAttr = parsedForm?.action || null;
  if (!actionAttr) {
    throw new UploadError("Send.now: form action not found");
  }

  const actionUrl = new URL(actionAttr, "https://send.now/upload").toString();
  const fields = collectSendNowFields(parsedForm.innerHtml);

  fields.keepalive = "1";
  if (options.link_rcpt) {
    fields.link_rcpt = String(options.link_rcpt);
    fields.enableemail = "1";
  }
  if (options.link_pass) {
    fields.link_pass = String(options.link_pass);
  }
  if (options.file_expire_time) {
    fields.file_expire_time = String(options.file_expire_time);
  }
  if (options.file_expire_unit) {
    fields.file_expire_unit = String(options.file_expire_unit);
  }
  if (options.file_max_dl) {
    fields.file_max_dl = String(options.file_max_dl);
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value == null ? "" : String(value));
  }
  form.append("file_0", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });

  const uploadResp = await http.post(actionUrl, form, {
    headers: form.getHeaders(),
    ...mergeSignal({}, signal)
  });
  const payload = parseSendNowPayload(uploadResp.data);

  if (uploadResp.status >= 200 && uploadResp.status < 300 && payload?.length) {
    const first = payload[0];
    if (first?.file_code) {
      const st = first.file_status || "OK";
      const code = first.file_code;
      return {
        url: `https://send.now/?op=upload_result&st=${encodeURIComponent(st)}&fn=${encodeURIComponent(code)}`,
        raw: first
      };
    }
  }

  throw makeErrorFromResponse("Send.now: unexpected upload response", uploadResp, payload);
}

async function uploadToFileditch(file, options = {}) {
  const signal = options.signal || null;
  const uploadWithName = async (filename, withExplicitMime = false) => {
    const form = new FormData();
    const fileOptions = { filename };
    if (withExplicitMime) {
      fileOptions.contentType = file.mimetype || "application/octet-stream";
    }
    form.append("files[]", fs.createReadStream(file.path), fileOptions);

    const response = await http.post("https://up1.fileditch.com/upload.php", form, {
      headers: form.getHeaders(),
      ...mergeSignal({}, signal)
    });
    const body = parseJsonLoose(response.data);
    return { response, body };
  };

  const parsed = path.parse(file.originalname);
  const base = (parsed.name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const candidateNames = [
    file.originalname,
    `${base}.txt`,
    `${base}.dat`,
    `${base}.bin`
  ];

  let lastFailure = null;
  for (let i = 0; i < candidateNames.length; i += 1) {
    const candidate = candidateNames[i];
    const tryResult = await uploadWithName(candidate, i === 0);
    const ok =
      tryResult.response.status >= 200 &&
      tryResult.response.status < 300 &&
      tryResult.body?.success &&
      tryResult.body.files?.[0]?.url;

    if (ok) {
      return {
        url: tryResult.body.files[0].url,
        raw: {
          ...tryResult.body,
          renamedFrom: candidate === file.originalname ? undefined : file.originalname,
          renamedTo: candidate === file.originalname ? undefined : candidate
        }
      };
    }

    const blockedByExt =
      tryResult.response.status === 415 &&
      typeof tryResult.body?.description === "string" &&
      tryResult.body.description.toLowerCase().includes("extension");

    lastFailure = tryResult;
    if (!blockedByExt) {
      break;
    }
  }

  if (lastFailure) {
    throw makeErrorFromResponse("Fileditch: upload failed after extension fallbacks", lastFailure.response, lastFailure.body);
  }

  throw new UploadError("Fileditch: unknown upload failure");
}

async function uploadToBuzzheavier(file, options = {}) {
  const signal = options.signal || null;
  const locationId = options.locationId || "3eb9t1559lkv";
  const customTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(customTimeout) && customTimeout > 0 ? customTimeout : 0;
  const targetUrl = new URL(`https://w.buzzheavier.com/${encodeURIComponent(toSafeFileName(file.originalname))}`);
  targetUrl.searchParams.set("locationId", locationId);
  if (options.note) {
    targetUrl.searchParams.set("note", Buffer.from(String(options.note), "utf8").toString("base64"));
  }

  const response = await http.put(
    targetUrl.toString(),
    fs.createReadStream(file.path),
    {
      headers: {
        "Content-Type": file.mimetype || "application/octet-stream",
        "Content-Length": String(file.size)
      },
      timeout: timeoutMs,
      ...mergeSignal({}, signal)
    }
  );
  const body = parseJsonLoose(response.data);
  const id = body?.data?.id;

  if (response.status === 201 && id) {
    return {
      url: `https://buzzheavier.com/${encodeURIComponent(id)}`,
      raw: body
    };
  }

  throw makeErrorFromResponse("Buzzheavier: upload failed", response, body);
}

async function uploadToRanoz(file, options = {}) {
  const signal = options.signal || null;
  const metaResp = await http.post("https://ranoz.gg/api/v1/files/upload_url", {
    filename: file.originalname,
    size: file.size
  }, {
    headers: { "Content-Type": "application/json" },
    ...mergeSignal({}, signal)
  });
  const metaBody = parseJsonLoose(metaResp.data);
  const uploadUrl = metaBody?.data?.upload_url;
  const shareUrl = metaBody?.data?.url;

  if (metaResp.status < 200 || metaResp.status >= 300 || !uploadUrl) {
    throw makeErrorFromResponse("Ranoz: unable to get signed URL", metaResp, metaBody);
  }

  const putResp = await http.put(uploadUrl, fs.createReadStream(file.path), {
    headers: {
      "Content-Type": file.mimetype || "application/octet-stream",
      "Content-Length": String(file.size)
    },
    ...mergeSignal({}, signal)
  });

  if (putResp.status >= 200 && putResp.status < 300) {
    return {
      url: shareUrl || null,
      raw: metaBody
    };
  }

  throw makeErrorFromResponse("Ranoz: content upload failed", putResp);
}

async function uploadToVikingfile(file, options = {}) {
  const signal = options.signal || null;
  const serverResp = await http.get("https://vikingfile.com/api/get-server", mergeSignal({}, signal));
  const serverBody = parseJsonLoose(serverResp.data);
  const server = String(serverBody?.server || "").trim();

  if (serverResp.status < 200 || serverResp.status >= 300 || !server) {
    throw makeErrorFromResponse("Vikingfile: unable to get upload server", serverResp, serverBody);
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });
  form.append("user", options.user == null ? "" : String(options.user));
  if (options.path) {
    form.append("path", String(options.path));
  }
  if (options.pathPublicShare) {
    form.append("pathPublicShare", String(options.pathPublicShare));
  }

  const uploadResp = await http.post(server, form, {
    headers: form.getHeaders(),
    timeout: Math.max(HTTP_TIMEOUT_MS, 300_000),
    ...mergeSignal({}, signal)
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  const url = uploadBody?.url || null;

  if (uploadResp.status >= 200 && uploadResp.status < 300 && url) {
    return {
      url,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("Vikingfile: upload failed", uploadResp, uploadBody);
}

async function uploadToFilemirage(file, options = {}) {
  const signal = options.signal || null;
  const apiToken = String(options.apiToken || "").trim();
  const baseHeaders = apiToken ? { Authorization: `Bearer ${apiToken}` } : {};

  const serverResp = await http.get("https://filemirage.com/api/servers", {
    headers: baseHeaders,
    ...mergeSignal({}, signal)
  });
  const serverBody = parseJsonLoose(serverResp.data);
  const server = String(serverBody?.data?.server || "").trim().replace(/\/+$/, "");
  const uploadId = String(serverBody?.data?.upload_id || "").trim();

  if (
    serverResp.status < 200 ||
    serverResp.status >= 300 ||
    serverBody?.success === false ||
    !server ||
    !uploadId
  ) {
    throw makeErrorFromResponse("FileMirage: unable to initialize upload", serverResp, serverBody);
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });
  form.append("filename", file.originalname);
  form.append("upload_id", uploadId);
  form.append("chunk_number", "0");
  form.append("total_chunks", "1");

  const uploadHeaders = {
    ...form.getHeaders(),
    ...baseHeaders
  };

  const uploadResp = await http.post(`${server}/upload.php`, form, {
    headers: uploadHeaders,
    timeout: Math.max(HTTP_TIMEOUT_MS, 300_000),
    ...mergeSignal({}, signal)
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  const url = uploadBody?.data?.url || uploadBody?.url || null;

  if (
    uploadResp.status >= 200 &&
    uploadResp.status < 300 &&
    uploadBody?.success !== false &&
    url
  ) {
    return {
      url,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("FileMirage: upload failed", uploadResp, uploadBody);
}

async function uploadToPixeldrain(file, options = {}) {
  const signal = options.signal || null;
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) {
    throw new UploadError(
      "Pixeldrain: apiKey is required (create one at https://pixeldrain.com/user/api_keys)"
    );
  }

  const auth = {
    username: "",
    password: apiKey
  };

  const tryPut = async () => {
    const response = await http.put(
      `https://pixeldrain.com/api/file/${encodeURIComponent(file.originalname)}`,
      fs.createReadStream(file.path),
      {
        auth,
        headers: {
          "Content-Type": file.mimetype || "application/octet-stream",
          "Content-Length": String(file.size)
        },
        timeout: Math.max(HTTP_TIMEOUT_MS, 600_000),
        ...mergeSignal({}, signal)
      }
    );
    const body = parseJsonLoose(response.data);
    const id = body?.id || null;
    if (response.status >= 200 && response.status < 300 && body?.success !== false && id) {
      return { url: `https://pixeldrain.com/u/${id}`, raw: body };
    }
    return { response, body, ok: false };
  };

  const tryPost = async () => {
    const form = new FormData();
    form.append("file", fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype || "application/octet-stream"
    });
    const response = await http.post("https://pixeldrain.com/api/file", form, {
      auth,
      headers: form.getHeaders(),
      timeout: Math.max(HTTP_TIMEOUT_MS, 600_000),
      ...mergeSignal({}, signal)
    });
    const body = parseJsonLoose(response.data);
    const id = body?.id || null;
    if (response.status >= 200 && response.status < 300 && body?.success !== false && id) {
      return { url: `https://pixeldrain.com/u/${id}`, raw: body };
    }
    return { response, body, ok: false };
  };

  const putResult = await tryPut();
  if (putResult?.url) {
    return putResult;
  }

  const postResult = await tryPost();
  if (postResult?.url) {
    return postResult;
  }

  throw makeErrorFromResponse(
    "Pixeldrain: upload failed",
    postResult.response || putResult.response,
    postResult.body || putResult.body
  );
}

async function uploadToBowFile(file, options = {}) {
  const signal = options.signal || null;
  const key1 = String(options.key1 || "").trim();
  const key2 = String(options.key2 || "").trim();
  const folderId = String(options.folderId || "").trim();

  if (!key1 || !key2) {
    throw new UploadError("BowFile: both API keys (key1 and key2) are required.");
  }

  const authForm = new FormData();
  authForm.append("key1", key1);
  authForm.append("key2", key2);

  const authResp = await http.post("https://bowfile.com/api/v2/authorize", authForm, {
    headers: authForm.getHeaders(),
    ...mergeSignal({}, signal)
  });
  const authBody = parseJsonLoose(authResp.data);
  if (authResp.status < 200 || authResp.status >= 300 || authBody?._status !== "success") {
    throw makeErrorFromResponse("BowFile: authorization failed", authResp, authBody);
  }

  const accessToken = String(authBody?.data?.access_token || "").trim();
  const accountId = String(authBody?.data?.account_id || "").trim();
  if (!accessToken || !accountId) {
    throw new UploadError("BowFile: authorization did not return tokens", authBody);
  }

  const uploadForm = new FormData();
  uploadForm.append("access_token", accessToken);
  uploadForm.append("account_id", accountId);
  if (folderId) {
    uploadForm.append("folder_id", folderId);
  }
  uploadForm.append("upload_file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });

  const uploadResp = await http.post("https://bowfile.com/api/v2/file/upload", uploadForm, {
    headers: uploadForm.getHeaders(),
    ...mergeSignal({}, signal)
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  const fileEntry = Array.isArray(uploadBody?.data) ? uploadBody.data[0] : null;
  if (
    uploadResp.status >= 200 &&
    uploadResp.status < 300 &&
    fileEntry &&
    fileEntry.url
  ) {
    return {
      url: fileEntry.url,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("BowFile: upload failed", uploadResp, uploadBody);
}

async function uploadToAkiraBox(file, options = {}) {
  const signal = options.signal || null;
  const apiKey = String(options.apiKey || "").trim();

  if (!apiKey) {
    throw new UploadError("AkiraBox: API key is required");
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });

  const uploadResp = await http.post("https://akirabox.com/api/files/upload", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`
    },
    timeout: Math.max(HTTP_TIMEOUT_MS, 600_000),
    ...mergeSignal({}, signal)
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  const fileCode = uploadBody?.file_code || uploadBody?.data?.file_code || null;

  if (uploadResp.status >= 200 && uploadResp.status < 300 && fileCode) {
    return {
      url: `https://akirabox.com/${fileCode}/file`,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("AkiraBox: upload failed", uploadResp, uploadBody);
}

async function uploadToTarget(target, file, options = {}) {
  const normalized = normalizeTarget(target);
  if (!normalized) {
    throw new UploadError(`Unknown target: ${target}`);
  }

  switch (normalized) {
    case "gofile":
      return uploadToGofile(file, options);
    case "1fichier":
      return uploadTo1fichier(file, options);
    case "rootz":
      return uploadToRootz(file, options);
    case "sendnow":
      return uploadToSendNow(file, options);
    case "buzzheavier":
      return uploadToBuzzheavier(file, options);
    case "ranoz":
      return uploadToRanoz(file, options);
    case "vikingfile":
      return uploadToVikingfile(file, options);
    case "filemirage":
      return uploadToFilemirage(file, options);
    case "pixeldrain":
      return uploadToPixeldrain(file, options);
    case "bowfile":
      return uploadToBowFile(file, options);
    case "akirabox":
      return uploadToAkiraBox(file, options);
    default:
      throw new UploadError(`Unknown target: ${target}`);
  }
}

module.exports = {
  UploadError,
  supportedTargets,
  normalizeTarget,
  uploadToTarget
};
