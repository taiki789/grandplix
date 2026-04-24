import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "QR PDF 一括生成ツール",
  description: "URLごとのQRをPDFテンプレート中央に配置して一括出力"
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
