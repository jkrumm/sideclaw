import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
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
      const next: ThemeMode =
        prev === "light" ? "dark" : prev === "dark" ? "system" : "light";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
