import { useToastStore } from "@/stores/toast-store";

export function Toast() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="px-4 py-2 rounded-md shadow-lg bg-[var(--card)] text-[var(--foreground)] text-sm text-center"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
