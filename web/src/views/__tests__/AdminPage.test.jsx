import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../api';
import AdminPage from '../AdminPage';

vi.mock('../../api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ data: { employees: [], dealers: [] } });
  });

  test('shows the Visit Plan tab for a regular manager', async () => {
    render(<AdminPage currentEmployeeId={1} currentUsername="priya" />);
    expect(await screen.findByRole('button', { name: /visit plan/i })).toBeInTheDocument();
  });

  test('hides the Visit Plan tab for the demo manager account, without removing the route', async () => {
    render(<AdminPage currentEmployeeId={2} currentUsername="demo.manager" />);
    await screen.findByRole('button', { name: /employees/i });
    expect(screen.queryByRole('button', { name: /visit plan/i })).not.toBeInTheDocument();
    // Employees/Dealers tabs are still there — only Visit Plan is filtered.
    expect(screen.getByRole('button', { name: /dealers/i })).toBeInTheDocument();
  });
});
