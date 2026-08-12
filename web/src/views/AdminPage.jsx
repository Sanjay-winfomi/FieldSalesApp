import React, { useState } from 'react';
import { Users, Store, Route } from 'lucide-react';
import EmployeesTab from './admin/EmployeesTab';
import DealersTab from './admin/DealersTab';
import AssignmentsTab from './admin/AssignmentsTab';
import { colors, spacing } from '../theme';

const TABS = [
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'dealers', label: 'Dealers', icon: Store },
  { key: 'assignments', label: 'Visit Plan', icon: Route },
];

// Hides the Visit Plan tab for the demo account used in live demos — the
// Dealer Assignment feature itself is untouched (AssignmentsTab, its route,
// and every other manager's access all work exactly as before); only this
// one account's tab list is filtered.
const HIDE_VISIT_PLAN_FOR_USERNAMES = ['demo.manager'];

export default function AdminPage({ currentEmployeeId, currentUsername }) {
  const [activeTab, setActiveTab] = useState('employees');
  const visibleTabs = HIDE_VISIT_PLAN_FOR_USERNAMES.includes(currentUsername)
    ? TABS.filter((t) => t.key !== 'assignments')
    : TABS;

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.tabRow} className="ft-admin-tabs">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              className={`ft-btn ${active ? 'ft-btn-primary' : 'ft-btn-secondary'}`}
              style={{ height: 38, padding: '0 18px' }}
              onClick={() => setActiveTab(t.key)}
              aria-pressed={active}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'employees' && <EmployeesTab currentEmployeeId={currentEmployeeId} />}
      {activeTab === 'dealers' && <DealersTab />}
      {activeTab === 'assignments' && visibleTabs.some((t) => t.key === 'assignments') && <AssignmentsTab />}
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  tabRow: { display: 'flex', gap: spacing.sm, marginBottom: spacing.xl, flexWrap: 'wrap' },
};
