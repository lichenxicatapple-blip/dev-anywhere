// 自定义 Toast 组件，暗色主题，顶部滑入，替代 Taro.showToast
// 使用原生 DOM 渲染避免 Taro View 组件的布局干扰
import { useEffect, useCallback, useRef } from "react";
import "./index.css";

type ToastType = "info" | "error";

let pushHandler: ((message: string, duration?: number, type?: ToastType) => void) | null = null;

export function showToast(message: string, duration = 3000): void {
  pushHandler?.(message, duration, "info");
}

export function showErrorToast(message: string, duration = 4000): void {
  pushHandler?.(message, duration, "error");
}

let nextId = 0;

function createToastElement(message: string, duration: number, type: ToastType = "info"): void {
  const container = getOrCreateContainer();

  const item = document.createElement("div");
  item.className = `toast-item toast-item-enter${type === "error" ? " toast-item-error" : ""}`;
  item.textContent = message;
  item.id = `toast-${nextId++}`;
  container.appendChild(item);

  setTimeout(() => {
    item.className = item.className.replace("toast-item-enter", "toast-item-exit");
    setTimeout(() => {
      item.remove();
      if (container.childElementCount === 0) {
        container.remove();
      }
    }, 300);
  }, duration);
}

function getOrCreateContainer(): HTMLElement {
  let container = document.getElementById("toast-root");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-root";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function ToastContainer() {
  const registered = useRef(false);

  const push = useCallback((message: string, duration = 3000, type: ToastType = "info") => {
    createToastElement(message, duration, type);
  }, []);

  useEffect(() => {
    if (!registered.current) {
      pushHandler = push;
      registered.current = true;
    }
    return () => {
      pushHandler = null;
      registered.current = false;
    };
  }, [push]);

  return null;
}
