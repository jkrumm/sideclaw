import React, { createContext, useContext, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Classes } from "@blueprintjs/core";
import { App } from "./App";
import "./styles/global.css";

type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  isDark: boolean;
  mode: ThemeMode;
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  isDark: false,
  mode: "system",
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "dark" || stored === "light") return stored;
    return "system";
  });

  useEffect(() => {
    let buildId: string | null = null;

    async function checkBuildId() {
      try {
        const res = await fetch("/api/build-id");
        const data = (await res.json()) as { buildId: string };
        if (buildId === null) {
          buildId = data.buildId;
        } else if (buildId !== data.buildId) {
          window.location.reload();
        }
      } catch {
        // ignore — server may be restarting
      }
    }

    checkBuildId();

    const handler = () => checkBuildId();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, []);

  const isDark = mode === "dark" || (mode === "system" && getSystemDark());

  useEffect(() => {
    document.body.classList.toggle(Classes.DARK, isDark);
  }, [isDark]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      document.body.classList.toggle(Classes.DARK, e.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  const toggle = () => {
    setMode((prev) => {
      const next: ThemeMode = prev === "light" ? "dark" : prev === "dark" ? "system" : "light";
      if (next === "system") {
        localStorage.removeItem("theme");
      } else {
        localStorage.setItem("theme", next);
      }
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ isDark, mode, toggle }}>
      <App />
    </ThemeContext.Provider>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
