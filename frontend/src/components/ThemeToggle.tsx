"use client";

import { useEffect, useState } from "react";

type Theme = "vscode" | "dark";

function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "vscode";
}

function applyTheme(theme: Theme) {
  const cl = document.documentElement.classList;
  cl.remove("vscode", "dark");
  cl.add(theme);
  document.documentElement.style.background = theme === "dark" ? "#030712" : "#1e1e1e";
  localStorage.setItem("theme", theme);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("vscode");

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "vscode" ? "dark" : "vscode";
    setTheme(next);
    applyTheme(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      title={theme === "vscode" ? "Switch to dark theme" : "Switch to VS Code theme"}
      className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#3c3c3c] transition-colors"
    >
      {theme === "vscode" ? (
        // Moon icon — vscode is active, switch to dark
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      ) : (
        // Monitor icon — dark is active, switch to vscode
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      )}
    </button>
  );
}
