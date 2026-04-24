const express = require("express");
const cors = require("cors");
const multer = require("multer");
const QRCode = require("qrcode");
const archiver = require("archiver");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const sanitizeFilename = require("sanitize-filename");
const admin = require("firebase-admin");
const { PDFDocument } = require("pdf-lib");

const app = express();

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");

const MAX_IDS = 500;

app.use(cors({ origin: FRONTEND_ORIGIN }));

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDirSync(UPLOAD_DIR);
ensureDirSync(TEMP_DIR);
ensureDirSync(OUTPUT_DIR);

let firebaseInitialized = false;

function initFirebaseAdmin() {
  if (firebaseInitialized) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (json) {
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
    firebaseInitialized = true;
    return;
  }

  // For ID token verification, projectId-only initialization can be enough in local/dev.
  if (projectId) {
    admin.initializeApp({ projectId });
    firebaseInitialized = true;
  }
}

try {
  initFirebaseAdmin();
} catch (error) {
  console.warn("Firebase Adminの初期化をスキップしました:", error.message);
}

function parseIds(idsInput) {
  const raw = String(idsInput || "").trim();
  if (!raw) throw new Error("ids は必須です");

  const set = new Set();
  const chunks = raw.split(",").map((item) => item.trim()).filter(Boolean);

  for (const chunk of chunks) {
    if (/^\d+-\d+$/.test(chunk)) {
      const [startRaw, endRaw] = chunk.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);

      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`範囲指定が不正です: ${chunk}`);
      }

      const min = Math.min(start, end);
      const max = Math.max(start, end);

      for (let value = min; value <= max; value += 1) {
        if (value < 0) throw new Error("IDは0以上で指定してください");
        set.add(value);
        if (set.size > MAX_IDS) {
          throw new Error(`ID数が多すぎます。上限は ${MAX_IDS} 件です`);
        }
      }
      continue;
    }

    if (!/^\d+$/.test(chunk)) {
      throw new Error(`ID形式が不正です: ${chunk}`);
    }

    const value = Number(chunk);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`ID値が不正です: ${chunk}`);
    }

    set.add(value);
    if (set.size > MAX_IDS) {
      throw new Error(`ID数が多すぎます。上限は ${MAX_IDS} 件です`);
    }
  }

  return Array.from(set).sort((a, b) => a - b);
}

function normalizeBaseUrl(baseURL) {
  const trimmed = String(baseURL || "").trim();
  if (!trimmed) {
    throw new Error("baseURL は必須です");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("baseURL の形式が不正です");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("baseURL は http:// または https:// で始めてください");
  }

  return parsed.toString().endsWith("/") ? parsed.toString() : `${parsed.toString()}/`;
}

async function removePathSafe(targetPath) {
  if (!targetPath) return;
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

function parseQrSize(value) {
  const size = Number(value || 150);
  if (!Number.isFinite(size) || size < 16 || size > 2000) {
    throw new Error("qrSize は 16〜2000 の数値で指定してください");
  }
  return Math.round(size);
}

const QR_POSITIONS = new Set([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right"
]);

function parseQrPosition(value) {
  const position = String(value || "center").trim().toLowerCase();
  if (!QR_POSITIONS.has(position)) {
    throw new Error("qrPosition が不正です");
  }
  return position;
}

function resolveQrCoordinates({ pageWidth, pageHeight, drawSize, qrPosition }) {
  const margin = 20; // 余白（px）
  const right = pageWidth - drawSize - margin;
  const bottom = drawSize + margin;
  const top = pageHeight - drawSize - margin;
  const centerX = (pageWidth - drawSize) / 2;
  const centerY = (pageHeight - drawSize) / 2;

  switch (qrPosition) {
    case "top-left":
      return { x: margin, y: top };
    case "top-center":
      return { x: centerX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "center-left":
      return { x: margin, y: centerY };
    case "center-right":
      return { x: right, y: centerY };
    case "bottom-left":
      return { x: margin, y: bottom };
    case "bottom-center":
      return { x: centerX, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    case "center":
    default:
      return { x: centerX, y: centerY };
  }
}

async function overlayQrOnPdf({ templatePdfPath, qrPath, outputPdfPath, qrSize, qrPosition }) {
  const pdfBytes = await fsp.readFile(templatePdfPath);
  const qrBytes = await fsp.readFile(qrPath);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error("入力PDFにページがありません");
  }

  const page = pages[0];
  const { width, height } = page.getSize();
  const image = await pdfDoc.embedPng(qrBytes);

  const drawSize = Math.min(Number(qrSize || 150), width, height);
  const { x, y } = resolveQrCoordinates({
    pageWidth: width,
    pageHeight: height,
    drawSize,
    qrPosition
  });

  console.log(`[QR Overlay] position=${qrPosition}, size=${drawSize}, page=${width}x${height}, coordinates=${x},${y}`);

  page.drawImage(image, {
    x,
    y,
    width: drawSize,
    height: drawSize
  });

  const outputBytes = await pdfDoc.save();
  await fsp.writeFile(outputPdfPath, outputBytes);
}

function verifyUploadExtension(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return ext === ".pdf";
}

function createUploadStorage() {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".pdf";
      const safeExt = ext === ".pdf" ? ".pdf" : "";
      cb(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
    }
  });
}

