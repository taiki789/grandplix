"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export default function HomePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  const [baseURL, setBaseURL] = useState("");
  const [ids, setIds] = useState("");
  const [qrSize, setQrSize] = useState(150);
  const [qrPosition, setQrPosition] = useState("center");
  const [file, setFile] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  const disabled = useMemo(() => submitting || loading || !user, [submitting, loading, user]);

  async function handleGenerate(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!file) {
      setError("PDFテンプレート（.pdf）を選択してください。");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError(".pdf ファイルのみアップロード可能です。");
      return;
    }

    if (!baseURL.trim()) {
      setError("ベースURLを入力してください。");
      return;
    }

    if (!ids.trim()) {
      setError("IDを1つ以上入力してください。");
      return;
    }

    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      const form = new FormData();
      form.append("baseURL", baseURL);
      form.append("ids", ids);
      form.append("qrSize", String(qrSize));
      form.append("qrPosition", qrPosition);
      form.append("file", file);

      const response = await fetch(`${API_URL}/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: form
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "生成に失敗しました");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `qr_outputs_${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);

      setSuccess("ZIPの生成が完了しました。");
    } catch (e) {
      setError(e.message || "生成に失敗しました。");
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
          ベースURL、ID（カンマ区切り/範囲指定）、QRサイズ、PDFテンプレートを入力して、
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
            ID入力（カンマ区切り/範囲指定）
            <input
              type="text"
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              placeholder="101,102,103 または 100-120"
              required
            />
          </label>

          <label>
            QRサイズ（px）
            <input
              type="number"
              min={16}
              max={2000}
              value={qrSize}
              onChange={(e) => setQrSize(Number(e.target.value || 150))}
            />
          </label>

          <label>
            QR配置位置
            <select
              value={qrPosition}
              onChange={(e) => setQrPosition(e.target.value)}
            >
              <option value="top-left">左上</option>
              <option value="top-center">上中央</option>
              <option value="top-right">右上</option>
              <option value="center-left">左中央</option>
              <option value="center">中央</option>
              <option value="center-right">右中央</option>
              <option value="bottom-left">左下</option>
              <option value="bottom-center">下中央</option>
              <option value="bottom-right">右下</option>
            </select>
          </label>

          <label>
            PDFテンプレート（.pdf）
            <input
              type="file"
              accept=".pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
            />
          </label>

          {error ? <div className="error-box">{error}</div> : null}
          {success ? <div className="success-box">{success}</div> : null}

          <button type="submit" disabled={disabled}>
            {submitting ? "生成中..." : "ZIPを生成する"}
          </button>
        </form>
      </section>
    </main>
  );
}
