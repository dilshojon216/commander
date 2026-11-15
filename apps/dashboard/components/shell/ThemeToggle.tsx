"use client";

import { setTheme, useTheme } from "@/lib/use-theme";
import { IconMoon, IconSun } from "@/components/ui/icons";

/** Mavzu almashtirgich (localStorage'da saqlanadi). Yorlig'i: o'tiladigan rejim. */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="nav w-full border-0 bg-transparent"
      style={{ font: "inherit", cursor: "pointer" }}
      onClick={() => setTheme(next)}
      aria-label={next === "light" ? "Yorug' rejimga o'tish" : "Qorong'i rejimga o'tish"}
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
      <span>{theme === "dark" ? "Yorug' rejim" : "Qorong'i rejim"}</span>
    </button>
  );
}
