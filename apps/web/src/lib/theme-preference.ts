import {
  readStorageValue,
  removeStorageValue,
  STORAGE_KEYS,
  writeStorageValue,
} from "@/lib/storage-keys";

export type ThemePreference = "auto" | "light" | "dark";

const LIGHT_THEME_COLOR = "#F6F7F8";
const DARK_THEME_COLOR = "#1E1E1E";
const LIGHT_COLOR_SCHEME = "light";
const DARK_COLOR_SCHEME = "dark";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "auto" || value === "light" || value === "dark";
}

function normalizeThemePreference(value: string | null): ThemePreference {
  return isThemePreference(value) ? value : "auto";
}

export function readThemePreference(): ThemePreference {
  return normalizeThemePreference(readStorageValue("local", STORAGE_KEYS.themePreference));
}

export function writeThemePreference(value: ThemePreference): void {
  if (value === "auto") {
    removeStorageValue("local", STORAGE_KEYS.themePreference);
    return;
  }
  writeStorageValue("local", STORAGE_KEYS.themePreference, value);
}

function themeColorForPreference(value: ThemePreference): {
  light: string;
  dark: string;
} {
  if (value === "light") return { light: LIGHT_THEME_COLOR, dark: LIGHT_THEME_COLOR };
  if (value === "dark") return { light: DARK_THEME_COLOR, dark: DARK_THEME_COLOR };
  return { light: LIGHT_THEME_COLOR, dark: DARK_THEME_COLOR };
}

function resolveEffectiveColorScheme(value: ThemePreference): "light" | "dark" {
  if (value === "light" || value === "dark") return value;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateColorSchemeMeta(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  const colorScheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  const resolvedScheme = resolveEffectiveColorScheme(value);
  colorScheme?.setAttribute(
    "content",
    resolvedScheme === "dark" ? DARK_COLOR_SCHEME : LIGHT_COLOR_SCHEME,
  );
}

function updateThemeColorMeta(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  const colors = themeColorForPreference(value);
  const lightMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
  );
  const darkMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
  );
  lightMeta?.setAttribute("content", colors.light);
  darkMeta?.setAttribute("content", colors.dark);
}

export function applyThemePreference(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.dataset.theme = value;
  }
  updateThemeColorMeta(value);
  updateColorSchemeMeta(value);
}

export function applyStoredThemePreference(): ThemePreference {
  const value = readThemePreference();
  applyThemePreference(value);
  return value;
}