const upload = multer({
  storage: createUploadStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!verifyUploadExtension(file)) {
      cb(new Error(".pdf ファイルのみアップロード可能です"));
      return;
    }
    cb(null, true);
  }
});

async function runPdfOverlayJob({ templatePdfPath, qrPath, outputPdfPath, qrSize, qrPosition }) {
  await overlayQrOnPdf({
    templatePdfPath,
    qrPath,
    outputPdfPath,
    qrSize,
    qrPosition
  });
}

async function authMiddleware(req, res, next) {
  try {
    if (!firebaseInitialized) {
      res.status(500).json({ error: "サーバー側のFirebase Admin設定が不足しています" });
      return;
    }

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (!token) {
      res.status(401).json({ error: "認証トークンがありません" });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "認証に失敗しました", detail: error.message });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/generate", authMiddleware, upload.single("file"), async (req, res) => {
  let jobDir;
  let uploadedPath;

  try {
    if (!req.file) {
      res.status(400).json({ error: "テンプレート PDF ファイルを指定してください" });
      return;
    }

    uploadedPath = req.file.path;
    if (!verifyUploadExtension(req.file)) {
      throw new Error("拡張子が不正です。.pdf ファイルのみ許可されています");
    }

    const baseURL = normalizeBaseUrl(req.body.baseURL);
    const ids = parseIds(req.body.ids);
    const qrSize = parseQrSize(req.body.qrSize);
    const qrPosition = parseQrPosition(req.body.qrPosition);
    jobDir = path.join(TEMP_DIR, sanitizeFilename(`job-${Date.now()}-${crypto.randomUUID()}`));
    const qrDir = path.join(jobDir, "qr");
    const outDir = path.join(jobDir, "output");

    await fsp.mkdir(qrDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    const generated = await Promise.all(
      ids.map(async (idValue) => {
        const id = String(idValue);
        const url = `${baseURL}${id}/`;
        const safeId = sanitizeFilename(id);

        const qrPath = path.join(qrDir, `qr_${safeId}.png`);
        await QRCode.toFile(qrPath, url, {
          width: qrSize,
          margin: 1
        });

        const outputPdfPath = path.join(outDir, `output_${safeId}.pdf`);

        await runPdfOverlayJob({
          templatePdfPath: uploadedPath,
          qrPath,
          outputPdfPath,
          qrSize,
          qrPosition
        });

        return [{ absPath: outputPdfPath, zipName: `output_${safeId}.pdf` }];
      })
    );

    const flattened = generated.flat();
    if (flattened.length === 0) {
      throw new Error("出力ファイルが生成されませんでした");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=qr_outputs_${Date.now()}.zip`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (archiveError) => {
      throw archiveError;
    });
    archive.pipe(res);

    for (const file of flattened) {
      archive.file(file.absPath, { name: file.zipName });
    }

    await archive.finalize();
  } catch (error) {
    if (!res.headersSent) {
      res.status(400).json({ error: error.message || "出力生成に失敗しました" });
    }
  } finally {
    await removePathSafe(jobDir);
    await removePathSafe(uploadedPath);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error.message || "リクエスト処理に失敗しました" });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
