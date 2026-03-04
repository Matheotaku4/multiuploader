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

const supportedTargets = [
  "gofile",
  "1fichier",
  "rootz",
  "sendnow",
  "buzzheavier",
  "ranoz"
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
  "ranoz.gg": "ranoz"
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

async function uploadToGofile(file, options = {}) {
  let token = options.token || null;

  if (!token) {
    const createResp = await http.post(
      "https://api.gofile.io/accounts",
      {}
    );
    const createBody = parseJsonLoose(createResp.data);
    if (createResp.status < 200 || createResp.status >= 300 || createBody?.status !== "ok") {
      throw makeErrorFromResponse("Gofile: impossible de creer un compte temporaire", createResp, createBody);
    }
    token = createBody.data?.token;
    if (!token) {
      throw new UploadError("Gofile: token manquant dans la reponse de creation de compte", createBody);
    }
  }

  let folderId = options.folderId || null;
  if (!folderId) {
    const accountResp = await http.get("https://api.gofile.io/accounts/website", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const accountBody = parseJsonLoose(accountResp.data);
    if (accountResp.status < 200 || accountResp.status >= 300 || accountBody?.status !== "ok") {
      throw makeErrorFromResponse("Gofile: lecture du compte impossible", accountResp, accountBody);
    }
    folderId = accountBody.data?.rootFolder || null;
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
    headers: form.getHeaders()
  });
  const uploadBody = parseJsonLoose(uploadResp.data);
  if (uploadResp.status >= 200 && uploadResp.status < 300 && uploadBody?.status === "ok") {
    return {
      url: uploadBody.data?.downloadPage || null,
      raw: uploadBody
    };
  }

  throw makeErrorFromResponse("Gofile: echec upload", uploadResp, uploadBody);
}

async function uploadTo1fichier(file, options = {}) {
  const serverResp = await http.post(
    "https://api.1fichier.com/v1/upload/get_upload_server.cgi",
    {},
    { headers: { "Content-Type": "application/json" } }
  );
  const serverBody = parseJsonLoose(serverResp.data);
  if (serverResp.status < 200 || serverResp.status >= 300 || !serverBody?.url || !serverBody?.id) {
    throw makeErrorFromResponse(
      "1fichier: impossible d'obtenir le serveur d'upload",
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
    maxRedirects: 0
  });

  if (uploadResp.status !== 302 && uploadResp.status !== 200) {
    throw makeErrorFromResponse("1fichier: upload refuse", uploadResp);
  }

  const reportResp = await http.get(`https://${uploadHost}/end.pl`, {
    params: { xid: uploadId },
    headers: { JSON: "1" }
  });
  const reportBody = parseJsonLoose(reportResp.data);
  const firstLink = reportBody?.links?.[0]?.download || null;

  if (reportResp.status >= 200 && reportResp.status < 300 && firstLink) {
    return {
      url: firstLink,
      raw: reportBody
    };
  }

  throw makeErrorFromResponse("1fichier: rapport de fin invalide", reportResp, reportBody);
}

async function uploadToRootzRegular(file, options = {}) {
  const form = new FormData();
  form.append("file", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype || "application/octet-stream"
  });
  if (options.folderId) {
    form.append("folderId", options.folderId);
  }

  const response = await http.post("https://rootz.so/api/files/upload", form, {
    headers: form.getHeaders()
  });
  const body = parseJsonLoose(response.data);

  const asksMultipart =
    response.status === 413 ||
    Boolean(body?.useMultipartUpload) ||
    (typeof body?.error === "string" && body.error.toLowerCase().includes("multipart"));

  if (asksMultipart) {
    throw new MultipartRequiredError("Rootz: upload multipart requis", body);
  }

  if (response.status >= 200 && response.status < 300 && body?.success) {
    const shortId = body.data?.shortId;
    const url = shortId ? `https://rootz.so/d/${shortId}` : body.data?.url;
    if (!url) {
      throw new UploadError("Rootz: lien manquant dans la reponse d'upload", body);
    }
    return { url, raw: body };
  }

  throw makeErrorFromResponse("Rootz: echec upload standard", response, body);
}

