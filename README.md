# Grandplix QR PDF 一括生成ツール 取り扱い説明書

このアプリは、CSV と PDF テンプレートを使って、QRコード付きの PDF を一括生成し、ZIP でダウンロードするツールです。

- フロントエンド: Next.js
- バックエンド: Express
- 認証: Firebase Authentication（メール/パスワード）

## 1. できること

- CSV の各行ごとに 1 つの PDF を生成
- QRコード + テキスト2行を PDF 上に配置
- 配置は「横3段階 × 縦5段階」で指定可能
- QRサイズ指定可能
- 進捗率、経過時間、予想残り時間を表示
- 完了時に ZIP を自動ダウンロード

## 2. 事前準備

### 必須環境

- Node.js 18 以上
- npm 9 以上
- Firebase プロジェクト（Authentication を有効化）

### インストール

プロジェクトルートで実行:

```bash
npm install
```

## 3. 環境変数設定

### フロントエンド: `frontend/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=...
```

### バックエンド: `backend/.env`

```env
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000
FIREBASE_PROJECT_ID=your-project-id
# 本番推奨: どちらかを設定
# FIREBASE_SERVICE_ACCOUNT_JSON={...}
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### 日本語フォント（必須）

次のファイルが必須です:

- `backend/NotoSansJP-Regular.ttf`

未配置または空ファイルの場合、生成は失敗します。

## 4. 起動方法

### 同時起動

```bash
npm run dev
```

### 個別起動

```bash
npm run dev:frontend
npm run dev:backend
```

起動先:

- フロント: http://localhost:3000
- バックエンド: http://localhost:4000

## 5. 使い方

### 5.1 ログイン

1. ブラウザで http://localhost:3000 を開く
2. メール/パスワードでログイン
3. アカウント未作成なら「新規登録」で作成

### 5.2 生成画面の入力

1. ベースURLを入力
- 例: `https://example.com/search/`

2. CSVファイル（`.csv`）を選択

3. QRサイズ（px）を入力
- 許容範囲: 16 〜 2000
- 未入力時は 120

4. 文字+QRの横位置（3段階）を選択
- 左 / 中央 / 右

5. 文字+QRの縦位置（5段階）を選択
- 上1 / 上2 / 中央 / 下2 / 下1

6. PDFテンプレート（`.pdf`）を選択

7. 「ZIPを生成する」をクリック

### 5.3 実行中表示

- ジョブID
- 進行度（%）
- 経過時間
- 予想残り時間

完了すると ZIP のダウンロードが自動開始されます。

## 6. CSV仕様

- 1行目はヘッダーとしてスキップ
- 2行目以降をデータとして処理
- 最低 5 列必要
- 使用列:
  - 1列目: `id`（必須）
  - 2列目: `text1`（最大20文字に切り詰め）
  - 5列目: `text2`（最大20文字に切り詰め）
- 上限件数: 500 行

### サンプル

```csv
id,text1,col3,col4,text2
1001,見本1,xx,yy,説明1
1002,見本2,xx,yy,説明2
```

生成URLは `ベースURL + id` です。

## 7. 出力仕様

- 入力 PDF の 1ページ目に描画
- QRコード + テキスト2行を 1ブロックとして配置
- テキストは大きめ表示（太字風）
- 出力ファイル名: `output_<id>.pdf`
- ZIP名: `qr_outputs_<jobId>.zip`

## 8. 主なエラーと対処

### 「Cannot POST /generate/jobs」

原因:
- 古いバックエンドが起動中
- API URL が誤っている

対処:
1. `NEXT_PUBLIC_API_URL` が正しいか確認
2. 4000番ポートの旧プロセスを停止
3. `npm run dev:backend` で再起動

### 「生成に失敗しました」

対処:
- 画面に表示される詳細エラーを確認
- `backend/NotoSansJP-Regular.ttf` の有無とサイズを確認
- CSV が仕様を満たしているか確認

### 「APIサーバーに接続できません」

対処:
- バックエンドが起動しているか確認
- CORS の `FRONTEND_ORIGIN` を確認
- `frontend/.env.local` の API URL を確認

### 進行度100%で止まる

対処:
- バックエンドログで ZIP 作成エラー有無を確認
- ジョブ状態 API (`/generate/jobs/:jobId/status`) の `state` を確認

## 9. API概要

- `POST /generate/jobs`
  - 入力: `baseURL`, `qrSize`, `placementX`, `placementY`, `csvFile`, `pdfFile`
  - 認証: `Authorization: Bearer <Firebase ID Token>`
  - 出力: ジョブ開始情報（jobId）

- `GET /generate/jobs/:jobId/status`
  - ジョブ進捗取得

- `GET /generate/jobs/:jobId/download`
  - 完了済み ZIP ダウンロード

## 10. 運用メモ

- このアプリは Illustrator を使いません
- すべてサーバー側で PDF へ直接描画します
- デプロイ時はフォントファイルを必ず含めてください

## 11. Vercel デプロイ時の注意

- このリポジトリは、Vercel 本番環境ではフロントエンドから同一デプロイ内の `/api/*` 経由で Express を呼び出す構成です。
- `NEXT_PUBLIC_API_URL` を未設定にすると、本番では自動で `/api` を利用します。

### 必要な環境変数（Vercel Project Settings）

- `FIREBASE_SERVICE_ACCOUNT_JSON`（推奨）
- または分割指定: `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`（必要に応じて `FIREBASE_PROJECT_ID`）
- または最低限: `FIREBASE_PROJECT_ID`（`NEXT_PUBLIC_FIREBASE_PROJECT_ID` でも代替可）
- 必要に応じて `FRONTEND_ORIGIN`

### 既知の制約

- Vercel Functions は常駐サーバーではないため、長時間ジョブやメモリ保持に依存する処理は不安定になる可能性があります。
- 一時ファイルは Vercel では `/tmp` 配下を使用します。
