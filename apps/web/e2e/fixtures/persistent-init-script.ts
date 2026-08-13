import type { Disposable, Page } from "@playwright/test";

const pageScripts = new WeakMap<Page, Map<string, Disposable>>();
const persistentDisposables = new WeakSet<Disposable>();

export async function addPersistentInitScript(
  page: Page,
  key: string,
  script: Parameters<Page["addInitScript"]>[0],
  arg?: unknown,
): Promise<void> {
  const scripts = pageScripts.get(page) ?? new Map<string, Disposable>();
  pageScripts.set(page, scripts);
  if (scripts.has(key)) return;

  const disposable = (await Reflect.apply(page.addInitScript, page, [script, arg])) as Disposable;
  persistentDisposables.add(disposable);
  scripts.set(key, disposable);
}

export function isPersistentInitScript(disposable: Disposable): boolean {
  return persistentDisposables.has(disposable);
}
