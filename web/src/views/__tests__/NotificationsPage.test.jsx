import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../api';
import NotificationsPage from '../NotificationsPage';

vi.mock('../../api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const FOLLOWUP_NOTIFICATION = {
  id: 1,
  type: 'followup_request',
  title: 'Follow-up visit requested',
  body: 'Arun asked to (re-)visit Dealer A on 2099-01-01.',
  severity: 'info',
  employee_name: 'Arun',
  dealer_name: 'Dealer A',
  read_at: null,
  created_at: '2026-08-10T05:00:00Z',
  followup_request_id: 10,
  followup_status: 'pending',
  followup_requested_date: '2099-01-01',
  followup_approved_date: null,
};

describe('NotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.post.mockResolvedValue({});
  });

  test('shows Approve/Reject buttons for a pending follow-up request', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  test('approving defaults to the rep\'s requested date and swaps the buttons for an Approved badge', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockResolvedValue({ data: { request: { id: 10, status: 'approved', approved_date: '2099-01-01' } } });
    render(<NotificationsPage />);

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
      '/followup-requests/10/approve',
      { approved_date: '2099-01-01' }
    ));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('for 2099-01-01')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  test('a manager can edit the date before approving, and that date is sent instead', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockResolvedValue({ data: { request: { id: 10, status: 'approved', approved_date: '2099-02-15' } } });
    render(<NotificationsPage />);

    const dateInput = await screen.findByLabelText('Approval date');
    fireEvent.change(dateInput, { target: { value: '2099-02-15' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
      '/followup-requests/10/approve',
      { approved_date: '2099-02-15' }
    ));
    expect(await screen.findByText('for 2099-02-15')).toBeInTheDocument();
  });

  test('clearing the date disables Approve instead of silently falling back to the requested date with no guard', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    render(<NotificationsPage />);

    const dateInput = await screen.findByLabelText('Approval date');
    fireEvent.change(dateInput, { target: { value: '' } });

    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  test('clicking Approve does not show Reject as loading too, and vice versa', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    // Never resolves — keeps the button in its loading state so it can be inspected.
    apiClient.patch.mockReturnValue(new Promise(() => {}));
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /reject/i })).not.toBeDisabled();
  });

  test('rejecting calls the backend and swaps the buttons for a Rejected badge', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockResolvedValue({ data: { request: { id: 10, status: 'rejected' } } });
    render(<NotificationsPage />);

    const rejectBtn = await screen.findByRole('button', { name: /reject/i });
    fireEvent.click(rejectBtn);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/followup-requests/10/reject'));
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
  });

  test('shows a friendly per-row error and keeps the buttons if approving fails', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockRejectedValue({ response: { data: { error: 'request_already_resolved' } } });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    expect(await screen.findByText(/already resolved/i)).toBeInTheDocument();
    expect(screen.queryByText('request_already_resolved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  test('shows a friendly error when the approved date has already passed', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockRejectedValue({ response: { data: { error: 'approved_date_in_past' } } });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    expect(await screen.findByText(/already passed/i)).toBeInTheDocument();
    expect(screen.queryByText('approved_date_in_past')).not.toBeInTheDocument();
  });

  test('the approval date input cannot be set earlier than today', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    render(<NotificationsPage />);

    const dateInput = await screen.findByLabelText('Approval date');
    const today = new Date();
    const expectedMin = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(dateInput).toHaveAttribute('min', expectedMin);
  });

  test('an already-resolved follow-up notification shows a status badge, not buttons', async () => {
    apiClient.get.mockResolvedValue({
      data: { notifications: [{ ...FOLLOWUP_NOTIFICATION, followup_status: 'approved' }] },
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  test('a plain (non-followup) notification renders with no action buttons', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 2, type: 'left_dealer', title: 'Left dealer premises', body: 'Arun left Dealer A.',
          read_at: null, created_at: '2026-08-10T05:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('Left dealer premises')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
