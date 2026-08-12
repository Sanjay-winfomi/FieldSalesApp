import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient } from '../../../api';
import AssignmentsTab from '../AssignmentsTab';

vi.mock('../../../api', () => ({
  apiClient: { get: vi.fn(), put: vi.fn() },
}));

const REPS = [{ id: 1, name: 'Arun' }, { id: 2, name: 'Divya' }];
const DEALERS = [
  { id: 10, name: 'Dealer A', address: 'Addr A' },
  { id: 11, name: 'Dealer B', address: 'Addr B' },
];

function mockInitialLoad(assignments = []) {
  apiClient.get.mockImplementation((url) => {
    if (url === '/employees?role=rep') return Promise.resolve({ data: { employees: REPS } });
    if (url === '/dealers') return Promise.resolve({ data: { dealers: DEALERS } });
    if (url === '/assignments') return Promise.resolve({ data: { assignments } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('AssignmentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('prompts to select a rep before showing the editor', async () => {
    mockInitialLoad();
    render(<AssignmentsTab />);
    expect(await screen.findByText(/Choose a rep and date above/)).toBeInTheDocument();
  });

  test('loads an existing assignment for the selected rep in saved order', async () => {
    mockInitialLoad([
      { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' },
      { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', status: 'completed' },
    ]);
    render(<AssignmentsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));

    await waitFor(() => expect(screen.getByText('Assigned order (2)')).toBeInTheDocument());
    expect(screen.getByText('Dealer A')).toBeInTheDocument();
    expect(screen.getByText('Dealer B')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  test('adding a dealer appends it to the end of the order without disturbing existing sequence', async () => {
    mockInitialLoad([{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' }]);
    render(<AssignmentsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (1)');

    fireEvent.click(screen.getByLabelText('Add Dealer B'));

    expect(screen.getByText('Assigned order (2)')).toBeInTheDocument();
    // Order badges: Dealer A stays 1st, newly added Dealer B is appended 2nd.
    const rowA = screen.getByTestId('assignment-row-10');
    const rowB = screen.getByTestId('assignment-row-11');
    expect(rowA.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('moving a dealer up/down reorders the plan locally and Save persists the new order', async () => {
    mockInitialLoad([
      { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' },
      { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', status: 'pending' },
    ]);
    apiClient.put.mockResolvedValue({
      data: {
        assignments: [
          { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', status: 'pending' },
          { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' },
        ],
      },
    });

    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (2)');

    // Move Dealer B (2nd row) up, so it becomes 1st.
    fireEvent.click(screen.getByLabelText('Move Dealer B up'));

    const saveBtn = screen.getByRole('button', { name: /save changes/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith('/assignments', {
      employee_id: 1,
      assignment_date: expect.any(String),
      dealer_ids: [11, 10],
    }));
  });

  test('a slow response for a previously-selected rep does not clobber the view after switching to another rep', async () => {
    // Arun's request resolves slowly; Divya's (selected right after) resolves
    // fast. If the component doesn't guard against stale responses, Arun's
    // list would land last and incorrectly overwrite Divya's view.
    let resolveArun;
    apiClient.get.mockImplementation((url, config) => {
      if (url === '/employees?role=rep') return Promise.resolve({ data: { employees: REPS } });
      if (url === '/dealers') return Promise.resolve({ data: { dealers: DEALERS } });
      if (url === '/assignments') {
        if (config.params.employee_id === 1) {
          return new Promise((resolve) => { resolveArun = resolve; });
        }
        return Promise.resolve({
          data: { assignments: [{ id: 5, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', status: 'pending' }] },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<AssignmentsTab />);

    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));

    fireEvent.click(screen.getByRole('button', { name: /Arun/i }));
    fireEvent.click(await screen.findByText('Divya'));

    await waitFor(() => expect(screen.getByText('Assigned order (1)')).toBeInTheDocument());
    expect(screen.getByText('Dealer B')).toBeInTheDocument();

    // Now let Arun's slow request resolve — it must be ignored since the
    // rep selection has since moved on to Divya.
    resolveArun({ data: { assignments: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' }] } });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText('Assigned order (1)')).toBeInTheDocument();
    expect(screen.getByTestId('assignment-row-11')).toBeInTheDocument();
    expect(screen.queryByTestId('assignment-row-10')).not.toBeInTheDocument();
  });

  test('Save stays disabled while a newly-selected rep\'s plan is still loading, even with unsaved edits pending', async () => {
    // Arun has unsaved edits (Dealer B just added, never saved). Switching to
    // Divya kicks off a slow load for her plan. If Save weren't disabled
    // during that window, clicking it would PUT Arun's edited list against
    // Divya's employee_id, since her rows haven't arrived yet.
    let resolveDivya;
    apiClient.get.mockImplementation((url, config) => {
      if (url === '/employees?role=rep') return Promise.resolve({ data: { employees: REPS } });
      if (url === '/dealers') return Promise.resolve({ data: { dealers: DEALERS } });
      if (url === '/assignments') {
        if (config.params.employee_id === 1) {
          return Promise.resolve({
            data: { assignments: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' }] },
          });
        }
        return new Promise((resolve) => { resolveDivya = resolve; });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (1)');

    fireEvent.click(screen.getByLabelText('Add Dealer B'));
    expect(await screen.findByRole('button', { name: /save changes/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Arun/i }));
    fireEvent.click(await screen.findByText('Divya'));
    // Switching reps while dirty prompts to discard the unsaved edit first.
    fireEvent.click(await screen.findByRole('button', { name: /discard changes/i }));

    // Divya's load hasn't resolved yet — Save must be disabled ("Saved" or
    // "Save changes", either way not clickable) so Arun's dirtied list can't
    // land on Divya's employee_id.
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();

    resolveDivya({ data: { assignments: [] } });
    await waitFor(() => expect(screen.getByText('Assigned order (0)')).toBeInTheDocument());
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  test('removing a dealer from the plan requires confirmation', async () => {
    mockInitialLoad([
      { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' },
    ]);
    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (1)');

    fireEvent.click(screen.getByLabelText('Remove Dealer A'));
    // Not removed yet — still showing 1, and the confirm dialog is up.
    expect(screen.getByText('Assigned order (1)')).toBeInTheDocument();
    expect(screen.getByText(/will be removed from this rep's visit plan/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.getByText('Assigned order (0)')).toBeInTheDocument();
  });

  test('cancelling the discard-changes prompt keeps the current rep selected with edits intact', async () => {
    let resolveDivya;
    apiClient.get.mockImplementation((url, config) => {
      if (url === '/employees?role=rep') return Promise.resolve({ data: { employees: REPS } });
      if (url === '/dealers') return Promise.resolve({ data: { dealers: DEALERS } });
      if (url === '/assignments') {
        if (config.params.employee_id === 1) {
          return Promise.resolve({
            data: { assignments: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' }] },
          });
        }
        return new Promise((resolve) => { resolveDivya = resolve; });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (1)');

    fireEvent.click(screen.getByLabelText('Add Dealer B'));
    expect(screen.getByText('Assigned order (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Arun/i }));
    fireEvent.click(await screen.findByText('Divya'));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    // Still on Arun, with the unsaved add still in place.
    expect(screen.getByText('Assigned order (2)')).toBeInTheDocument();
    expect(resolveDivya).toBeUndefined();
  });

  test('shows the straight-line distance between consecutive dealers once both have coordinates', async () => {
    mockInitialLoad([
      { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', dealer_lat: 11.0098, dealer_lng: 76.9558, status: 'pending' },
      { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', dealer_lat: 11.0234, dealer_lng: 77.0012, status: 'pending' },
    ]);
    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));

    expect(await screen.findByText(/km from previous stop/)).toBeInTheDocument();
    expect(screen.getByText(/km total/)).toBeInTheDocument();
  });

  test('does not show a distance for the first dealer, or when coordinates are missing', async () => {
    mockInitialLoad([
      { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', dealer_lat: null, dealer_lng: null, status: 'pending' },
      { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', dealer_lat: 11.0234, dealer_lng: 77.0012, status: 'pending' },
    ]);
    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Dealer B');

    // Dealer A has no coordinates, so Dealer B (right after it) can't get a
    // distance either — neither row nor the panel title show one.
    expect(screen.queryByText(/km from previous stop/)).not.toBeInTheDocument();
    expect(screen.queryByText(/km total/)).not.toBeInTheDocument();
  });

  test('shows an error banner when saving fails', async () => {
    mockInitialLoad([{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending' }]);
    apiClient.put.mockRejectedValue({ response: { data: { error: 'boom' } } });

    render(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /select a representative/i }));
    fireEvent.click(await screen.findByText('Arun'));
    await screen.findByText('Assigned order (1)');

    fireEvent.click(screen.getByLabelText('Add Dealer B'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
