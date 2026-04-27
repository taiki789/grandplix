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

const IS_VERCEL = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const RUNTIME_DIR = IS_VERCEL ? path.join("/tmp", "grandplix") : __dirname;

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(RUNTIME_DIR, "uploads");
const TEMP_DIR = path.join(RUNTIME_DIR, "temp");
const OUTPUT_DIR = path.join(RUNTIME_DIR, "output");
const FONT_FILE_NAME = "NotoSansJP-Regular.ttf";
const JOB_CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY || 4));
const JOB_TTL_MS = Math.max(60_000, Number(process.env.JOB_TTL_MS || 10 * 60 * 1000));
const DEFAULT_PLACEMENT_X = 1;
const DEFAULT_PLACEMENT_Y = 2;

const MAX_IDS = 500;
const jobs = new Map();

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

function decodeServiceAccountJson(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Allow base64-encoded JSON for safer Vercel env storage.
    try {
      const decoded = Buffer.from(String(raw), "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
}

function normalizePrivateKey(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return trimmed.replace(/\\n/g, "\n");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("BEGIN PRIVATE KEY")) {
      return decoded.replace(/\\n/g, "\n");
    }
  } catch {
    // Ignore base64 parse errors.
  }

  return "";
}

function buildServiceAccountFromEnv() {
  const jsonAccount = decodeServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (jsonAccount) return jsonAccount;

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY_BASE64);

  if (projectId && clientEmail && privateKey) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey
    };
  }

  return null;
}

function initFirebaseAdmin() {
  if (firebaseInitialized) return;

  const serviceAccount = buildServiceAccountFromEnv();
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (serviceAccount) {
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

function safeNowIso() {
  return new Date().toISOString();
}

function createJobRecord({ jobId, baseURL, qrSize, placementX, placementY, csvUploadedPath, pdfUploadedPath }) {
  const jobDir = path.join(TEMP_DIR, sanitizeFilename(`job-${jobId}`));
  const outDir = path.join(jobDir, "output");
  const zipPath = path.join(jobDir, `qr_outputs_${jobId}.zip`);
  return {
    id: jobId,
    state: "queued",
    message: "ジョブを作成しました",
    error: null,
    baseURL,
    qrSize,
    placementX,
    placementY,
    csvUploadedPath,
    pdfUploadedPath,
    jobDir,
    outDir,
    zipPath,
    total: 0,
    processed: 0,
    failed: 0,
    startedAt: Date.now(),
    finishedAt: null,
    createdAt: safeNowIso()
  };
}

function computeProgress(job) {
  const total = Number(job.total || 0);
  const processed = Number(job.processed || 0);
  const elapsedSecondsRaw = (Date.now() - Number(job.startedAt || Date.now())) / 1000;
  const elapsedSeconds = Math.max(0, Math.round(elapsedSecondsRaw));

  let progressPercent = 0;
  if (total > 0) {
    progressPercent = Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
  }

  let etaSeconds = null;
  if (job.state === "running" && processed > 0 && total > processed) {
    const avgPerItem = elapsedSecondsRaw / processed;
    etaSeconds = Math.max(0, Math.round(avgPerItem * (total - processed)));
  }

  return {
    progressPercent,
    elapsedSeconds,
    etaSeconds
  };
}

function scheduleJobCleanup(jobId) {
  setTimeout(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    await removePathSafe(job.jobDir);
    await removePathSafe(job.csvUploadedPath);
    await removePathSafe(job.pdfUploadedPath);
    jobs.delete(jobId);
  }, JOB_TTL_MS);
}

async function runWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function consume() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) break;
      await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => consume()));
}

function parseQrSize(value) {
  const size = Number(value || 120);
  if (!Number.isFinite(size) || size < 16 || size > 2000) {
    throw new Error("qrSize は 16〜2000 の数値で指定してください");
  }
  return Math.round(size);
}

function parsePlacementX(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_PLACEMENT_X), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2) {
    throw new Error("placementX は 0〜2 の整数で指定してください");
  }
  return parsed;
}

function parsePlacementY(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_PLACEMENT_Y), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new Error("placementY は 0〜4 の整数で指定してください");
  }
  return parsed;
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

async function ensureFontReady() {
  const cwd = process.cwd();
  const envFontPath = String(process.env.FONT_PATH || "").trim();
  const candidates = [
    envFontPath,
    path.join(ROOT_DIR, FONT_FILE_NAME),
    path.join(cwd, "backend", FONT_FILE_NAME),
    path.join(cwd, "..", "backend", FONT_FILE_NAME),
    path.join("/var/task/backend", FONT_FILE_NAME),
    path.join("/var/task", FONT_FILE_NAME)
  ].filter(Boolean);

  const foundPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!foundPath) {
    throw new Error(`日本語フォントファイル ${FONT_FILE_NAME} が見つかりません。候補: ${candidates.join(" | ")}`);
  }

  const fontStat = await fsp.stat(foundPath);
  if (!fontStat.size) {
    throw new Error(`日本語フォントファイル ${FONT_FILE_NAME} が空です。実ファイルを配置してください`);
  }

  return foundPath;
}

