"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

function resolveApiUrl() {
  const configured = String(process.env.NEXT_PUBLIC_API_URL || "").trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!configured) {
    return isProduction ? "/api" : "http://localhost:4000";
  }

  if (isProduction && /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(configured)) {
    return "/api";
  }

  return configured.replace(/\/$/, "");
}

const API_URL = resolveApiUrl();
const HORIZONTAL_OPTIONS = [
  { value: "0", label: "左" },
  { value: "1", label: "中央" },
  { value: "2", label: "右" }
];

const VERTICAL_OPTIONS = [
  { value: "0", label: "上1" },
  { value: "1", label: "上2" },
  { value: "2", label: "中央" },
  { value: "3", label: "下2" },
  { value: "4", label: "下1" }
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorMessage(response, fallbackMessage) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await response.json().catch(() => ({}));
    if (json?.error) return String(json.error);
  } else {
    const text = await response.text().catch(() => "");
    if (text.trim()) return text.trim();
  }

  return `${fallbackMessage} (HTTP ${response.status})`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.round(seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function pickDownloadFilename(contentDisposition, fallback) {
  const header = String(contentDisposition || "");
  const match = header.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const encoded = match?.[1] || match?.[2];
  if (!encoded) return fallback;

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

async function fetchApi(path, options) {
  try {
    return await fetch(`${API_URL}${path}`, options);
  } catch (error) {
    const isProduction = process.env.NODE_ENV === "production";
    if (!isProduction || API_URL === "/api") {
      throw error;
    }

    return fetch(`/api${path}`, options);
  }
}

export default function HomePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  const [baseURL, setBaseURL] = useState("");
  const [qrSizeInput, setQrSizeInput] = useState("120");
  const [placementX, setPlacementX] = useState("1");
  const [placementY, setPlacementY] = useState("2");
  const [csvFile, setCsvFile] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [jobId, setJobId] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  const disabled = useMemo(() => submitting || loading || !user, [submitting, loading, user]);

  async function downloadCompletedZip(token, activeJobId) {
    const response = await fetchApi(`/generate/jobs/${activeJobId}/download`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const err = await readErrorMessage(response, "ZIPのダウンロードに失敗しました");
      throw new Error(err);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qr_outputs_${activeJobId}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  }

  async function pollJobUntilDone(token, activeJobId) {
    while (true) {
      const response = await fetchApi(`/generate/jobs/${activeJobId}/status`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const err = await readErrorMessage(response, "進捗の取得に失敗しました");
        throw new Error(err);
      }

      const status = await response.json();
      setProgressPercent(Number(status.progressPercent || 0));
      setProgressMessage(String(status.message || "生成中"));
      setElapsedSeconds(Number(status.elapsedSeconds || 0));
      setEtaSeconds(Number.isFinite(status.etaSeconds) ? status.etaSeconds : null);

      if (status.state === "completed") {
        return;
      }

      if (status.state === "failed") {
        throw new Error(status.error || "生成に失敗しました");
      }

      await wait(1000);
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!csvFile) {
      setError("CSVファイル（.csv）を選択してください。");
      return;
    }

    if (!csvFile.name.toLowerCase().endsWith(".csv")) {
      setError(".csv ファイルのみアップロード可能です。");
      return;
    }

    if (!pdfFile) {
      setError("PDFテンプレート（.pdf）を選択してください。");
      return;
    }

    if (!pdfFile.name.toLowerCase().endsWith(".pdf")) {
      setError(".pdf ファイルのみアップロード可能です。");
      return;
    }

    if (!baseURL.trim()) {
      setError("ベースURLを入力してください。");
      return;
    }

    const parsedQrSize = qrSizeInput.trim() ? Number(qrSizeInput) : 120;
    if (!Number.isFinite(parsedQrSize) || parsedQrSize < 16 || parsedQrSize > 2000) {
      setError("QRサイズは16〜2000の数値で入力してください。");
      return;
    }

    setSubmitting(true);
    setJobId("");
    setProgressPercent(0);
    setProgressMessage("ジョブを開始しています");
    setElapsedSeconds(0);
    setEtaSeconds(null);
    try {
      const token = await user.getIdToken();
      const form = new FormData();
      form.append("baseURL", baseURL);
      form.append("qrSize", String(Math.round(parsedQrSize)));
      form.append("placementX", placementX);
      form.append("placementY", placementY);
      form.append("csvFile", csvFile);
      form.append("pdfFile", pdfFile);

      const response = await fetchApi("/generate/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: form
      });

      if (!response.ok) {
        const err = await readErrorMessage(response, "生成に失敗しました");
        throw new Error(err);
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/zip")) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = pickDownloadFilename(
          response.headers.get("content-disposition"),
          `qr_outputs_${Date.now()}.zip`
        );
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.URL.revokeObjectURL(url);

        setProgressPercent(100);
        setProgressMessage("生成が完了しました");
        setEtaSeconds(0);
        setSuccess("ZIPの生成が完了しました。ダウンロードを開始しました。");
        return;
      }

      const json = await response.json().catch(() => ({}));
      const activeJobId = String(json.jobId || "");
      if (!activeJobId) {
        throw new Error("ジョブIDの取得に失敗しました");
      }

      setJobId(activeJobId);
      setSuccess("生成ジョブを開始しました。進捗を表示しています。");

      await pollJobUntilDone(token, activeJobId);
      await downloadCompletedZip(token, activeJobId);
      setProgressPercent(100);
      setProgressMessage("生成が完了しました");
      setEtaSeconds(0);

      setSuccess("ZIPの生成が完了しました。ダウンロードを開始しました。");
    } catch (e) {
      const message = String(e?.message || "").trim();
      if (message === "Failed to fetch") {
        setError("APIサーバーに接続できません。ローカルは frontend/.env.local の NEXT_PUBLIC_API_URL と backend の起動状態、Vercel は NEXT_PUBLIC_API_URL または同一デプロイの /api を確認してください。");
      } else {
        setError(message || "生成に失敗しました。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user) {
    return <main className="centered">読み込み中...</main>;
  }

  return (
    <main className="app-page">
      <header className="topbar">
        <h1>QR PDF 一括生成ツール</h1>
        <div className="account-actions">
          <span>{user.email}</span>
          <button type="button" className="ghost" onClick={logout}>
            ログアウト
          </button>
        </div>
      </header>

      <section className="panel">
        <p>
          CSVファイル、PDFテンプレート、ベースURLを入力して、
          PDF出力を一括生成します。
        </p>

        <form onSubmit={handleGenerate} className="form-grid">
          <label>
            ベースURL
            <input
              type="url"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://machikanesai.com/25/search/"
              required
            />
          </label>

          <label>
            CSVファイル（.csv）
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              required
            />
          </label>

          <label>
            QRサイズ（px）
            <input
              type="number"
              min={16}
              max={2000}
              value={qrSizeInput}
              onChange={(e) => setQrSizeInput(e.target.value)}
              onBlur={() => {
                if (!qrSizeInput.trim()) {
                  setQrSizeInput("120");
                }
              }}
            />
          </label>

          <label>
            文字+QRの横位置（3段階）
            <select value={placementX} onChange={(e) => setPlacementX(e.target.value)}>
              {HORIZONTAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            文字+QRの縦位置（5段階）
            <select value={placementY} onChange={(e) => setPlacementY(e.target.value)}>
              {VERTICAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            PDFテンプレート（.pdf）
            <input
              type="file"
              accept=".pdf"
              onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
              required
            />
          </label>

          {error ? <div className="error-box">{error}</div> : null}
          {success ? <div className="success-box">{success}</div> : null}

          {jobId ? (
            <div className="panel" style={{ marginTop: 12, padding: 12 }}>
              <div>ジョブID: {jobId}</div>
              <div style={{ marginTop: 6 }}>{progressMessage || "生成中"}</div>
              <progress style={{ width: "100%", marginTop: 8 }} value={progressPercent} max={100} />
              <div style={{ marginTop: 6 }}>
                進行度: {progressPercent}% / 経過時間: {formatDuration(elapsedSeconds)} / 予想残り時間: {formatDuration(etaSeconds)}
              </div>
            </div>
          ) : null}

          <button type="submit" disabled={disabled}>
            {submitting ? "生成中（進捗表示中）..." : "ZIPを生成する"}
          </button>
        </form>
      </section>
    </main>
  );
}
