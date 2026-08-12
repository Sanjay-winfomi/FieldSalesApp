import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../../api';
import EmployeesTab from '../EmployeesTab';

vi.mock('../../../api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const EMPLOYEES = [
  { id: 1, name: 'Priya Manager', username: 'priya', role: 'manager', is_active: true, region: 'South' },
  { id: 2, name: 'Arun Rep', username: 'arun', role: 'rep', is_active: true, region: 'South' },
];

describe('EmployeesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ data: { employees: EMPLOYEES } });
  });

  test('the signed-in manager cannot deactivate their own account', async () => {
    render(<EmployeesTab currentEmployeeId={1} />);
    await screen.findByText('Priya Manager');

    const ownDeactivateBtn = screen.getByLabelText('Deactivate Priya Manager');
    expect(ownDeactivateBtn).toBeDisabled();

    fireEvent.click(ownDeactivateBtn);
    expect(screen.queryByText('Deactivate employee?')).not.toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  test('the signed-in manager cannot delete their own account either', async () => {
    render(<EmployeesTab currentEmployeeId={1} />);
    await screen.findByText('Priya Manager');

    expect(screen.queryByLabelText('Delete Priya Manager')).not.toBeInTheDocument();
  });

  test('a manager can deactivate a different employee', async () => {
    apiClient.put.mockResolvedValue({});
    render(<EmployeesTab currentEmployeeId={1} />);
    await screen.findByText('Arun Rep');

    fireEvent.click(screen.getByLabelText('Deactivate Arun Rep'));
    fireEvent.click(await screen.findByRole('button', { name: /^deactivate$/i }));

    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith('/employees/2', { is_active: false }));
  });
});
