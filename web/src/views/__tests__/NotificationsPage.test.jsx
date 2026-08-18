import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../api';
import NotificationsPage from '../NotificationsPage';

vi.mock('../../api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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

  test('an office_day notification renders as plain text, with no Reviewed/Clear/approve buttons at all', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 5, type: 'office_day', title: 'Office day',
          body: 'arun marked today as an office day — not visiting dealers.',
          read_at: null, created_at: '2026-08-19T05:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('Office day')).toBeInTheDocument();
    expect(screen.getByText('arun marked today as an office day — not visiting dealers.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reviewed/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear notification' })).not.toBeInTheDocument();
  });

  test('an unreviewed day_auto_cutoff notification shows a Reviewed button', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day — automatically closed at 1:00 AM after 10.0h.',
          read_at: null, created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: /reviewed/i })).toBeInTheDocument();
  });

  test('clicking Reviewed marks the notification read and swaps the button for a badge', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'visit_auto_cutoff', title: 'Dealer visit auto-closed (missed logout)',
          body: 'arun did not log out of Dealer A — automatically closed at 1:00 AM after 8.0h.',
          read_at: null, created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    apiClient.patch.mockResolvedValue({ data: { notification: { id: 3, read_at: '2026-08-18T09:00:00Z' } } });
    render(<NotificationsPage />);

    const reviewedBtn = await screen.findByRole('button', { name: /reviewed/i });
    fireEvent.click(reviewedBtn);

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith('/notifications/3/read'));
    expect(await screen.findByText('Reviewed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reviewed/i })).not.toBeInTheDocument();
  });

  test('an already-reviewed auto-cutoff notification shows the badge directly, no button', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day.',
          read_at: '2026-08-18T09:00:00Z', created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('Reviewed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reviewed/i })).not.toBeInTheDocument();
  });

  test('an unreviewed day_absent notification also shows a Reviewed button', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 4, type: 'day_absent', title: 'Representative did not log in',
          body: 'divya did not log in on 18 Aug 2026 — likely absent, follow up if unplanned.',
          read_at: null, created_at: '2026-08-19T02:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('Representative did not log in')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /reviewed/i })).toBeInTheDocument();
  });

  test('an unreviewed auto-cutoff notification has no Clear button', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day.',
          read_at: null, created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    await screen.findByRole('button', { name: /reviewed/i });
    expect(screen.queryByRole('button', { name: 'Clear notification' })).not.toBeInTheDocument();
  });

  test('a reviewed auto-cutoff notification shows a Clear button', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day.',
          read_at: '2026-08-18T09:00:00Z', created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: 'Clear notification' })).toBeInTheDocument();
  });

  test('a pending follow-up request has no Clear button', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } });
    render(<NotificationsPage />);

    await screen.findByRole('button', { name: /approve/i });
    expect(screen.queryByRole('button', { name: 'Clear notification' })).not.toBeInTheDocument();
  });

  test('an approved follow-up request shows a Clear button', async () => {
    apiClient.get.mockResolvedValue({
      data: { notifications: [{ ...FOLLOWUP_NOTIFICATION, followup_status: 'approved' }] },
    });
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: 'Clear notification' })).toBeInTheDocument();
  });

  test('clicking Clear opens a confirmation dialog; confirming deletes the notification', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day.',
          read_at: '2026-08-18T09:00:00Z', created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    apiClient.delete.mockResolvedValue({});
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear notification' }));
    expect(await screen.findByText('Clear this notification?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/notifications/3'));
    await waitFor(() => expect(screen.queryByText('Day auto-logged-out (missed logout)')).not.toBeInTheDocument());
  });

  test('cancelling the confirmation dialog does not delete anything', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [{
          id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
          body: 'arun did not log out for the day.',
          read_at: '2026-08-18T09:00:00Z', created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
        }],
      },
    });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear notification' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(screen.getByText('Day auto-logged-out (missed logout)')).toBeInTheDocument();
  });

  test('no "Clear all resolved" button when nothing is currently eligible', async () => {
    apiClient.get.mockResolvedValue({ data: { notifications: [FOLLOWUP_NOTIFICATION] } }); // pending — not deletable
    render(<NotificationsPage />);

    await screen.findByText('Follow-up visit requested');
    expect(screen.queryByRole('button', { name: /clear all resolved/i })).not.toBeInTheDocument();
  });

  test('"Clear all resolved" shows a count and only counts eligible notifications', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [
          FOLLOWUP_NOTIFICATION, // pending — not deletable
          {
            id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
            body: 'arun did not log out.', read_at: '2026-08-18T09:00:00Z',
            created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
          },
          {
            id: 4, type: 'day_absent', title: 'Representative did not log in',
            body: 'divya did not log in.', read_at: '2026-08-19T09:00:00Z',
            created_at: '2026-08-19T02:00:00Z', followup_request_id: null,
          },
        ],
      },
    });
    render(<NotificationsPage />);

    expect(await screen.findByRole('button', { name: 'Clear all resolved (2)' })).toBeInTheDocument();
  });

  test('clicking "Clear all resolved" and confirming deletes every eligible notification, leaving the rest', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        notifications: [
          FOLLOWUP_NOTIFICATION, // pending — must survive
          {
            id: 3, type: 'day_auto_cutoff', title: 'Day auto-logged-out (missed logout)',
            body: 'arun did not log out.', read_at: '2026-08-18T09:00:00Z',
            created_at: '2026-08-18T01:00:00Z', followup_request_id: null,
          },
        ],
      },
    });
    apiClient.delete.mockResolvedValue({ data: { success: true, deleted: 1 } });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all resolved (1)' }));
    expect(await screen.findByText('Clear all resolved notifications?')).toBeInTheDocument();
    expect(screen.getByText(/permanently removes 1 reviewed\/resolved notification\. /)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/notifications'));
    await waitFor(() => expect(screen.queryByText('Day auto-logged-out (missed logout)')).not.toBeInTheDocument());
    expect(screen.getByText('Follow-up visit requested')).toBeInTheDocument();
  });
});
