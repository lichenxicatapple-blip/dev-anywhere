import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  CompositionEvent,
  CSSProperties,
  FocusEvent,
  FormEvent,
  KeyboardEvent,
} from "react";
import { Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app-store";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";

type ImeCaseId =
  | "native-input"
  | "native-textarea"
  | "transparent-textarea"
  | "light-scheme-textarea"
  | "dark-scheme-textarea";

type ImeCaseKind = "input" | "textarea";

interface ImeCase {
  id: ImeCaseId;
  kind: ImeCaseKind;
  label: string;
  detail: string;
  className?: string;
  style?: CSSProperties;
}

interface ImeEventLog {
  id: number;
  atMs: number;
  eventType: string;
  caseId: ImeCaseId;
  label: string;
  value: string;
  valueLength: number;
  key?: string;
  code?: string;
  inputType?: string;
  data?: string | null;
  isComposing?: boolean;
  modifiers?: {
    alt: boolean;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    repeat?: boolean;
  };
  target: ElementSnapshot | null;
  activeElement: ElementSnapshot | null;
  viewport: ViewportSnapshot;
}

interface ElementSnapshot {
  tagName: string;
  type?: string;
  dataImeCase?: string | null;
  inputMode?: string;
  enterKeyHint?: string;
  autocomplete?: string | null;
  autocorrect?: string | null;
  spellcheck?: boolean;
  style: {
    colorScheme: string;
    color: string;
    backgroundColor: string;
    caretColor: string;
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
    webkitAppearance: string;
  };
}

interface ViewportSnapshot {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  documentClientWidth: number;
  documentClientHeight: number;
  visualViewport: {
    width: number;
    height: number;
    offsetTop: number;
    offsetLeft: number;
    pageTop: number;
    pageLeft: number;
    scale: number;
  } | null;
}

interface ImeEnvironment {
  capturedAt: string;
  href: string;
  userAgent: string;
  platform: string;
  language: string;
  languages: readonly string[];
  maxTouchPoints: number;
  standaloneNavigator: boolean | null;
  displayMode: {
    browser: boolean;
    standalone: boolean;
    fullscreen: boolean;
    minimalUi: boolean;
  };
  media: {
    prefersDark: boolean;
    prefersLight: boolean;
    forcedColors: boolean;
  };
  app: {
    desktopInteractionMode: boolean;
    ptyScrollTraceEnabled: boolean;
  };
  viewport: ViewportSnapshot;
  documentElement: ElementSnapshot | null;
  body: ElementSnapshot | null;
  activeElement: ElementSnapshot | null;
}

const IME_CASES: ImeCase[] = [
  {
    id: "native-input",
    kind: "input",
    label: "标准 input",
    detail: "浏览器原生单行输入框。",
  },
  {
    id: "native-textarea",
    kind: "textarea",
    label: "标准 textarea",
    detail: "浏览器原生多行输入框。",
  },
  {
    id: "transparent-textarea",
    kind: "textarea",
    label: "透明 textarea",
    detail: "接近会话输入框的透明背景形态。",
    className: "bg-transparent dark:bg-transparent",
  },
  {
    id: "light-scheme-textarea",
    kind: "textarea",
    label: "浅色上下文",
    detail: "仅用于对照系统候选窗是否受 color-scheme 影响。",
    className: "border-zinc-300 bg-white text-zinc-950 caret-zinc-950 placeholder:text-zinc-500",
    style: { colorScheme: "light" },
  },
  {
    id: "dark-scheme-textarea",
    kind: "textarea",
    label: "深色上下文",
    detail: "仅用于对照系统候选窗是否受 color-scheme 影响。",
    className: "border-zinc-600 bg-zinc-950 text-zinc-100 caret-zinc-100 placeholder:text-zinc-500",
    style: { colorScheme: "dark" },
  },
];

const MAX_EVENTS = 200;

function createInitialValues(): Record<ImeCaseId, string> {
  return {
    "native-input": "",
    "native-textarea": "",
    "transparent-textarea": "",
    "light-scheme-textarea": "",
    "dark-scheme-textarea": "",
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? Math.round(performance.now()) : Date.now();
}

function matchesMedia(query: string): boolean {
  return typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
}

function getViewportSnapshot(): ViewportSnapshot {
  const visualViewport = window.visualViewport
    ? {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        offsetTop: window.visualViewport.offsetTop,
        offsetLeft: window.visualViewport.offsetLeft,
        pageTop: window.visualViewport.pageTop,
        pageLeft: window.visualViewport.pageLeft,
        scale: window.visualViewport.scale,
      }
    : null;

  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    documentClientWidth: document.documentElement.clientWidth,
    documentClientHeight: document.documentElement.clientHeight,
    visualViewport,
  };
}

function getElementSnapshot(element: Element | null): ElementSnapshot | null {
  if (!(element instanceof HTMLElement)) return null;
  const computed = window.getComputedStyle(element);
  const textControl = element as HTMLInputElement | HTMLTextAreaElement;

  return {
    tagName: element.tagName,
    type: element instanceof HTMLInputElement ? element.type : undefined,
    dataImeCase: element.getAttribute("data-ime-case"),
    inputMode: textControl.inputMode,
    enterKeyHint: textControl.enterKeyHint,
    autocomplete: element.getAttribute("autocomplete"),
    autocorrect: element.getAttribute("autocorrect"),
    spellcheck: textControl.spellcheck,
    style: {
      colorScheme: computed.colorScheme,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      caretColor: computed.caretColor,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
      webkitAppearance: computed.getPropertyValue("-webkit-appearance"),
    },
  };
}

function getEnvironmentSnapshot(): ImeEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  const appState = useAppStore.getState();

  return {
    capturedAt: new Date().toISOString(),
    href: window.location.href,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    maxTouchPoints: navigator.maxTouchPoints,
    standaloneNavigator: typeof nav.standalone === "boolean" ? nav.standalone : null,
    displayMode: {
      browser: matchesMedia("(display-mode: browser)"),
      standalone: matchesMedia("(display-mode: standalone)"),
      fullscreen: matchesMedia("(display-mode: fullscreen)"),
      minimalUi: matchesMedia("(display-mode: minimal-ui)"),
    },
    media: {
      prefersDark: matchesMedia("(prefers-color-scheme: dark)"),
      prefersLight: matchesMedia("(prefers-color-scheme: light)"),
      forcedColors: matchesMedia("(forced-colors: active)"),
    },
    app: {
      desktopInteractionMode: appState.desktopInteractionMode,
      ptyScrollTraceEnabled: appState.ptyScrollTraceEnabled,
    },
    viewport: getViewportSnapshot(),
    documentElement: getElementSnapshot(document.documentElement),
    body: getElementSnapshot(document.body),
    activeElement: getElementSnapshot(document.activeElement),
  };
}

