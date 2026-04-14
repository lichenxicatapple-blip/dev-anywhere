// 自定义暗色极客风格 Modal，替代 Taro.showModal
// 使用 createPortal 挂载到 document.body，绕过 Taro 页面容器的 transform 对 position:fixed 的影响
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import "./index.css";

interface ModalOptions {
  title: string;
  content: string;
  showCancel?: boolean;
  confirmText?: string;
  cancelText?: string;
}

interface ModalResult {
  confirm: boolean;
  cancel: boolean;
}

let showHandler: ((options: ModalOptions) => Promise<ModalResult>) | null = null;

export function showModal(options: ModalOptions): Promise<ModalResult> {
  if (!showHandler) return Promise.resolve({ confirm: false, cancel: true });
  return showHandler(options);
}

export function ModalContainer() {
  const [visible, setVisible] = useState(false);
  const [entering, setEntering] = useState(false);
  const [options, setOptions] = useState<ModalOptions | null>(null);
  const resolveRef = useRef<((result: ModalResult) => void) | null>(null);

  const handle = useCallback((opts: ModalOptions): Promise<ModalResult> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setOptions(opts);
      setVisible(true);
      setEntering(true);
    });
  }, []);

  useEffect(() => {
    showHandler = handle;
    return () => { showHandler = null; };
  }, [handle]);

  const close = useCallback((result: ModalResult) => {
    setEntering(false);
    setTimeout(() => {
      setVisible(false);
      setOptions(null);
      resolveRef.current?.(result);
      resolveRef.current = null;
    }, 200);
  }, []);

  if (!visible || !options) return null;

  const showCancel = options.showCancel !== false;

  return createPortal(
    <div
      className={`modal-overlay ${entering ? "modal-overlay-enter" : "modal-overlay-exit"}`}
      onClick={() => showCancel && close({ confirm: false, cancel: true })}
    >
      <div
        className={`modal-panel ${entering ? "modal-panel-enter" : "modal-panel-exit"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{options.title}</div>
        <div className="modal-content">{options.content}</div>
        <div className={`modal-actions ${showCancel ? "modal-actions-dual" : ""}`}>
          {showCancel && (
            <div
              className="modal-btn modal-btn-cancel"
              onClick={() => close({ confirm: false, cancel: true })}
            >
              <span className="modal-btn-cancel-text">{options.cancelText || "Cancel"}</span>
            </div>
          )}
          <div
            className="modal-btn modal-btn-confirm"
            onClick={() => close({ confirm: true, cancel: false })}
          >
            <span className="modal-btn-confirm-text">{options.confirmText || "OK"}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
