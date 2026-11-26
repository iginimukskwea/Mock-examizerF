"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ShutdownButton } from "./ShutdownButton";

const NAV_ITEMS = [
  { href: "/problems", label: "問題データ" },
  { href: "/generate", label: "模試生成" },
  { href: "/history", label: "出力履歴" },
  { href: "/settings", label: "データ管理" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [status, setStatus] = useState<{ label: string; mode: string } | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) setStatus({ label: data.label, mode: data.mode });
      })
      .catch(() => undefined);
  }, []);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/problems" className="brand">
          <span className="brand-dot" />
          Mock examizerF
          <small>LOCAL</small>
        </Link>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link ${pathname === item.href ? "active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          {status ? (
            <div className="header-status">
              <span
                className={`badge ${status.mode === "demo" ? "badge-amber" : "badge-green"}`}
              >
                {status.label}
              </span>
            </div>
          ) : null}
          <ShutdownButton />
        </div>
      </div>
    </header>
  );
}
