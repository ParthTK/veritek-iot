import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronLeft, Eye, EyeOff } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { useAuth } from '@/hooks/useAuth';
import { DEMO_CREDENTIALS } from '@/data/seed';
import { cn } from '@/utils/cn';

import loginHero from '@/assets/login-hero.jpg';
import loginHeroTall from '@/assets/login-hero-tall.jpg';

/**
 * Sign in, laid out on the tavvlo-company-dashboard auth screen with the
 * template's indigo accent replaced by Veritek orange.
 *
 * Brand panel on the left, form on the right. The panel carries the Veritek
 * hero artwork, which is 16:9 — rather than stretch or crop it into a tall
 * half-screen column, it is presented at its own aspect ratio and centred, so
 * the whole frame is visible and correctly proportioned at every width.
 */

const HERO_ALT =
  'Veritek Engineering — Engineering Smarter Solutions For A Brighter Tomorrow';

export function LoginPage() {
  const { isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState(DEMO_CREDENTIALS.email);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepLoggedIn, setKeepLoggedIn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const next: typeof fieldErrors = {};
    if (!email.trim()) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Password is required.';
    setFieldErrors(next);
    if (Object.keys(next).length > 0) return;

    setLoading(true);
    const result = await signIn(email, password);
    setLoading(false);

    if (result.ok) navigate('/dashboard', { replace: true });
    else setError(result.error ?? 'Unable to sign in.');
  }

  const unavailable = (what: string) => () => {
    setError(null);
    setNotice(`${what} is not available in this demo. Use the credentials shown below.`);
  };

  return (
    <div className="relative z-10 bg-white">
      <div className="relative flex min-h-screen w-full flex-col lg:flex-row">
        {/* Small screens: full-bleed across the top, natural aspect ratio, so
            the entire image is shown with no cropping and no bars. */}
        <img src={loginHero} alt={HERO_ALT} className="block w-full lg:hidden" />

        {/* ------------------------------------ brand panel (left) -- */}
        {/* A 4:5 recomposition of the same artwork: the 16:9 hero sits centred
            and feathers into a blurred, darkened extension of its own photo.
            That lets the panel be filled edge to edge at full height without
            cropping the globe or the tagline, which a straight `cover` of the
            16:9 original does at this column's aspect ratio. */}
        <div className="relative hidden overflow-hidden bg-veritek-950 lg:block lg:w-1/2">
          <img
            src={loginHeroTall}
            alt={HERO_ALT}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* ------------------------------------- form column (right) -- */}
        <div className="flex flex-1 flex-col px-6 py-6 sm:px-8 lg:w-1/2">
          <div className="mx-auto w-full max-w-md">
            <button
              type="button"
              onClick={unavailable('Returning to the marketing site')}
              className="inline-flex items-center gap-1 text-theme-sm text-gray-500 transition-colors hover:text-gray-700"
            >
              <ChevronLeft size={18} aria-hidden />
              Back to website
            </button>
          </div>

          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8">
            <div className="mb-6 sm:mb-8">
              <Logo height={32} className="mb-6" />
              <h1 className="mb-2 text-title-sm font-semibold text-gray-800">Sign In</h1>
              <p className="text-theme-sm text-gray-500">
                Enter your email and password to sign in!
              </p>
            </div>

            {error ? (
              <div
                role="alert"
                className="mb-5 flex items-start gap-2 rounded-lg border border-error-200 bg-error-50 px-3 py-2.5"
              >
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-error-600" aria-hidden />
                <p className="text-theme-xs text-error-700">{error}</p>
              </div>
            ) : null}

            {notice ? (
              <div
                role="status"
                className="mb-5 flex items-start gap-2 rounded-lg border border-veritek-200 bg-veritek-25 px-3 py-2.5"
              >
                <AlertCircle size={15} className="mt-0.5 shrink-0 text-veritek-700" aria-hidden />
                <p className="text-theme-xs text-veritek-900">{notice}</p>
              </div>
            ) : null}

            <form onSubmit={handleSubmit} noValidate>
              <div className="space-y-5">
                <div>
                  <label htmlFor="email" className="field-label">
                    Email <span className="text-error-500">*</span>
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="info@veritek.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.email) || undefined}
                    className={cn(
                      'h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 text-theme-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-veritek-500 focus:outline-none focus:ring focus:ring-veritek-500/15',
                      fieldErrors.email && 'border-error-400 focus:border-error-500',
                    )}
                  />
                  {fieldErrors.email ? (
                    <p className="mt-1 text-theme-2xs text-error-600" role="alert">
                      {fieldErrors.email}
                    </p>
                  ) : null}
                </div>

                <div>
                  <label htmlFor="password" className="field-label">
                    Password <span className="text-error-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      aria-invalid={Boolean(fieldErrors.password) || undefined}
                      className={cn(
                        'h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 pr-12 text-theme-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-veritek-500 focus:outline-none focus:ring focus:ring-veritek-500/15',
                        fieldErrors.password && 'border-error-400 focus:border-error-500',
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-4 top-1/2 z-30 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <Eye size={18} aria-hidden />
                      ) : (
                        <EyeOff size={18} aria-hidden />
                      )}
                    </button>
                  </div>
                  {fieldErrors.password ? (
                    <p className="mt-1 text-theme-2xs text-error-600" role="alert">
                      {fieldErrors.password}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={keepLoggedIn}
                      onChange={(e) => setKeepLoggedIn(e.target.checked)}
                      className="h-5 w-5 rounded border-gray-300 accent-veritek-600"
                    />
                    <span className="block text-theme-sm font-normal text-gray-700">
                      Keep me logged in
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={unavailable('Password recovery')}
                    className="text-theme-sm font-medium text-veritek-700 hover:text-veritek-800"
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-veritek-700 text-theme-sm font-medium text-white shadow-theme-xs transition-colors hover:bg-veritek-800 disabled:cursor-not-allowed disabled:bg-veritek-300"
                >
                  {loading ? (
                    <>
                      <span
                        className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                        aria-hidden
                      />
                      Signing in…
                    </>
                  ) : (
                    'Sign in'
                  )}
                </button>
              </div>
            </form>

            <div className="mt-5">
              <p className="text-center text-theme-sm font-normal text-gray-700 sm:text-start">
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={unavailable('Self-service sign-up')}
                  className="font-medium text-veritek-700 hover:text-veritek-800"
                >
                  Sign Up
                </button>
              </p>
            </div>

            <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
              <p className="text-theme-2xs font-medium text-gray-600">Demo credentials</p>
              <p className="mt-0.5 text-theme-2xs text-gray-500">
                {DEMO_CREDENTIALS.email} · {DEMO_CREDENTIALS.password}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
