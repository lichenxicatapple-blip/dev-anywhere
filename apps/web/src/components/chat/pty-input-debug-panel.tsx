import { useEffect, useRef, useState } from "react";

export interface PtyInputDebugPanelProps {
  ptyInputFocused: boolean;
  touchEditingSurface: boolean;
  softKeyboardEditingSurface: boolean;
  physicalKeyboardMode: boolean;
  keyboardOffset: number;
  rawKeyboardOffset: number;
  rawKeyboardLayoutInset: number;
  bottomOverscrollPadding: number;
  viewportOcclusionKind: string;
  viewportOcclusionReason: string;
  showMobilePtyControls: boolean;
  mobileControlsBottomInset: number;
}

declare global {
  interface Window {
    __devAnywherePtyInputDebugSnapshot?: PtyInputDebugSnapshot;
    __devAnywherePtyInputDebugEvents?: string[];
    __devAnywherePtyInputDebugText?: string;
  }
}

interface PtyInputDebugSnapshot {
  active: string;
  visualViewport: string;
  window: string;
  state: string;
  occlusion: string;
  offsets: string;
  controls: string;
  activeDetails: string[];
  textareaDetails: string[];
  textareaRect: string;
  textareaStyle: string[];
  formDetails: string[];
  recentEvents: string[];
}

const MAX_EVENT_ROWS = 28;

export function PtyInputDebugPanel(props: PtyInputDebugPanelProps) {
  const [snapshot, setSnapshot] = useState("");
  const eventRowsRef = useRef<string[]>([]);
  const enabled = isPtyInputDebugEnabled();

  useEffect(() => {
    if (!enabled) return;

    const pushEvent = (event: Event) => {
      eventRowsRef.current = [
        formatDebugEvent(event),
        ...eventRowsRef.current.slice(0, MAX_EVENT_ROWS - 1),
      ];
      update();
    };

    const update = () => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      const active = document.activeElement;
      const activeElement =
        active instanceof HTMLElement
          ? `${active.tagName.toLowerCase()}.${Array.from(active.classList).join(".")}`
          : String(active?.nodeName ?? "none");
      const vv = window.visualViewport;
      const rootScheme = window.getComputedStyle(document.documentElement).colorScheme;
      const textareaScheme = textarea ? window.getComputedStyle(textarea).colorScheme : null;
      const activeDetails = describeInputElement(active);
      const textareaDetails = describeInputElement(textarea);
      const textareaRect = textarea ? describeRect(textarea.getBoundingClientRect()) : "missing";
      const textareaStyle = textarea ? describeInputStyle(textarea, textareaScheme) : [];
      const formDetails = textarea ? describeForm(textarea.closest("form")) : [];
      const structured: PtyInputDebugSnapshot = {
        active: activeElement,
        visualViewport: `${Math.round(vv?.height ?? 0)}x${Math.round(vv?.width ?? 0)} top=${Math.round(
          vv?.offsetTop ?? 0,
        )}`,
        window: `${window.innerWidth}x${window.innerHeight}`,
        state: `focused=${props.ptyInputFocused} touch=${props.touchEditingSurface} soft=${props.softKeyboardEditingSurface} physical=${props.physicalKeyboardMode}`,
        occlusion: `${props.viewportOcclusionKind} ${props.viewportOcclusionReason}`,
        offsets: `offset=${Math.round(props.keyboardOffset)} raw=${Math.round(props.rawKeyboardOffset)} layout=${Math.round(
          props.rawKeyboardLayoutInset,
        )}`,
        controls: `controls=${props.showMobilePtyControls} inset=${Math.round(
          props.mobileControlsBottomInset,
        )} overscroll=${Math.round(props.bottomOverscrollPadding)}`,
        activeDetails,
        textareaDetails,
        textareaRect,
        textareaStyle: [
          `rootScheme=${rootScheme}`,
          `prefersDark=${window.matchMedia("(prefers-color-scheme: dark)").matches}`,
          ...textareaStyle,
        ],
        formDetails,
        recentEvents: eventRowsRef.current,
      };
      const rows = formatDebugSnapshot(structured);
      window.__devAnywherePtyInputDebugSnapshot = structured;
      window.__devAnywherePtyInputDebugEvents = eventRowsRef.current;
      window.__devAnywherePtyInputDebugText = rows.join("\n");
      setSnapshot(rows.join("\n"));
    };

    update();
    const interval = window.setInterval(update, 250);
    const eventTypes = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "focusin",
      "focusout",
      "keydown",
      "keyup",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ] as const;
    eventTypes.forEach((type) => window.addEventListener(type, pushEvent, true));
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.clearInterval(interval);
      eventTypes.forEach((type) => window.removeEventListener(type, pushEvent, true));
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [
    enabled,
    props.bottomOverscrollPadding,
    props.keyboardOffset,
    props.mobileControlsBottomInset,
    props.physicalKeyboardMode,
    props.ptyInputFocused,
    props.rawKeyboardLayoutInset,
    props.rawKeyboardOffset,
    props.showMobilePtyControls,
    props.softKeyboardEditingSurface,
    props.touchEditingSurface,
    props.viewportOcclusionKind,
    props.viewportOcclusionReason,
  ]);

  if (!enabled) return null;

  return (
    <pre className="pointer-events-none fixed right-3 top-24 z-[80] max-h-[70dvh] max-w-[560px] overflow-hidden whitespace-pre-wrap rounded border border-border bg-popover/95 p-2 text-[10px] leading-tight text-popover-foreground shadow-lg">
      {snapshot}
    </pre>
  );
}