function formatEventLine(event: ImeEventLog): string {
  const pieces = [
    `${event.atMs}ms`,
    event.label,
    event.eventType,
    event.key ? `key=${event.key}` : null,
    event.inputType ? `inputType=${event.inputType}` : null,
    event.data ? `data=${event.data}` : null,
    event.isComposing ? "composing" : null,
    `len=${event.valueLength}`,
  ].filter(Boolean);
  return pieces.join("  ");
}

function buildReport(events: ImeEventLog[]): string {
  return [
    "DEV Anywhere IME diagnostics",
    "",
    JSON.stringify(
      {
        environment: getEnvironmentSnapshot(),
        events,
      },
      null,
      2,
    ),
  ].join("\n");
}

export function ImeDiagnosticsPanel() {
  const desktopInteractionMode = useAppStore((s) => s.desktopInteractionMode);
  const [values, setValues] = useState<Record<ImeCaseId, string>>(() => createInitialValues());
  const [events, setEvents] = useState<ImeEventLog[]>([]);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const nextEventId = useRef(1);

  const eventPreview = useMemo(() => {
    const recent = events.slice(-28).map(formatEventLine);
    return recent.length > 0 ? recent.join("\n") : "暂无输入事件。";
  }, [events]);

  const pushEvent = useCallback(
    (
      imeCase: ImeCase,
      eventType: string,
      target: HTMLInputElement | HTMLTextAreaElement,
      extra: Partial<ImeEventLog> = {},
    ) => {
      const event: ImeEventLog = {
        id: nextEventId.current,
        atMs: nowMs(),
        eventType,
        caseId: imeCase.id,
        label: imeCase.label,
        value: target.value,
        valueLength: target.value.length,
        target: getElementSnapshot(target),
        activeElement: getElementSnapshot(document.activeElement),
        viewport: getViewportSnapshot(),
        ...extra,
      };
      nextEventId.current += 1;
      setCopyStatus(null);
      setEvents((current) => [...current, event].slice(-MAX_EVENTS));
    },
    [],
  );

  const handleChange = useCallback(
    (imeCase: ImeCase, event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.currentTarget.value;
      setValues((current) => ({ ...current, [imeCase.id]: value }));
      pushEvent(imeCase, "react-change", event.currentTarget);
    },
    [pushEvent],
  );

  const handleKeyboardEvent = useCallback(
    (imeCase: ImeCase, event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      pushEvent(imeCase, event.type, event.currentTarget, {
        key: event.key,
        code: event.code,
        isComposing: event.nativeEvent.isComposing,
        modifiers: {
          alt: event.altKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
          repeat: event.repeat,
        },
      });
    },
    [pushEvent],
  );

  const handleInputEvent = useCallback(
    (imeCase: ImeCase, event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nativeEvent = event.nativeEvent as InputEvent;
      pushEvent(imeCase, event.type, event.currentTarget, {
        inputType: nativeEvent.inputType,
        data: nativeEvent.data,
        isComposing: nativeEvent.isComposing,
      });
    },
    [pushEvent],
  );

  const handleCompositionEvent = useCallback(
    (imeCase: ImeCase, event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      pushEvent(imeCase, event.type, event.currentTarget, {
        data: event.data,
      });
    },
    [pushEvent],
  );

  const handleFocusEvent = useCallback(
    (imeCase: ImeCase, event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      pushEvent(imeCase, event.type, event.currentTarget);
    },
    [pushEvent],
  );

  const copyReport = useCallback(async () => {
    const result = await copyText(buildReport(events));
    setCopyStatus(result === "clipboard" ? "已复制诊断报告" : "复制失败，请在 HTTPS 页面重试");
  }, [events]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setValues(createInitialValues());
    setCopyStatus(null);
  }, []);

  return (
    <div
      className="dev-render-scroll min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-1"
      data-slot="settings-dialog-body"
    >
      <div className="rounded-lg border border-border bg-card/55 p-3">
        <div className="text-sm font-medium text-foreground">现场采样</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          在下面几个输入框里切换输入法、输入中文和标点，然后复制报告。报告会包含测试框中的输入文本，以及浏览器可见的事件、样式和视口信息。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={copyReport}>
            <Copy className="size-4" aria-hidden="true" />
            复制报告
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={clearEvents}>
            <RotateCcw className="size-4" aria-hidden="true" />
            清空
          </Button>
          <span className="text-xs text-muted-foreground">
            {copyStatus ?? `事件 ${events.length} 条`}
          </span>
        </div>
      </div>

      <div className="grid gap-3" data-slot="ime-diagnostics-fields">
        {IME_CASES.map((imeCase) => {
          const inputId = `ime-diagnostics-${imeCase.id}`;
          const fieldClassName = cn(
            "w-full rounded-md border border-input bg-muted px-3 py-2 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/55 focus:ring-2 focus:ring-ring/45 md:text-sm",
            imeCase.kind === "textarea" && "min-h-20 resize-y leading-6",
            imeCase.className,
          );

          return (
            <label
              key={imeCase.id}
              htmlFor={inputId}
              className="block rounded-lg border border-border bg-card/55 p-3"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-foreground">{imeCase.label}</span>
                {desktopInteractionMode ? (
                  <span className="shrink-0 text-xs text-muted-foreground">桌面交互</span>
                ) : null}
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {imeCase.detail}
              </span>
              <span className="mt-2 block">
                {imeCase.kind === "input" ? (
                  <input
                    id={inputId}
                    aria-label={imeCase.label}
                    data-ime-case={imeCase.id}
                    value={values[imeCase.id]}
                    onChange={(event) => handleChange(imeCase, event)}
                    onBeforeInput={(event) => handleInputEvent(imeCase, event)}
                    onInput={(event) => handleInputEvent(imeCase, event)}
                    onCompositionStart={(event) => handleCompositionEvent(imeCase, event)}
                    onCompositionUpdate={(event) => handleCompositionEvent(imeCase, event)}
                    onCompositionEnd={(event) => handleCompositionEvent(imeCase, event)}
                    onKeyDown={(event) => handleKeyboardEvent(imeCase, event)}
                    onKeyUp={(event) => handleKeyboardEvent(imeCase, event)}
                    onFocus={(event) => handleFocusEvent(imeCase, event)}
                    onBlur={(event) => handleFocusEvent(imeCase, event)}
                    className={fieldClassName}
                    placeholder="输入中文、标点和快捷键"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    style={imeCase.style}
                  />
                ) : (
                  <Textarea
                    id={inputId}
                    aria-label={imeCase.label}
                    data-ime-case={imeCase.id}
                    value={values[imeCase.id]}
                    onChange={(event) => handleChange(imeCase, event)}
                    onBeforeInput={(event) => handleInputEvent(imeCase, event)}
                    onInput={(event) => handleInputEvent(imeCase, event)}
                    onCompositionStart={(event) => handleCompositionEvent(imeCase, event)}
                    onCompositionUpdate={(event) => handleCompositionEvent(imeCase, event)}
                    onCompositionEnd={(event) => handleCompositionEvent(imeCase, event)}
                    onKeyDown={(event) => handleKeyboardEvent(imeCase, event)}
                    onKeyUp={(event) => handleKeyboardEvent(imeCase, event)}
                    onFocus={(event) => handleFocusEvent(imeCase, event)}
                    onBlur={(event) => handleFocusEvent(imeCase, event)}
                    className={fieldClassName}
                    placeholder="输入中文、标点和多行内容"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    style={imeCase.style}
                  />
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card/55 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">最近事件</div>
          <div className="text-xs text-muted-foreground">最多保留 {MAX_EVENTS} 条</div>
        </div>
        <pre
          className="mt-2 max-h-44 overflow-auto rounded-md border border-border bg-background/80 p-2 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap"
          data-slot="ime-diagnostics-event-preview"
        >
          {eventPreview}
        </pre>
      </div>
    </div>
  );
}
