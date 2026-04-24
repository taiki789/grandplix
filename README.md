# Grandplix QR PDF 一括生成アプリ

Next.js フロントエンド + Express API + Firebase Authentication で構成されたアプリです。

ログイン後に以下を入力できます。
- ベースURL
- ID（カンマ区切り / 範囲指定）
- QRサイズ
- PDFテンプレート（`.pdf`）

バックエンドは次の処理を行います。
- `{baseURL}{id}/` 形式のURLを生成
- `qrcode` でURLごとのQR（PNG）を生成
- PDFテンプレートの1ページ目中央へQR画像を重ね込み
- IDごとに `.pdf` を出力
- すべてをZIP化してダウンロード返却

## ディレクトリ構成

```text
project/
├── frontend/
├── backend/
│   ├── server.js
│   ├── uploads/
│   ├── temp/
│   └── output/
└── package.json
```

## 1) 前提条件

- Node.js 18以上
- npm 9以上
- Firebaseプロジェクト（Authentication有効）

## 2) 依存関係のインストール

プロジェクトルートで実行します。

```bash
npm install
```

## 3) Firebase設定

### クライアント側（frontend）

1. Firebase Consoleでプロジェクトを作成または選択
2. Authentication -> Sign-in method -> メール/パスワードを有効化
3. Webアプリを登録して設定値を取得
4. `frontend/.env.local.example` をもとに `frontend/.env.local` を作成

例:

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

### サーバー側（backend）

1. Firebase Console -> Project settings -> Service accounts で秘密鍵を生成
2. 次のいずれかを設定
- `backend/.env` に `FIREBASE_SERVICE_ACCOUNT_JSON` を直接設定
- `GOOGLE_APPLICATION_CREDENTIALS` に秘密鍵JSONのパスを設定

`backend/.env.example` をもとに `backend/.env` を作成してください。

例:

```env
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000
FIREBASE_PROJECT_ID=granprix-dc533
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

補足:
- ローカル開発では `FIREBASE_PROJECT_ID` のみでIDトークン検証が動作する場合があります。
- 本番運用では `FIREBASE_SERVICE_ACCOUNT_JSON`（または `GOOGLE_APPLICATION_CREDENTIALS`）を推奨します。

## 4) PDF重ね込み処理の動作

`backend/server.js` の処理:
- テンプレートPDFを読み込む
- 生成済みQR（PNG）を埋め込む
- 1ページ目の中央座標を計算して配置
- PDFとして保存

## 5) 起動方法

フロントとバックエンドを同時起動:

```bash
npm run dev
```

個別起動:

```bash
npm run dev:frontend
npm run dev:backend
```

- フロント: http://localhost:3000
- バックエンド: http://localhost:4000

## 6) API仕様

### `POST /generate`

フォーム項目:
- `baseURL`（string）
- `ids`（string, 例: `101,102` / `100-120` / 混在可）
- `qrSize`（number）
- `file`（`.pdf`）

認証:
- `Authorization: Bearer <Firebase ID Token>`

レスポンス:
- `application/zip`

## 7) バリデーション / セキュリティ

- バックエンドでFirebaseトークン検証（`firebase-admin`）
- 未認証リクエストを拒否
- アップロードは `.pdf` 拡張子のみ許可
- URL / IDs / QRサイズの入力検証
- 一時ファイルを処理後に削除
- 出力ファイル名をサニタイズ

## 8) 開発時メモ

このアプリは Illustrator を使わず、サーバー側でPDFへ直接QRを重ね込む実装です。
