import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../api';
import ReportsPage from '../ReportsPage';

vi.mock('../../api', () => ({
  apiClient: { get: vi.fn(), patch: vi.fn() },
}));

const ABSENCE_ROWS = [
  { id: 9, employee_name: 'Divya', region: 'South', absence_date: '2026-08-18', reviewed: false },
  { id: 7, employee_name: 'Arun', region: 'South', absence_date: '2026-08-17', reviewed: true },
];

function mockGetFor(rows) {
  apiClient.get.mockImplementation((path) => {
    if (path === '/employees?role=rep') return Promise.resolve({ data: { employees: [] } });
    if (path === '/dealers/not-visited') return Promise.resolve({ data: { dealers: [] } });
    if (path.startsWith('/reports/')) return Promise.resolve({ data: { rows, truncated: false } });
    return Promise.resolve({ data: {} });
  });
}

describe('ReportsPage — Absences tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('switching to the Absences tab fetches /reports/absences', async () => {
    mockGetFor(ABSENCE_ROWS);
    render(<ReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Absences' }));

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(
      '/reports/absences',
      expect.objectContaining({ params: expect.any(Object) })
    ));
    expect(await screen.findByText('Divya')).toBeInTheDocument();
    expect(await screen.findByText('Arun')).toBeInTheDocument();
  });

  test('an unreviewed absence shows a Mark reviewed button; an already-reviewed one does not', async () => {
    mockGetFor(ABSENCE_ROWS);
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Absences' }));
    await screen.findByText('Divya');

    // Exactly one row (Divya's) is unreviewed — exactly one button.
    expect(screen.getAllByRole('button', { name: 'Mark reviewed' })).toHaveLength(1);
  });

  test('clicking Mark reviewed calls the notifications endpoint and removes the button for that row', async () => {
    mockGetFor(ABSENCE_ROWS);
    apiClient.patch.mockResolvedValue({});
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Absences' }));
    await screen.findByText('Divya');

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/notifications/9/read'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument());
  });
});