function resolveBlockPosition({ placementX, placementY, pageWidth, pageHeight, blockWidth, blockHeight, margin = 24 }) {
  const maxX = Math.max(margin, pageWidth - margin - blockWidth);
  const maxY = Math.max(margin, pageHeight - margin - blockHeight);
  const spanX = Math.max(0, maxX - margin);
  const spanY = Math.max(0, maxY - margin);

  const normalizedX = Number.isInteger(placementX) ? placementX : DEFAULT_PLACEMENT_X;
  const normalizedY = Number.isInteger(placementY) ? placementY : DEFAULT_PLACEMENT_Y;

  const x = margin + (spanX * (normalizedX / 2));
  const y = margin + (spanY * ((4 - normalizedY) / 4));

  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY))
  };
}

function drawCenteredTextBold(page, font, text, fontSize, centerX, y) {
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const x = centerX - textWidth / 2;

  page.drawText(text, { x, y, size: fontSize, font });
  page.drawText(text, { x: x + 0.5, y, size: fontSize, font });
}

async function overlayQrAndTextOnPdf({ templatePdfBytes, qrBytes, qrSize, text1, text2, placementX, placementY, fontBytes }) {
  const pdfDoc = await PDFDocument.load(templatePdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes);
  const pages = pdfDoc.getPages();

  if (pages.length === 0) {
    throw new Error("入力PDFにページがありません");
  }

  const page = pages[0];
  const { width, height } = page.getSize();
  const image = await pdfDoc.embedPng(qrBytes);

  const textSize = 18;
  const textGap = 6;
  const qrGap = 10;

  const rawDrawSize = Number(qrSize || 120);
  const drawSize = Math.min(rawDrawSize, width - 48, height - 48);

  const text1Width = font.widthOfTextAtSize(text1, textSize);
  const text2Width = font.widthOfTextAtSize(text2, textSize);
  const blockWidth = Math.max(drawSize, text1Width, text2Width);
  const lineHeight = textSize + textGap;
  const blockHeight = drawSize + qrGap + (lineHeight * 2);

  const blockPos = resolveBlockPosition({
    placementX,
    placementY,
    pageWidth: width,
    pageHeight: height,
    blockWidth,
    blockHeight,
    margin: 24
  });

  const centerX = blockPos.x + (blockWidth / 2);
  const qrX = blockPos.x + (blockWidth - drawSize) / 2;
  const qrY = blockPos.y;
  const text2Y = qrY + drawSize + qrGap;
  const text1Y = text2Y + lineHeight;

  drawCenteredTextBold(page, font, text1, textSize, centerX, text1Y);
  drawCenteredTextBold(page, font, text2, textSize, centerX, text2Y);

  page.drawImage(image, {
    x: qrX,
    y: qrY,
    width: drawSize,
    height: drawSize
  });

  return pdfDoc.save();
}

function verifyUploadExtension(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  return ext === ".pdf" || ext === ".csv";
}

function createUploadStorage() {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = ext === ".pdf" || ext === ".csv" ? ext : "";
      cb(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
    }
  });
}

const upload = multer({
  storage: createUploadStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!verifyUploadExtension(file)) {
      cb(new Error(".pdf / .csv ファイルのみアップロード可能です"));
      return;
    }
    cb(null, true);
  }
});

function buildStatusResponse(job) {
  const timing = computeProgress(job);
  return {
    jobId: job.id,
    state: job.state,
    message: job.message,
    error: job.error,
    total: job.total,
    processed: job.processed,
    failed: job.failed,
    progressPercent: timing.progressPercent,
    elapsedSeconds: timing.elapsedSeconds,
    etaSeconds: timing.etaSeconds,
    downloadReady: job.state === "completed",
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}

async function createZipFromOutputDir({ outDir, zipPath }) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(outDir, false);
    archive.finalize();
  });
}

