import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Eye, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { DataTable } from '@/components/tables/DataTable';
import type { Column } from '@/components/tables/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import {
  createUserId,
  deleteUser,
  listDevices,
  listSites,
  saveUser,
  siteName,
  toggleUserActive,
} from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { User, UserRole } from '@/types';
import { formatDateTime } from '@/utils/format';

const ROLES: UserRole[] = ['Super Admin', 'Admin', 'Operator', 'Viewer'];

const ROLE_TONE: Record<UserRole, 'error' | 'info' | 'warning' | 'neutral'> = {
  'Super Admin': 'error',
  Admin: 'info',
  Operator: 'warning',
  Viewer: 'neutral',
};

function blankUser(): User {
  return {
    id: createUserId(),
    name: '',
    email: '',
    phone: '',
    role: 'Viewer',
    assignedSites: [],
    assignedDevices: [],
    active: true,
    lastLogin: null,
    avatarInitials: '',
  };
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** User management table plus the add / edit / view modal. */
export function UsersPage() {
  const users = useStore((s) => s.users);
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | UserRole>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<User>(blankUser());
  const [isNew, setIsNew] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (role !== 'all' && u.role !== role) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.phone.toLowerCase().includes(q)
      );
    });
  }, [users, query, role]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  function openForm(user: User | null, view = false) {
    setDraft(user ? { ...user } : blankUser());
    setIsNew(user === null);
    setReadOnly(view);
    setErrors({});
    setOpen(true);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = 'Name is required.';
    if (!draft.email.trim()) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
      next.email = 'Enter a valid email address.';
    if (!draft.phone.trim()) next.phone = 'Phone number is required.';
    if (users.some((u) => u.email.toLowerCase() === draft.email.trim().toLowerCase() && u.id !== draft.id))
      next.email = 'Another user already uses this email address.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    saveUser({ ...draft, avatarInitials: initialsFor(draft.name) });
    toast(isNew ? 'User added' : 'User updated', { description: draft.name });
    setOpen(false);
  }

  function toggleSite(siteId: string) {
    setDraft((prev) => ({
      ...prev,
      assignedSites: prev.assignedSites.includes(siteId)
        ? prev.assignedSites.filter((s) => s !== siteId)
        : [...prev.assignedSites, siteId],
    }));
  }

  function toggleDevice(deviceId: string) {
    setDraft((prev) => ({
      ...prev,
      assignedDevices: prev.assignedDevices.includes(deviceId)
        ? prev.assignedDevices.filter((d) => d !== deviceId)
        : [...prev.assignedDevices, deviceId],
    }));
  }

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      sticky: true,
      sortValue: (u) => u.name,
      className: 'bg-white',
      render: (u) => (
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-theme-2xs font-semibold text-brand-700">
            {u.avatarInitials || initialsFor(u.name)}
          </span>
          <div>
            <p className="font-medium text-gray-800">{u.name}</p>
            <p className="text-theme-2xs text-gray-500">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', sortValue: (u) => u.phone },
    {
      key: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      render: (u) => <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>,
    },
    {
      key: 'assigned',
      header: 'Assigned Sites / Devices',
      render: (u) => (
        <div className="max-w-[220px]">
          <p className="truncate text-gray-700">
            {u.assignedSites.length > 0
              ? u.assignedSites.map((s) => siteName(s)).join(', ')
              : '—'}
          </p>
          <p className="text-theme-2xs text-gray-500">
            {u.assignedDevices.length > 0
              ? `${u.assignedDevices.length} device${u.assignedDevices.length === 1 ? '' : 's'}`
              : 'All devices in sites'}
          </p>
        </div>
      ),
    },
    {
      key: 'lastLogin',
      header: 'Last Login',
      sortValue: (u) => (u.lastLogin ? Date.parse(u.lastLogin) : 0),
      render: (u) => (u.lastLogin ? formatDateTime(u.lastLogin) : <span className="text-gray-400">Never</span>),
    },
    {
      key: 'active',
      header: 'Status',
      render: (u) => (
        <div className="flex items-center gap-2">
          <Toggle
            checked={u.active}
            onChange={() => {
              toggleUserActive(u.id);
              toast(u.active ? 'User deactivated' : 'User activated', {
                description: u.name,
                variant: u.active ? 'warning' : 'success',
              });
            }}
            label={`${u.active ? 'Deactivate' : 'Activate'} ${u.name}`}
            hideLabel
          />
          <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (u) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => openForm(u, true)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-600"
            aria-label={`View ${u.name}`}
          >
            <Eye size={15} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => openForm(u)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-600"
            aria-label={`Edit ${u.name}`}
          >
            <Pencil size={15} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(u)}
            className="rounded p-1.5 text-gray-500 hover:bg-error-50 hover:text-error-600"
            aria-label={`Delete ${u.name}`}
          >
            <Trash2 size={15} aria-hidden />
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="User Management"
        icon={<Users size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Administration' },
          { label: 'Users' },
        ]}
        actions={
          <Button onClick={() => openForm(null)}>
            <Plus size={15} aria-hidden />
            Add User
          </Button>
        }
      />

      <Card className="mb-4">
        <CardBody className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label htmlFor="user-search" className="field-label">
                Search
              </label>
              <TextInput
                id="user-search"
                type="search"
                placeholder="Name, email or phone…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                icon={<Search size={15} />}
              />
            </div>
            <div>
              <label htmlFor="user-role" className="field-label">
                Role
              </label>
              <SelectInput
                id="user-role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as typeof role);
                  setPage(1);
                }}
                className="min-w-[150px]"
              >
                <option value="all">All roles</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </SelectInput>
            </div>
            {(query || role !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setRole('all');
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={paged}
          rowKey={(u) => u.id}
          emptyTitle="No users found"
          emptyDescription="No user matches the current search and role filter."
        />
        {filtered.length > 0 ? (
          <CardFooter>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </CardFooter>
        ) : null}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={readOnly ? 'User Details' : isNew ? 'Add User' : 'Edit User'}
        size="lg"
        footer={
          readOnly ? (
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>Save User</Button>
            </>
          )
        }
      >
        <form onSubmit={handleSubmit} noValidate>
          <fieldset disabled={readOnly} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full Name" htmlFor="u-name" required error={errors.name}>
                <TextInput
                  id="u-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  invalid={Boolean(errors.name)}
                />
              </Field>
              <Field label="Email" htmlFor="u-email" required error={errors.email}>
                <TextInput
                  id="u-email"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  invalid={Boolean(errors.email)}
                />
              </Field>
              <Field label="Phone" htmlFor="u-phone" required error={errors.phone}>
                <TextInput
                  id="u-phone"
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  placeholder="+91 98200 41122"
                  invalid={Boolean(errors.phone)}
                />
              </Field>
              <Field label="Role" htmlFor="u-role">
                <SelectInput
                  id="u-role"
                  value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value as UserRole })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>

            <fieldset>
              <legend className="field-label">Assigned sites</legend>
              <div className="flex flex-wrap gap-2">
                {listSites().map((s) => (
                  <label
                    key={s.id}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-theme-xs hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={draft.assignedSites.includes(s.id)}
                      onChange={() => toggleSite(s.id)}
                      className="h-3.5 w-3.5 accent-brand-600"
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="field-label">Assigned devices (optional)</legend>
              <div className="flex flex-wrap gap-2">
                {listDevices().map((d) => (
                  <label
                    key={d.id}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-theme-xs hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={draft.assignedDevices.includes(d.id)}
                      onChange={() => toggleDevice(d.id)}
                      className="h-3.5 w-3.5 accent-brand-600"
                    />
                    {d.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <Toggle
              checked={draft.active}
              onChange={(v) => setDraft({ ...draft, active: v })}
              label="Account active"
              description="Inactive users cannot sign in"
            />
          </fieldset>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteUser(pendingDelete.id);
            toast('User deleted', { description: pendingDelete.name, variant: 'info' });
          }
        }}
        title="Delete user?"
        message={
          pendingDelete
            ? `"${pendingDelete.name}" will lose access. This only affects local demo data.`
            : ''
        }
        confirmLabel="Delete user"
      />
    </>
  );
}
