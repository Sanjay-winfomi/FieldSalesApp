import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { UserPlus, KeyRound, Power, Pencil, Trash2, Users, UserCheck, UserX, Shield, Briefcase } from 'lucide-react';
import { apiClient } from '../../api';
import {
  SectionHeader, MetricCard, SearchBar, DataTable, StatusBadge, Button, Modal,
  ConfirmationModal, TextField, EmptyState,
} from '../../components';
import { colors, spacing } from '../../theme';

const ROLE_OPTIONS = [
  { value: 'rep', label: 'Representative' },
  { value: 'manager', label: 'Manager' },
];

function initials(name) {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export default function EmployeesTab({ currentEmployeeId }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Every mutation below (create/edit/reset/deactivate/delete/activate)
  // previously closed its modal silently on success with no positive
  // feedback — a manager had no way to tell a reset password actually took
  // effect short of it failing. Auto-dismisses so it doesn't linger.
  const [successMessage, setSuccessMessage] = useState('');
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', phone: '', username: '', password: '', role: 'rep', region: '' });
  const [createError, setCreateError] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '', region: '', role: 'rep' });
  const [editError, setEditError] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);

  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivateSubmitting, setDeactivateSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/employees');
      setEmployees(res.data.employees);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load employees.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  const summary = useMemo(() => ({
    total: employees.length,
    active: employees.filter((e) => e.is_active).length,
    inactive: employees.filter((e) => !e.is_active).length,
    managers: employees.filter((e) => e.role === 'manager').length,
    reps: employees.filter((e) => e.role === 'rep').length,
  }), [employees]);

  const filteredEmployees = useMemo(() => {
    if (!searchQuery.trim()) return employees;
    const q = searchQuery.toLowerCase();
    return employees.filter((e) =>
      e.name.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || (e.region || '').toLowerCase().includes(q)
    );
  }, [employees, searchQuery]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    if (createForm.password.length < 6) {
      setCreateError('Password must be at least 6 characters.');
      return;
    }
    setCreateSubmitting(true);
    try {
      await apiClient.post('/employees', createForm);
      setCreateForm({ name: '', phone: '', username: '', password: '', role: 'rep', region: '' });
      setCreateOpen(false);
      setSuccessMessage(`${createForm.name} was added.`);
      fetchEmployees();
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Failed to create employee.');
    } finally {
      setCreateSubmitting(false);
    }
  };

  const openEdit = (emp) => {
    setEditForm({ name: emp.name, phone: emp.phone || '', region: emp.region || '', role: emp.role });
    setEditError('');
    setEditTarget(emp);
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setEditError('');
    setEditSubmitting(true);
    try {
      await apiClient.put(`/employees/${editTarget.id}`, editForm);
      setSuccessMessage(`${editForm.name}'s details were updated.`);
      setEditTarget(null);
      fetchEmployees();
    } catch (err) {
      setEditError(err.response?.data?.error || 'Failed to update employee.');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setResetError('');
    if (resetPassword.length < 6) {
      setResetError('Password must be at least 6 characters.');
      return;
    }
    setResetSubmitting(true);
    try {
      await apiClient.post(`/employees/${resetTarget.id}/reset-password`, { password: resetPassword });
      setSuccessMessage(`${resetTarget.name}'s password was reset.`);
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      setResetError(err.response?.data?.error || 'Failed to reset password.');
    } finally {
      setResetSubmitting(false);
    }
  };

  const confirmDeactivate = async () => {
    // Defense-in-depth alongside the disabled button above.
    if (deactivateTarget?.id === currentEmployeeId) {
      setDeactivateTarget(null);
      return;
    }
    setDeactivateSubmitting(true);
    try {
      await apiClient.put(`/employees/${deactivateTarget.id}`, { is_active: false });
      setSuccessMessage(`${deactivateTarget.name} was deactivated.`);
      setDeactivateTarget(null);
      fetchEmployees();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to deactivate employee.');
      setDeactivateTarget(null);
    } finally {
      setDeactivateSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    setDeleteSubmitting(true);
    try {
      await apiClient.delete(`/employees/${deleteTarget.id}`);
      setSuccessMessage(`${deleteTarget.name} was deleted.`);
      setDeleteTarget(null);
      fetchEmployees();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete employee.');
      setDeleteTarget(null);
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const activateDirectly = async (emp) => {
    try {
      await apiClient.put(`/employees/${emp.id}`, { is_active: true });
      setSuccessMessage(`${emp.name} was activated.`);
      fetchEmployees();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to activate employee.');
    }
  };

  const columns = [
    {
      key: 'name', label: 'Employee', sortable: true,
      render: (emp) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={styles.avatar}>{initials(emp.name)}</div>
          <div>
            <div style={{ fontWeight: 600, color: colors.text }}>{emp.name}</div>
            <div style={{ fontSize: 12, color: colors.textMuted }}>@{emp.username}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role', label: 'Role', sortable: true,
      render: (emp) => <StatusBadge label={emp.role === 'manager' ? 'Manager' : 'Rep'} tone={emp.role === 'manager' ? 'primary' : 'neutral'} />,
    },
    {
      key: 'region', label: 'Region', sortable: true,
      render: (emp) => emp.region ? <StatusBadge label={emp.region} tone="neutral" /> : '—',
    },
    {
      key: 'is_active', label: 'Status', sortable: true,
      render: (emp) => <StatusBadge label={emp.is_active ? 'Active' : 'Inactive'} tone={emp.is_active ? 'success' : 'danger'} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (emp) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="ft-icon-btn" style={styles.actionBtn} title="Edit" aria-label={`Edit ${emp.name}`} onClick={() => openEdit(emp)}>
            <Pencil size={14} />
          </button>
          <button className="ft-icon-btn" style={styles.actionBtn} title="Reset password" aria-label={`Reset password for ${emp.name}`} onClick={() => { setResetError(''); setResetTarget(emp); }}>
            <KeyRound size={14} />
          </button>
          <button
            className="ft-icon-btn"
            style={styles.actionBtn}
            // Deactivating your own account would lock you out immediately
            // (is_active is re-checked every request, per auth.middleware.js)
            // with no way to undo it yourself — only Delete had this guard
            // before, Deactivate needs it just as much.
            title={emp.id === currentEmployeeId ? "You can't deactivate your own account" : (emp.is_active ? 'Deactivate' : 'Activate')}
            aria-label={`${emp.is_active ? 'Deactivate' : 'Activate'} ${emp.name}`}
            disabled={emp.id === currentEmployeeId && emp.is_active}
            onClick={() => (emp.is_active ? setDeactivateTarget(emp) : activateDirectly(emp))}
          >
            <Power size={14} color={emp.is_active ? colors.danger : colors.success} />
          </button>
          {emp.id !== currentEmployeeId && (
            <button
              className="ft-icon-btn"
              style={styles.actionBtn}
              title="Delete"
              aria-label={`Delete ${emp.name}`}
              onClick={() => setDeleteTarget(emp)}
            >
              <Trash2 size={14} color={colors.danger} />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionHeader
        title="Employees"
        subtitle="Manage field reps and managers"
        action={<Button icon={<UserPlus size={15} />} onClick={() => { setCreateError(''); setCreateOpen(true); }} fullWidthMobile>Add employee</Button>}
      />

      <div style={styles.metricsGrid} className="ft-stagger">
        <MetricCard icon={<Users />} value={summary.total} label="Total employees" tone="primary" />
        <MetricCard icon={<UserCheck />} value={summary.active} label="Active" tone="success" />
        <MetricCard icon={<UserX />} value={summary.inactive} label="Inactive" tone="danger" />
        <MetricCard icon={<Shield />} value={summary.managers} label="Managers" tone="primary" />
        <MetricCard icon={<Briefcase />} value={summary.reps} label="Representatives" tone="neutral" />
      </div>

      {error && <div style={styles.errorBanner} role="alert">{error}</div>}
      {successMessage && <div style={styles.successBanner} role="status">{successMessage}</div>}

      <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search by name, username, or region" style={{ marginBottom: spacing.lg, maxWidth: 360 }} />

      <div className="ft-card" style={{ overflow: 'hidden' }}>
        {!loading && employees.length === 0 && !error ? (
          <EmptyState title="No employees yet" subtitle="Employees you add will appear here." />
        ) : (
          <DataTable
            // Forces a remount (resetting internal page state) whenever the
            // search query changes — otherwise a manager on page 2 of the
            // full list who then searches for something with fewer matches
            // stays on "page 2" showing unrelated (or no) rows.
            key={searchQuery}
            columns={columns}
            rows={filteredEmployees}
            loading={loading}
            emptyTitle="No employees match your search"
          />
        )}
      </div>

      <Modal open={createOpen} title="Add employee" subtitle="Create a new rep or manager account" onClose={() => setCreateOpen(false)}>
        <form onSubmit={handleCreate}>
          <div style={styles.formGrid}>
            <TextField label="Full name" value={createForm.name} onChange={(v) => setCreateForm({ ...createForm, name: v })} required />
            <TextField label="Phone" value={createForm.phone} onChange={(v) => setCreateForm({ ...createForm, phone: v })} />
            <TextField label="Username" value={createForm.username} onChange={(v) => setCreateForm({ ...createForm, username: v })} required />
            <TextField label="Password (min 6 chars)" type="password" value={createForm.password} onChange={(v) => setCreateForm({ ...createForm, password: v })} required minLength={6} />
            <TextField label="Region" value={createForm.region} onChange={(v) => setCreateForm({ ...createForm, region: v })} />
            <div style={{ position: 'relative' }}>
              <label style={styles.selectLabel}>Role</label>
              <select className="ft-input" style={{ height: 46 }} value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
                {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          {createError && <p style={styles.formError}>{createError}</p>}
          <div style={styles.formActions}>
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" loading={createSubmitting}>Create employee</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!editTarget} title="Edit employee" subtitle={editTarget?.name} onClose={() => setEditTarget(null)}>
        <form onSubmit={handleEdit}>
          <div style={styles.formGrid}>
            <TextField label="Full name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} required />
            <TextField label="Phone" value={editForm.phone} onChange={(v) => setEditForm({ ...editForm, phone: v })} />
            <TextField label="Region" value={editForm.region} onChange={(v) => setEditForm({ ...editForm, region: v })} />
            <div style={{ position: 'relative' }}>
              <label style={styles.selectLabel}>Role</label>
              <select className="ft-input" style={{ height: 46 }} value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          {editError && <p style={styles.formError}>{editError}</p>}
          <div style={styles.formActions}>
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button type="submit" loading={editSubmitting}>Save changes</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!resetTarget} title="Reset password" subtitle={resetTarget?.name} onClose={() => setResetTarget(null)}>
        <form onSubmit={handleResetPassword}>
          <TextField label="New password (min 6 chars)" type="password" value={resetPassword} onChange={setResetPassword} required minLength={6} style={{ marginBottom: spacing.lg }} />
          {resetError && <p style={styles.formError}>{resetError}</p>}
          <div style={styles.formActions}>
            <Button type="button" variant="secondary" onClick={() => setResetTarget(null)}>Cancel</Button>
            <Button type="submit" loading={resetSubmitting}>Set password</Button>
          </div>
        </form>
      </Modal>

      <ConfirmationModal
        open={!!deactivateTarget}
        title="Deactivate employee?"
        message={`${deactivateTarget?.name} will no longer be able to sign in until reactivated.`}
        confirmLabel="Deactivate"
        danger
        loading={deactivateSubmitting}
        onConfirm={confirmDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />

      <ConfirmationModal
        open={!!deleteTarget}
        title="Delete employee?"
        message={`This permanently deletes ${deleteTarget?.name}'s account, including all of their attendance and visit history. This cannot be undone — deactivate instead if you just need to revoke access.`}
        confirmLabel="Delete"
        danger
        loading={deleteSubmitting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const styles = {
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: spacing.lg, marginBottom: spacing.xl },
  errorBanner: { backgroundColor: colors.dangerLight, color: colors.dangerDark, border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14 },
  successBanner: { backgroundColor: colors.successLight, color: colors.successDark, border: '1px solid #A7F3D0', borderRadius: 10, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.avatarBg, color: colors.avatarText, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  actionBtn: { width: 32, height: 32 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: spacing.md, marginBottom: spacing.lg },
  // Matches TextField's floated-label position exactly (overlapping the
  // border, not sitting above it) so the select's box lines up with text
  // inputs in the same form-grid row instead of sitting lower.
  selectLabel: {
    position: 'absolute', left: 14, top: -8, fontSize: 11, fontWeight: 600,
    color: colors.textSecondary, backgroundColor: colors.card, padding: '0 4px',
    pointerEvents: 'none', zIndex: 1,
  },
  formError: { fontSize: 13, color: colors.danger, marginBottom: spacing.md },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 10 },
};