async function runGenerateJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    const fontPath = await ensureFontReady();

    job.state = "running";
    job.message = "CSVを解析しています";

    const [csvBuffer, templatePdfBytes, fontBytes] = await Promise.all([
      fsp.readFile(job.csvUploadedPath),
      fsp.readFile(job.pdfUploadedPath),
      fsp.readFile(fontPath)
    ]);

    const rows = parseCsvRows(csvBuffer);
    if (rows.length === 0) {
      throw new Error("有効なCSV行がありませんでした");
    }

    job.total = rows.length;
    job.message = "PDFを生成しています";

    await fsp.mkdir(job.outDir, { recursive: true });

    await runWithConcurrency(rows, JOB_CONCURRENCY, async ({ id, text1, text2 }) => {
      const url = `${job.baseURL}${id}`;
      const safeId = sanitizeFilename(id);

      const qrBytes = await QRCode.toBuffer(url, {
        type: "png",
        width: job.qrSize,
        margin: 1
      });

      const outputBytes = await overlayQrAndTextOnPdf({
        templatePdfBytes,
        qrBytes,
        qrSize: job.qrSize,
        text1,
        text2,
        placementX: job.placementX,
        placementY: job.placementY,
        fontBytes
      });

      const outputPdfPath = path.join(job.outDir, `output_${safeId}.pdf`);
      await fsp.writeFile(outputPdfPath, outputBytes);
      job.processed += 1;
    });

    if (job.processed === 0) {
      throw new Error("出力ファイルが生成されませんでした");
    }

    job.message = "ZIPを作成しています";
    await createZipFromOutputDir({ outDir: job.outDir, zipPath: job.zipPath });

    job.state = "completed";
    job.message = "生成が完了しました";
    job.finishedAt = safeNowIso();
  } catch (error) {
    job.state = "failed";
    job.error = error.message || "出力生成に失敗しました";
    job.message = "生成に失敗しました";
    job.finishedAt = safeNowIso();
  } finally {
    await removePathSafe(job.csvUploadedPath);
    await removePathSafe(job.pdfUploadedPath);
    scheduleJobCleanup(jobId);
  }
}

async function authMiddleware(req, res, next) {
  try {
    if (!firebaseInitialized) {
      res.status(500).json({
        error: "サーバー側のFirebase Admin設定が不足しています",
        detail: "FIREBASE_SERVICE_ACCOUNT_JSON もしくは FIREBASE_PROJECT_ID（または NEXT_PUBLIC_FIREBASE_PROJECT_ID）を設定してください"
      });
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

app.post("/generate/jobs", authMiddleware, upload.fields([{ name: "csvFile", maxCount: 1 }, { name: "pdfFile", maxCount: 1 }]), async (req, res) => {
  let csvUploadedPath;
  let pdfUploadedPath;

  try {
    const csvFile = req.files?.csvFile?.[0];
    const pdfFile = req.files?.pdfFile?.[0];

    if (!csvFile) {
      res.status(400).json({ error: "CSVファイル（.csv）を指定してください" });
      return;
    }

    if (!pdfFile) {
      await removePathSafe(csvFile.path);
      res.status(400).json({ error: "テンプレート PDF ファイル（.pdf）を指定してください" });
      return;
    }

    try {
      await ensureFontReady();
    } catch (error) {
      await removePathSafe(csvFile.path);
      await removePathSafe(pdfFile.path);
      res.status(500).json({ error: error.message || "日本語フォントファイルの読み込みに失敗しました" });
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
    const placementX = parsePlacementX(req.body.placementX);
    const placementY = parsePlacementY(req.body.placementY);

    const jobId = `${Date.now()}-${crypto.randomUUID()}`;
    const job = createJobRecord({
      jobId,
      baseURL,
      qrSize,
      placementX,
      placementY,
      csvUploadedPath,
      pdfUploadedPath
    });
    jobs.set(jobId, job);

    runGenerateJob(jobId);

    res.status(202).json({
      jobId,
      message: "生成ジョブを開始しました"
    });
  } catch (error) {
    await removePathSafe(csvUploadedPath);
    await removePathSafe(pdfUploadedPath);
    res.status(400).json({ error: error.message || "ジョブ開始に失敗しました" });
  }
});

app.get("/generate/jobs/:jobId/status", authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "ジョブが見つかりません。期限切れの可能性があります" });
    return;
  }

  res.json(buildStatusResponse(job));
});

app.get("/generate/jobs/:jobId/download", authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "ジョブが見つかりません。期限切れの可能性があります" });
    return;
  }

  if (job.state !== "completed") {
    res.status(409).json({ error: "まだ生成が完了していません" });
    return;
  }

  const zipExists = fs.existsSync(job.zipPath);
  if (!zipExists) {
    res.status(404).json({ error: "ZIPファイルが見つかりません" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=qr_outputs_${jobId}.zip`);
  const stream = fs.createReadStream(job.zipPath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "ZIPファイルの読み込みに失敗しました" });
    }
  });
  stream.pipe(res);
});

app.post("/generate", authMiddleware, (_req, res) => {
  res.status(410).json({ error: "このエンドポイントは廃止されました。/generate/jobs を使用してください" });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error.message || "リクエスト処理に失敗しました" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
