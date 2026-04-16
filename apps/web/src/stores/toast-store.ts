// Toast 通知状态管理：临时消息队列，自动移除
import { create } from "zustand";

interface Toast {
  id: number;
  message: string;
}

interface ToastStoreState {
  toasts: Toast[];

  showToast: (message: string) => void;
  removeToast: (id: number) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStoreState>()(
  (set) => ({
    toasts: [],

    showToast: (message) => {
      const id = nextId++;
      set((state) => ({ toasts: [...state.toasts, { id, message }] }));
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, 3000);
    },

    removeToast: (id) =>
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      })),
  }),
);
