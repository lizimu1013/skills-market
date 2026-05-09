const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DATA_FILE = path.join(ROOT, "data", "skills.json");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip"
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sanitizeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 200);
}

function sanitizeFileName(name) {
  const baseName = path.basename(String(name || "skill.zip"));
  return baseName.replace(/[^\w.\- ()@+]/g, "_").slice(0, 120) || "skill.zip";
}

function contentDispositionName(name) {
  return sanitizeFileName(name).replace(/"/g, "");
}

function findEndOfCentralDirectory(buffer) {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function parseZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset === -1) return [];

  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries.filter((entry) => entry.name && !entry.name.endsWith("/") && !entry.name.includes("__MACOSX/"));
}

function readStoredZipEntry(buffer, entry) {
  if (entry.uncompressedSize > 1024 * 1024) return "";
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return zlib.inflateRawSync(data).toString("utf8");
  return "";
}

function buildFileTree(files) {
  const root = [];
  const dirs = new Map();

  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    let level = root;
    let currentPath = "";

    parts.slice(0, -1).forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!dirs.has(currentPath)) {
        const node = { name: part, path: currentPath, relativePath: currentPath, type: "dir", size: 0, children: [] };
        dirs.set(currentPath, node);
        level.push(node);
      }
      const dirNode = dirs.get(currentPath);
      level = dirNode.children;
    });

    level.push({
      name: parts.at(-1) || file.name,
      path: file.path,
      relativePath: file.path,
      type: "file",
      size: file.size,
      isSkillFile: file.isSkillFile
    });
  });

  return root;
}

