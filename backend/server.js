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
const fontkit = require("@pdf-lib/fontkit");
const { parse } = require("csv-parse/sync");

const app = express();

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const FONT_PATH = path.join(ROOT_DIR, "NotoSansJP-Regular.ttf");

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
  const size = Number(value || 120);
  if (!Number.isFinite(size) || size < 16 || size > 2000) {
    throw new Error("qrSize は 16〜2000 の数値で指定してください");
  }
  return Math.round(size);
}

function truncateText(value, maxLen = 20) {
  const text = String(value || "").trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function parseCsvRows(csvBuffer) {
  const rows = parse(csvBuffer, {
    skip_empty_lines: true,
    bom: true
  });

  const normalized = [];
  for (let idx = 0; idx < rows.length; idx += 1) {
    // 1行目はヘッダーとしてスキップ
    if (idx === 0) continue;

    const row = rows[idx];
    if (!Array.isArray(row) || row.length < 5) continue;

    const id = String(row[0] || "").trim();
    if (!id) continue;

    normalized.push({
      id,
      text1: truncateText(row[1], 20),
      text2: truncateText(row[4], 20)
    });

    if (normalized.length > MAX_IDS) {
      throw new Error(`CSV件数が多すぎます。上限は ${MAX_IDS} 件です`);
    }
  }

  return normalized;
}

async function overlayQrAndTextOnPdf({ templatePdfPath, qrPath, outputPdfPath, qrSize, text1, text2 }) {
  const pdfBytes = await fsp.readFile(templatePdfPath);
  const qrBytes = await fsp.readFile(qrPath);
  const fontBytes = fs.readFileSync(FONT_PATH);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes);
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error("入力PDFにページがありません");
  }

  const page = pages[0];
  const { width, height } = page.getSize();
  const image = await pdfDoc.embedPng(qrBytes);

  const drawSize = Math.min(Number(qrSize || 120), width, height);
  const centerX = width / 2;
  const centerY = height / 2;

  const qrX = centerX - drawSize / 2;
  const qrY = centerY - drawSize / 2;
  const text1Y = qrY + drawSize + 25;
  const text2Y = qrY + drawSize + 10;

  const textSize = 12;

  page.drawText(text1, {
    x: centerX - font.widthOfTextAtSize(text1, textSize) / 2,
    y: text1Y,
    size: textSize,
    font
  });

  page.drawText(text2, {
    x: centerX - font.widthOfTextAtSize(text2, textSize) / 2,
    y: text2Y,
    size: textSize,
    font
  });

  page.drawImage(image, {
    x: qrX,
    y: qrY,
    width: drawSize,
    height: drawSize
  });

  const outputBytes = await pdfDoc.save();
  await fsp.writeFile(outputPdfPath, outputBytes);
}

function verifyUploadExtension(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return ext === ".pdf" || ext === ".csv";
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

async function runPdfOverlayJob({ templatePdfPath, qrPath, outputPdfPath, qrSize, text1, text2 }) {
  await overlayQrAndTextOnPdf({
    templatePdfPath,
    qrPath,
    outputPdfPath,
    qrSize,
    text1,
    text2
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

app.post("/generate", authMiddleware, upload.fields([{ name: "csvFile", maxCount: 1 }, { name: "pdfFile", maxCount: 1 }]), async (req, res) => {
  let jobDir;
  let csvUploadedPath;
  let pdfUploadedPath;

  try {
    if (!fs.existsSync(FONT_PATH)) {
      throw new Error("日本語フォントファイル NotoSansJP-Regular.ttf が backend フォルダにありません");
    }

    const fontStat = await fsp.stat(FONT_PATH);
    if (!fontStat.size) {
      throw new Error("日本語フォントファイル NotoSansJP-Regular.ttf が空です。実ファイルを配置してください");
    }

    const csvFile = req.files?.csvFile?.[0];
    const pdfFile = req.files?.pdfFile?.[0];

    if (!csvFile) {
      res.status(400).json({ error: "CSVファイル（.csv）を指定してください" });
      return;
    }

    if (!pdfFile) {
      res.status(400).json({ error: "テンプレート PDF ファイル（.pdf）を指定してください" });
      return;
    }

    csvUploadedPath = csvFile.path;
    pdfUploadedPath = pdfFile.path;

    if (!String(csvFile.originalname || "").toLowerCase().endsWith(".csv")) {
      throw new Error("CSVファイルの拡張子が不正です。.csv のみ許可されています");
    }

    if (!String(pdfFile.originalname || "").toLowerCase().endsWith(".pdf")) {
      throw new Error("PDFファイルの拡張子が不正です。.pdf のみ許可されています");
    }

    const baseURL = normalizeBaseUrl(req.body.baseURL);
    const qrSize = parseQrSize(req.body.qrSize);

    const csvBuffer = await fsp.readFile(csvUploadedPath);
    const rows = parseCsvRows(csvBuffer);
    if (rows.length === 0) {
      throw new Error("有効なCSV行がありませんでした");
    }

    jobDir = path.join(TEMP_DIR, sanitizeFilename(`job-${Date.now()}-${crypto.randomUUID()}`));
    const qrDir = path.join(jobDir, "qr");
    const outDir = path.join(jobDir, "output");

    await fsp.mkdir(qrDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    const generated = await Promise.all(
      rows.map(async ({ id, text1, text2 }) => {
        const url = `${baseURL}${id}`;
        const safeId = sanitizeFilename(id);

        const qrPath = path.join(qrDir, `qr_${safeId}.png`);
        await QRCode.toFile(qrPath, url, {
          width: qrSize,
          margin: 1
        });

        const outputPdfPath = path.join(outDir, `output_${safeId}.pdf`);

        await runPdfOverlayJob({
          templatePdfPath: pdfUploadedPath,
          qrPath,
          outputPdfPath,
          qrSize,
          text1,
          text2
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
    await removePathSafe(csvUploadedPath);
    await removePathSafe(pdfUploadedPath);
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
