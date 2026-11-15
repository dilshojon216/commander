/** Mavzu: qorong'i = default; birinchi tashrifda `prefers-color-scheme` hisobga olinadi. */
export type Theme = "dark" | "light";

export const THEME_KEY = "commander-theme";

/** Sof qaror: saqlangan qiymat bo'lsa shu, aks holda tizim sozlamasi, aks holda qorong'i. */
export function resolveInitialTheme(stored: string | null, prefersLight: boolean): Theme {
  if (stored === "dark" || stored === "light") return stored;
  return prefersLight ? "light" : "dark";
}

/**
 * <head> ichidagi inline skript (hydration'dan OLDIN ishlaydi: miltillashsiz).
 * localStorage bloklangan bo'lsa try/catch uni jim o'tkazadi.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}if(t!=="dark"&&t!=="light"){t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){}})();`;
