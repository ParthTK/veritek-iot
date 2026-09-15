import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Info, X, XCircle, AlertTriangle } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (title: string, options?: { description?: string; variant?: ToastVariant }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof Info; ring: string; iconColor: string }> = {
  success: { icon: CheckCircle2, ring: 'border-success-200', iconColor: 'text-success-600' },
  error: { icon: XCircle, ring: 'border-error-200', iconColor: 'text-error-600' },
  warning: { icon: AlertTriangle, ring: 'border-warning-200', iconColor: 'text-warning-600' },
  info: { icon: Info, ring: 'border-brand-200', iconColor: 'text-brand-600' },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>(
    (title, options) => {
      const id = nextId++;
      setToasts((prev) => [
        ...prev,
        { id, title, description: options?.description, variant: options?.variant ?? 'success' },
      ]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((t) => {
          const { icon: Icon, ring, iconColor } = VARIANT_STYLES[t.variant];
          return (
            <div
              key={t.id}
              role="status"
              aria-live="polite"
              className={`pointer-events-auto flex animate-toast-in items-start gap-3 rounded-lg border ${ring} bg-white p-3 shadow-theme-lg`}
            >
              <Icon className={`mt-0.5 shrink-0 ${iconColor}`} size={18} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-theme-sm font-medium text-gray-800">{t.title}</p>
                {t.description ? (
                  <p className="mt-0.5 text-theme-xs text-gray-500">{t.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label="Dismiss notification"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