async function readChunk(fileHandle, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function uploadToRootzMultipart(file, options = {}) {
  const initResp = await http.post("https://rootz.so/api/files/multipart/init", {
    fileName: file.originalname,
    fileSize: file.size,
    fileType: file.mimetype || "application/octet-stream",
    folderId: options.folderId || null
  });
  const initBody = parseJsonLoose(initResp.data);
  if (initResp.status < 200 || initResp.status >= 300 || !initBody?.success) {
    throw makeErrorFromResponse("Rootz: init multipart impossible", initResp, initBody);
  }

  const uploadId = initBody.uploadId;
  const key = initBody.key;
  const chunkSize = Number(initBody.chunkSize);
  const totalParts = Number(initBody.totalParts);

  if (!uploadId || !key || !chunkSize || !totalParts) {
    throw new UploadError("Rootz: reponse init multipart incomplete", initBody);
  }

  const urlsResp = await http.post("https://rootz.so/api/files/multipart/batch-urls", {
    key,
    uploadId,
    totalParts,
    expiresIn: 7200
  });
  const urlsBody = parseJsonLoose(urlsResp.data);
  if (urlsResp.status < 200 || urlsResp.status >= 300 || !urlsBody?.success) {
    throw makeErrorFromResponse("Rootz: impossible d'obtenir les URLs de chunk", urlsResp, urlsBody);
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
        });
        const singleBody = parseJsonLoose(singleResp.data);
        if (singleResp.status < 200 || singleResp.status >= 300 || !singleBody?.success || !singleBody?.url) {
          throw makeErrorFromResponse(
            `Rootz: URL absente pour la partie ${partNumber}`,
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
        timeout: Math.max(HTTP_TIMEOUT_MS, 300_000)
      });
      if (putResp.status < 200 || putResp.status >= 300) {
        throw makeErrorFromResponse(`Rootz: upload chunk ${partNumber} echoue`, putResp);
      }

      const etagRaw = putResp.headers?.etag || putResp.headers?.ETag;
      if (!etagRaw) {
        throw new UploadError(`Rootz: ETag manquant pour la partie ${partNumber}`);
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
  });
  const completeBody = parseJsonLoose(completeResp.data);
  if (completeResp.status < 200 || completeResp.status >= 300 || !completeBody?.success) {
    throw makeErrorFromResponse("Rootz: finalisation multipart echouee", completeResp, completeBody);
  }

  const outFile = completeBody.file || completeBody.data || {};
  const url = outFile.shortId
    ? `https://rootz.so/d/${outFile.shortId}`
    : (outFile.downloadUrl || outFile.url || null);

  if (!url) {
    throw new UploadError("Rootz: lien absent apres completion multipart", completeBody);
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
  const uploadPageResp = await http.get("https://send.now/upload");
  if (uploadPageResp.status < 200 || uploadPageResp.status >= 300) {
    throw makeErrorFromResponse("Send.now: impossible de charger la page d'upload", uploadPageResp);
  }

  const parsedForm = extractSendNowForm(uploadPageResp.data);
  const actionAttr = parsedForm?.action || null;
  if (!actionAttr) {
    throw new UploadError("Send.now: action de formulaire introuvable");
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
    headers: form.getHeaders()
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

  throw makeErrorFromResponse("Send.now: reponse d'upload inattendue", uploadResp, payload);
}

async function uploadToFileditch(file) {
  const uploadWithName = async (filename, withExplicitMime = false) => {
    const form = new FormData();
    const fileOptions = { filename };
    if (withExplicitMime) {
      fileOptions.contentType = file.mimetype || "application/octet-stream";
    }
    form.append("files[]", fs.createReadStream(file.path), fileOptions);

    const response = await http.post("https://up1.fileditch.com/upload.php", form, {
      headers: form.getHeaders()
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
    throw makeErrorFromResponse("Fileditch: echec upload apres fallback extensions", lastFailure.response, lastFailure.body);
  }

  throw new UploadError("Fileditch: echec upload inconnu");
}

async function uploadToBuzzheavier(file, options = {}) {
  const locationId = options.locationId || "3eb9t1559lkv";
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
      }
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

  throw makeErrorFromResponse("Buzzheavier: echec upload", response, body);
}

async function uploadToRanoz(file) {
  const metaResp = await http.post("https://ranoz.gg/api/v1/files/upload_url", {
    filename: file.originalname,
    size: file.size
  }, {
    headers: { "Content-Type": "application/json" }
  });
  const metaBody = parseJsonLoose(metaResp.data);
  const uploadUrl = metaBody?.data?.upload_url;
  const shareUrl = metaBody?.data?.url;

  if (metaResp.status < 200 || metaResp.status >= 300 || !uploadUrl) {
    throw makeErrorFromResponse("Ranoz: impossible d'obtenir l'URL signee", metaResp, metaBody);
  }

  const putResp = await http.put(uploadUrl, fs.createReadStream(file.path), {
    headers: {
      "Content-Type": file.mimetype || "application/octet-stream",
      "Content-Length": String(file.size)
    }
  });

  if (putResp.status >= 200 && putResp.status < 300) {
    return {
      url: shareUrl || null,
      raw: metaBody
    };
  }

  throw makeErrorFromResponse("Ranoz: echec de l'upload du contenu", putResp);
}

async function uploadToTarget(target, file, options = {}) {
  const normalized = normalizeTarget(target);
  if (!normalized) {
    throw new UploadError(`Cible inconnue: ${target}`);
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
    default:
      throw new UploadError(`Cible non supportee: ${target}`);
  }
}

module.exports = {
  UploadError,
  supportedTargets,
  normalizeTarget,
  uploadToTarget
};
