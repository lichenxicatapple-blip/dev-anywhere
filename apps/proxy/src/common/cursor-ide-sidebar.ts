import { CursorIdeConnection, CursorIdeError, cursorIdeTargets } from "./cursor-ide-cdp.js";

export interface CursorIdeVisibleChat {
  id: string;
  title: string;
  section: string;
}

/** Runs inside Cursor's renderer; the sidebar row carries the actual composer UUID. */
export function readCursorIdeSidebar(): CursorIdeVisibleChat[] | null {
  const sidebar =
    document.querySelector('[class*="glass-sidebar-scroll"], [class*="glass-sidebar-body"]') ??
    (document.querySelector(".ui-sidebar-section-head") ? document : null);
  if (!sidebar) return null;
  const currentRows = '[data-perf-id="glass-sidebar-agent-row"]';
  const legacyRows = ".glass-sidebar-agent-menu-btn";
  const rowSelector = sidebar.querySelector(currentRows) ? currentRows : legacyRows;
  const rows: CursorIdeVisibleChat[] = [];
  let section = "";
  for (const element of Array.from(
    sidebar.querySelectorAll(`.ui-sidebar-section-head, ${rowSelector}`),
  )) {
    if (element.classList.contains("ui-sidebar-section-head")) {
      section = (
        element.querySelector(".ui-sidebar-label-row-title")?.textContent ??
        element.querySelector(".ui-sidebar-menu-button-label")?.textContent ??
        ""
      )
        .trim()
        .slice(0, 512);
      continue;
    }
    if (element.getBoundingClientRect().width <= 0) continue;
    const row = element.closest("[data-sidebar-item-key]");
    const id =
      element.getAttribute("data-sidebar-file-drop-agent-id") ??
      element.getAttribute("data-composer-id") ??
      row?.getAttribute("data-sidebar-item-key")?.replace(/^row:/, "") ??
      "";
    const title = element.querySelector(".ui-sidebar-menu-button-label")?.textContent?.trim() ?? "";
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) && title) {
      rows.push({ id, title, section });
    }
  }
  return rows;
}

/** Runs inside an editor renderer when Cursor's separate Agents window is not open. */
export function readCursorIdeEditorTabs(): CursorIdeVisibleChat[] {
  const auxiliary = document.getElementById("workbench.parts.auxiliarybar");
  if (!auxiliary) return [];
  const rows: CursorIdeVisibleChat[] = [];
  for (const tab of Array.from(auxiliary.querySelectorAll('[role="tab"][data-resource-name]'))) {
    const id = tab.getAttribute("data-resource-name") ?? "";
    const title = (
      tab.querySelector(".label-name")?.textContent ??
      tab.getAttribute("aria-label")?.replace(/,\s*Chat Editors:\s*Editor Group\s*\d+\s*$/i, "") ??
      ""
    ).trim();
    if (/^[a-f0-9-]{32,36}$/i.test(id) && title) rows.push({ id, title, section: "" });
  }
  return rows;
}

/** Historical files alone do not imply a visible Cursor chat. */
export async function listCursorIdeVisibleChats(): Promise<CursorIdeVisibleChat[]> {
  const windows = await cursorIdeTargets();
  const agentWindows = windows.filter((target) => /^cursor agents$/i.test(target.title.trim()));
  const targets = agentWindows.length ? agentWindows : windows;
  if (!targets.length)
    throw new CursorIdeError("未找到 Cursor 窗口，请先打开 Cursor 后刷新会话列表");
  const result: CursorIdeVisibleChat[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const connection = await CursorIdeConnection.connect(target.webSocketDebuggerUrl);
    try {
      const reader = agentWindows.length ? readCursorIdeSidebar : readCursorIdeEditorTabs;
      const rows = await connection.evaluate<CursorIdeVisibleChat[] | null>(
        `(${reader.toString()})()`,
      );
      if (agentWindows.length && !rows)
        throw new CursorIdeError("无法识别 Cursor 的会话侧边栏，请确认窗口已加载后刷新");
      for (const row of rows ?? []) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        result.push(row);
      }
    } finally {
      connection.close();
    }
  }
  return result;
}
