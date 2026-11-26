"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface ComboBoxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  id,
  required,
  disabled,
  className = "",
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const unique = Array.from(
      new Set(options.map((option) => option.trim()).filter(Boolean))
    );
    const query = value.trim().toLowerCase();
    const list = query
      ? unique.filter((option) => option.toLowerCase().includes(query))
      : unique;
    return list.slice(0, 60);
  }, [options, value]);

  useEffect(() => {
    function handleMouseDown(event: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  return (
    <div ref={wrapperRef} className={`relative ${className}`.trim()}>
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Enter" && open && filtered.length > 0) {
            event.preventDefault();
            onChange(filtered[0]);
            setOpen(false);
          }
        }}
      />
      {open && !disabled && filtered.length > 0 ? (
        <ul className="absolute z-40 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 py-1 shadow-2xl">
          {filtered.map((option) => (
            <li key={option}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-50"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
