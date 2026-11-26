import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "./components/SiteHeader";

export const metadata: Metadata = {
  title: "Mock examizerF",
  description: "模試の傾向分析・問題バンク・模試生成・検算・PDF出力をローカルで行うアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <SiteHeader />
        {children}
        <div className="page" style={{ paddingTop: 0 }}>
          <div className="footer-note">
            Mock examizerF — ローカル環境専用 / データは data/ 配下の SQLite に保存されます
          </div>
        </div>
      </body>
    </html>
  );
}