function formatDebugSnapshot(snapshot: PtyInputDebugSnapshot): string[] {
  return [
    `active=${snapshot.active}`,
    `vv=${snapshot.visualViewport}`,
    `win=${snapshot.window}`,
    snapshot.state,
    `occ=${snapshot.occlusion}`,
    snapshot.offsets,
    snapshot.controls,
    "events:",
    ...indent(snapshot.recentEvents),
    "active details:",
    ...indent(snapshot.activeDetails),
    "textarea details:",
    ...indent(snapshot.textareaDetails),
    `textarea rect: ${snapshot.textareaRect}`,
    "textarea style:",
    ...indent(snapshot.textareaStyle),
    "form:",
    ...indent(snapshot.formDetails),
  ];
}

function indent(lines: string[]): string[] {
  return lines.length > 0 ? lines.map((line) => `  ${line}`) : ["  none"];
}

function describeInputElement(element: Element | null): string[] {
  if (!(element instanceof HTMLElement)) return ["missing"];
  const lines = [
    `tag=${element.tagName.toLowerCase()}`,
    `id=${debugAttr(element.id || null)}`,
    `class=${debugAttr(Array.from(element.classList).join(".") || null)}`,
    `role=${debugAttr(element.getAttribute("role"))}`,
    `aria=${debugAttr(element.getAttribute("aria-label"))}`,
    `name=${debugAttr(element.getAttribute("name"))}`,
    `type=${debugAttr(element.getAttribute("type"))}`,
    `autocomplete=${debugAttr(element.getAttribute("autocomplete"))}`,
    `inputmode=${debugAttr(element.getAttribute("inputmode"))}`,
    `enterkeyhint=${debugAttr(element.getAttribute("enterkeyhint"))}`,
    `autocorrect=${debugAttr(element.getAttribute("autocorrect"))}`,
    `autocapitalize=${debugAttr(element.getAttribute("autocapitalize"))}`,
    `vk=${debugAttr(element.getAttribute("virtualkeyboardpolicy"))}`,
    `contenteditable=${debugAttr(element.getAttribute("contenteditable"))}`,
    `placeholder=${debugAttr(element.getAttribute("placeholder"))}`,
  ];
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    lines.push(
      `readOnly=${element.readOnly}`,
      `disabled=${element.disabled}`,
      `spellcheck=${element.spellcheck}`,
      `valueLen=${element.value.length}`,
      `selection=${element.selectionStart ?? "none"}..${element.selectionEnd ?? "none"}`,
    );
  }
  return lines;
}

