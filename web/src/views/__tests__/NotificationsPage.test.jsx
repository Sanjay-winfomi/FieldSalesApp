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

  test('approving calls the backend and swaps the buttons for an Approved badge', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockResolvedValue({ data: { request: { id: 10, status: 'approved' } } });
    render(<NotificationsPage />);

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/followup-requests/10/approve'));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
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

  test('shows a per-row error and keeps the buttons if approving fails', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    apiClient.patch.mockRejectedValue({ response: { data: { error: 'request_already_resolved' } } });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    expect(await screen.findByText('request_already_resolved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
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
