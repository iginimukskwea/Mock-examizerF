"use client";

export interface BookCoverProps {
  bookName: string;
  coverPath: string | null;
  className?: string;
}

export function BookCover({
  bookName,
  coverPath,
  className = "",
}: BookCoverProps) {
  return (
    <div
      className={`book-cover ${className}`.trim()}
      title={coverPath ? `${bookName}の表紙` : "表紙未設定"}
    >
      {coverPath ? (
        <img src={coverPath} alt={`${bookName}の表紙`} loading="lazy" />
      ) : (
        <div className="book-cover-placeholder">
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5V4.5Z" />
            <path d="M5 4.5A2.5 2.5 0 0 0 7.5 7H20" />
          </svg>
          <strong>{bookName || "参考書"}</strong>
          <small>表紙未設定</small>
        </div>
      )}
    </div>
  );
}
