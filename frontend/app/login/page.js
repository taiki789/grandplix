"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && user) {
      router.replace("/");
    }
  }, [loading, user, router]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    if (!email || !password) {
      setError("メールアドレスとパスワードを入力してください。");
      return;
    }

    setSubmitting(true);
    try {
      const auth = getFirebaseAuth();
      if (mode === "register") {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      router.replace("/");
    } catch (e) {
      setError(e.message || "認証に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="centered">セッションを確認中...</main>;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>{mode === "login" ? "ログイン" : "新規登録"}</h1>
        <p>Firebase Authentication（メール/パスワード）を使用します。</p>

        <form onSubmit={handleSubmit} className="form-grid">
          <label>
            メールアドレス
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>

          <label>
            パスワード
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </label>

          {error ? <div className="error-box">{error}</div> : null}

          <button type="submit" disabled={submitting}>
            {submitting ? "処理中..." : mode === "login" ? "ログイン" : "登録"}
          </button>
        </form>

        <button
          type="button"
          className="ghost"
          onClick={() => setMode((prev) => (prev === "login" ? "register" : "login"))}
        >
          {mode === "login" ? "アカウントをお持ちでない方はこちら" : "すでにアカウントをお持ちの方はこちら"}
        </button>
      </section>
    </main>
  );
}
