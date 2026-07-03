"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";

export default function HeaderAuth() {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (loading) {
    return <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 vscode:bg-[#3c3c3c] animate-pulse" />;
  }

  if (!user) {
    return (
      <a
        href="/login"
        className="text-sm text-gray-600 dark:text-gray-300 vscode:text-[#d4d4d4] hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        Log in
      </a>
    );
  }

  const initial = (user.name || user.email).charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full focus:outline-none"
        title={user.email}
      >
        {user.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture} alt="" className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-sm font-semibold flex items-center justify-center">
            {initial}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#252526] shadow-lg py-1 z-50">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c]">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 vscode:text-[#d4d4d4] truncate">{user.name || "Signed in"}</p>
            <p className="text-xs text-gray-400 truncate">{user.email}</p>
          </div>
          <a href="/dashboard" className="block px-3 py-2 text-sm text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors">
            Dashboard
          </a>
          <button
            onClick={() => { setOpen(false); logout(); }}
            className="block w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
