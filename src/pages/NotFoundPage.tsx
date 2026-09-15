import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <Logo />
      <Compass size={44} strokeWidth={1.25} className="mt-8 text-gray-300" aria-hidden />
      <h1 className="mt-4 text-title-sm font-bold text-gray-900">Page not found</h1>
      <p className="mt-1 max-w-sm text-theme-sm text-gray-500">
        The page you are looking for does not exist or has been moved.
      </p>
      <Link
        to="/dashboard"
        className="mt-5 rounded-lg bg-brand-600 px-4 py-2 text-theme-sm font-medium text-white hover:bg-brand-700"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