function extractSkillDetail(file) {
  const ext = path.extname(file.filename).toLowerCase();
  const files = [];
  let markdown = "";

  if (ext === ".md") {
    markdown = file.buffer.toString("utf8");
    files.push({
      name: file.filename,
      path: file.filename,
      relativePath: file.filename,
      type: "file",
      size: file.buffer.length,
      isSkillFile: true
    });
  } else if (ext === ".zip") {
    const entries = parseZipEntries(file.buffer);
    entries.forEach((entry) => {
      const normalized = entry.name.replace(/^\.?\//, "");
      const isSkillFile = /(^|\/)SKILL\.md$/i.test(normalized);
      if (isSkillFile) {
        markdown = readStoredZipEntry(file.buffer, entry);
      }
      files.push({
        name: path.basename(normalized),
        path: normalized,
        relativePath: normalized,
        type: "file",
        size: entry.uncompressedSize,
        isSkillFile
      });
    });
  } else {
    files.push({
      name: file.filename,
      path: file.filename,
      relativePath: file.filename,
      type: "file",
      size: file.buffer.length,
      isSkillFile: false
    });
  }

  const skillFile = files.find((item) => item.isSkillFile) || null;
  return {
    files,
    tree: buildFileTree(files),
    skillFile,
    markdown: markdown.slice(0, 400000)
  };
}

async function ensureStorage() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await fsp.writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readSkills() {
  await ensureStorage();
  const raw = await fsp.readFile(DATA_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSkills(skills) {
  await fsp.writeFile(DATA_FILE, `${JSON.stringify(skills, null, 2)}\n`, "utf8");
}

function parseMultipart(req, contentType) {
  return new Promise((resolve, reject) => {
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
    if (!boundaryMatch) {
      reject(new Error("Missing multipart boundary"));
      return;
    }

    const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("Upload is larger than 20MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const fields = {};
        let file = null;
        const parts = buffer.toString("binary").split(boundary);

        for (const part of parts) {
          if (!part || part === "--\r\n" || part === "--") continue;
          const cleanPart = part.startsWith("\r\n") ? part.slice(2) : part;
          const headerEnd = cleanPart.indexOf("\r\n\r\n");
          if (headerEnd === -1) continue;

          const rawHeaders = cleanPart.slice(0, headerEnd);
          let rawBody = cleanPart.slice(headerEnd + 4);
          if (rawBody.endsWith("\r\n")) rawBody = rawBody.slice(0, -2);
          if (rawBody.endsWith("--")) rawBody = rawBody.slice(0, -2);

          const nameMatch = /name="([^"]+)"/.exec(rawHeaders);
          if (!nameMatch) continue;

          const fieldName = nameMatch[1];
          const filenameMatch = /filename="([^"]*)"/.exec(rawHeaders);
          if (filenameMatch) {
            const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
            file = {
              fieldName,
              filename: sanitizeFileName(filenameMatch[1]),
              contentType: sanitizeText(contentTypeMatch?.[1], "application/octet-stream"),
              buffer: Buffer.from(rawBody, "binary")
            };
          } else {
            fields[fieldName] = Buffer.from(rawBody, "binary").toString("utf8").trim();
          }
        }

        resolve({ fields, file });
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function handleUpload(req, res) {
  try {
    const { fields, file } = await parseMultipart(req, req.headers["content-type"]);
    if (!file || !file.buffer.length) {
      sendError(res, 400, "Please choose a skill package to upload.");
      return;
    }

    const title = sanitizeText(fields.title);
    if (!title) {
      sendError(res, 400, "Skill name is required.");
      return;
    }

    const id = crypto.randomUUID();
    const storedName = `${id}-${file.filename}`;
    const storedPath = path.join(UPLOAD_DIR, storedName);
    await fsp.writeFile(storedPath, file.buffer);
    const detail = extractSkillDetail(file);
    const description = sanitizeText(fields.description, detail.markdown.split("\n").find((line) => line.trim() && !line.startsWith("---")) || "No README supplied yet.");

    const skill = {
      id,
      title,
      description,
      author: sanitizeText(fields.author, "anonymous"),
      category: sanitizeText(fields.category, "General"),
      version: sanitizeText(fields.version, "v0.1.0"),
      tags: sanitizeText(fields.tags)
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8),
      filename: file.filename,
      storedName,
      contentType: file.contentType,
      size: file.buffer.length,
      files: detail.files,
      tree: detail.tree,
      skillFile: detail.skillFile,
      markdown: detail.markdown,
      downloads: 0,
      createdAt: new Date().toISOString()
    };

    const skills = await readSkills();
    skills.unshift(skill);
    await writeSkills(skills);
    sendJson(res, 201, { skill });
  } catch (error) {
    if (error.message.includes("larger than")) {
      sendError(res, 413, error.message);
      return;
    }
    sendError(res, 400, "Upload failed. Please send multipart form data.");
  }
}

async function handleListSkills(res) {
  const skills = await readSkills();
  sendJson(res, 200, {
    skills: skills.map(({ storedName, markdown, tree, files, skillFile, ...skill }) => skill)
  });
}

async function handleGetSkill(res, id) {
  const skills = await readSkills();
  const skill = skills.find((item) => item.id === id);
  if (!skill) {
    sendError(res, 404, "Skill not found.");
    return;
  }

  sendJson(res, 200, {
    skill: {
      ...skill,
      storedName: undefined,
      markdown: undefined,
      tree: undefined,
      files: undefined,
      skillFile: undefined
    },
    files: skill.files || [],
    tree: skill.tree || [],
    skillFile: skill.skillFile || null,
    markdown: skill.markdown || ""
  });
}

async function handleDownload(res, id) {
  const skills = await readSkills();
  const skill = skills.find((item) => item.id === id);
  if (!skill) {
    sendError(res, 404, "Skill not found.");
    return;
  }

  const filePath = path.join(UPLOAD_DIR, skill.storedName);
  try {
    await fsp.access(filePath);
  } catch {
    sendError(res, 410, "The uploaded package is missing.");
    return;
  }

  skill.downloads = Number(skill.downloads || 0) + 1;
  await writeSkills(skills);

  res.writeHead(200, {
    "Content-Type": skill.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${contentDispositionName(skill.filename)}"`
  });
  fs.createReadStream(filePath).pipe(res);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!requested.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(requested);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(requested).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(requested).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if ((req.method === "GET" || req.method === "HEAD") && /^\/skills\/[^/]+\/?$/.test(url.pathname)) {
    req.url = "/index.html";
    await serveStatic(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
    await serveStatic(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    await handleListSkills(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills") {
    await handleUpload(req, res);
    return;
  }

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && skillMatch) {
    await handleGetSkill(res, skillMatch[1]);
    return;
  }

  const downloadMatch = /^\/api\/skills\/([^/]+)\/download$/.exec(url.pathname);
  if (req.method === "GET" && downloadMatch) {
    await handleDownload(res, downloadMatch[1]);
    return;
  }

  sendError(res, 404, "Route not found.");
}

ensureStorage().then(() => {
  http
    .createServer((req, res) => {
      route(req, res).catch((error) => {
        console.error(error);
        sendError(res, 500, "Internal server error.");
      });
    })
    .listen(PORT, () => {
      console.log(`SkillsMP clone running at http://localhost:${PORT}`);
    });
});
