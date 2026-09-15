import { useState } from 'react';
import type { FormEvent } from 'react';
import { Eye, EyeOff, LogOut, UserCircle } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Form';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { saveUser, siteName } from '@/services';
import { DEMO_CREDENTIALS } from '@/data/seed';
import { formatDateTime } from '@/utils/format';

/** Profile details plus a change-password form (validated, no backend). */
export function ProfilePage() {
  const { user, updateUser, signOut } = useAuth();
  const { toast } = useToast();

  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});

  if (!user) return null;

  function saveProfile(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (!phone.trim()) errors.phone = 'Phone number is required.';
    setProfileErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const updated = { ...user!, name: name.trim(), phone: phone.trim() };
    saveUser(updated);
    updateUser(updated);
    toast('Profile updated', { description: 'Your details were saved.' });
  }

  function changePassword(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!current) errors.current = 'Enter your current password.';
    else if (current !== DEMO_CREDENTIALS.password)
      errors.current = 'Current password is incorrect.';
    if (!next) errors.next = 'Enter a new password.';
    else if (next.length < 8) errors.next = 'Use at least 8 characters.';
    else if (next === current) errors.next = 'New password must differ from the current one.';
    if (confirm !== next) errors.confirm = 'Passwords do not match.';

    setPwErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setCurrent('');
    setNext('');
    setConfirm('');
    toast('Password changed', {
      description: 'In this demo the change is not persisted — the original password still works.',
      variant: 'info',
    });
  }

  return (
    <>
      <PageHeader
        title="Profile & Account"
        icon={<UserCircle size={20} aria-hidden />}
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Profile' }]}
        actions={
          <Button variant="outline" onClick={signOut}>
            <LogOut size={14} aria-hidden />
            Logout
          </Button>
        }
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardBody className="pt-5">
            <div className="flex flex-col items-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-theme-xl font-semibold text-brand-700">
                {user.avatarInitials}
              </span>
              <p className="mt-3 text-theme-lg font-semibold text-gray-900">{user.name}</p>
              <p className="text-theme-xs text-gray-500">{user.email}</p>
              <div className="mt-2">
                <Badge tone="info">{user.role}</Badge>
              </div>
            </div>

            <dl className="mt-5 divide-y divide-gray-100">
              {[
                ['Phone', user.phone],
                ['Assigned sites', user.assignedSites.map((s) => siteName(s)).join(', ') || '—'],
                ['Account status', user.active ? 'Active' : 'Inactive'],
                ['Last login', user.lastLogin ? formatDateTime(user.lastLogin) : 'Never'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-theme-xs text-gray-500">{label}</dt>
                  <dd className="text-right text-theme-xs font-medium text-gray-800">{value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <div className="space-y-5 xl:col-span-2">
          <form onSubmit={saveProfile}>
            <Card>
              <CardHeader title="Profile details" description="Update your contact information" />
              <CardBody>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Full Name" htmlFor="p-name" required error={profileErrors.name}>
                    <TextInput
                      id="p-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      invalid={Boolean(profileErrors.name)}
                    />
                  </Field>
                  <Field label="Phone" htmlFor="p-phone" required error={profileErrors.phone}>
                    <TextInput
                      id="p-phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      invalid={Boolean(profileErrors.phone)}
                    />
                  </Field>
                  <Field label="Email" htmlFor="p-email" hint="Email cannot be changed in this demo">
                    <TextInput id="p-email" value={user.email} disabled />
                  </Field>
                  <Field label="Role" htmlFor="p-role" hint="Assigned by an administrator">
                    <TextInput id="p-role" value={user.role} disabled />
                  </Field>
                </div>
                <div className="mt-5 flex justify-end">
                  <Button type="submit">Save changes</Button>
                </div>
              </CardBody>
            </Card>
          </form>

          <form onSubmit={changePassword}>
            <Card>
              <CardHeader
                title="Change password"
                description={`Demo password is "${DEMO_CREDENTIALS.password}"`}
              />
              <CardBody>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Current Password"
                    htmlFor="p-current"
                    required
                    error={pwErrors.current}
                  >
                    <TextInput
                      id="p-current"
                      type={show ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      invalid={Boolean(pwErrors.current)}
                      trailing={
                        <button
                          type="button"
                          onClick={() => setShow((v) => !v)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          aria-label={show ? 'Hide passwords' : 'Show passwords'}
                        >
                          {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                        </button>
                      }
                    />
                  </Field>
                  <Field label="New Password" htmlFor="p-next" required error={pwErrors.next}>
                    <TextInput
                      id="p-next"
                      type={show ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={next}
                      onChange={(e) => setNext(e.target.value)}
                      invalid={Boolean(pwErrors.next)}
                    />
                  </Field>
                  <Field
                    label="Confirm Password"
                    htmlFor="p-confirm"
                    required
                    error={pwErrors.confirm}
                  >
                    <TextInput
                      id="p-confirm"
                      type={show ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      invalid={Boolean(pwErrors.confirm)}
                    />
                  </Field>
                </div>
                <div className="mt-5 flex justify-end">
                  <Button type="submit">Update password</Button>
                </div>
              </CardBody>
            </Card>
          </form>
        </div>
      </div>
    </>
  );
}
