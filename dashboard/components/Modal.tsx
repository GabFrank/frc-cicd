"use client";

import { useEffect } from "react";

export function Modal({
  open,
  onClose,
  title,
  children,
  widthClass = "max-w-3xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  widthClass?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={`bg-bg-surface border border-border-default rounded-lg w-full ${widthClass} max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-xl leading-none px-2"
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