function describeForm(form: HTMLFormElement | null): string[] {
  if (!form) return ["missing"];
  return [
    `id=${debugAttr(form.id || null)}`,
    `name=${debugAttr(form.getAttribute("name"))}`,
    `autocomplete=${debugAttr(form.getAttribute("autocomplete"))}`,
    `action=${debugAttr(form.getAttribute("action"))}`,
    `method=${debugAttr(form.getAttribute("method"))}`,
  ];
}

function describeInputStyle(element: HTMLElement, computedColorScheme: string | null): string[] {
  const style = window.getComputedStyle(element);
  return [
    `computedScheme=${computedColorScheme}`,
    `inlineScheme=${element.style.colorScheme || "none"}`,
    `display=${style.display}`,
    `position=${style.position}`,
    `opacity=${style.opacity}`,
    `visibility=${style.visibility}`,
    `pointerEvents=${style.pointerEvents}`,
    `zIndex=${style.zIndex}`,
    `transform=${style.transform === "none" ? "none" : "set"}`,
    `webkitTextSecurity=${style.getPropertyValue("-webkit-text-security") || "none"}`,
  ];
}

function describeRect(rect: DOMRect): string {
  return `x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`;
}

function debugAttr(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

function formatDebugEvent(event: Event): string {
  const time = performance.now().toFixed(1);
  const target =
    event.target instanceof HTMLElement
      ? `${event.target.tagName.toLowerCase()}.${Array.from(event.target.classList).join(".")}`
      : String((event.target as Node | null)?.nodeName ?? "none");
  const active =
    document.activeElement instanceof HTMLElement
      ? `${document.activeElement.tagName.toLowerCase()}.${Array.from(
          document.activeElement.classList,
        ).join(".")}`
      : String(document.activeElement?.nodeName ?? "none");
  const vv = window.visualViewport;
  const parts = [
    `${time} ${event.type}`,
    `target=${target}`,
    `active=${active}`,
    `vv=${Math.round(vv?.height ?? 0)}x${Math.round(vv?.width ?? 0)} top=${Math.round(
      vv?.offsetTop ?? 0,
    )}`,
  ];
  if (event instanceof KeyboardEvent) {
    parts.push(
      `key=${event.key}`,
      `code=${event.code}`,
      `mods=${event.metaKey ? "M" : ""}${event.ctrlKey ? "C" : ""}${event.altKey ? "A" : ""}${
        event.shiftKey ? "S" : ""
      }`,
      `comp=${event.isComposing}`,
    );
  }
  if (event instanceof InputEvent) {
    parts.push(
      `inputType=${event.inputType}`,
      `dataLen=${event.data?.length ?? 0}`,
      `comp=${event.isComposing}`,
    );
  }
  if (event instanceof CompositionEvent) {
    parts.push(`dataLen=${event.data.length}`);
  }
  if (event instanceof PointerEvent) {
    parts.push(
      `pointer=${event.pointerType}`,
      `xy=${Math.round(event.clientX)},${Math.round(event.clientY)}`,
    );
  } else if (event instanceof MouseEvent) {
    parts.push(`xy=${Math.round(event.clientX)},${Math.round(event.clientY)}`);
  }
  return parts.join(" ");
}

function isPtyInputDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (!import.meta.env.DEV) return false;
  const search = new URLSearchParams(window.location.search);
  if (search.has("debugInput")) return true;
  const [, hashSearch = ""] = window.location.hash.split("?");
  return new URLSearchParams(hashSearch).has("debugInput");
}
