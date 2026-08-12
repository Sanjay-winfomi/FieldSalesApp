import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import ConfirmationModal from '../ConfirmationModal';

describe('ConfirmationModal', () => {
  test('backdrop click calls onCancel when not loading', () => {
    const onCancel = vi.fn();
    render(<ConfirmationModal open title="Delete dealer?" onCancel={onCancel} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole('presentation'));
    expect(onCancel).toHaveBeenCalled();
  });

  test('backdrop click does nothing while the confirmed action is loading', () => {
    const onCancel = vi.fn();
    render(<ConfirmationModal open loading title="Delete dealer?" onCancel={onCancel} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole('presentation'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Escape does nothing while loading', () => {
    const onCancel = vi.fn();
    render(<ConfirmationModal open loading title="Delete dealer?" onCancel={onCancel} onConfirm={() => {}} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('Escape calls onCancel when not loading', () => {
    const onCancel = vi.fn();
    render(<ConfirmationModal open title="Delete dealer?" onCancel={onCancel} onConfirm={() => {}} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  test('Cancel button is disabled while loading', () => {
    render(<ConfirmationModal open loading title="Delete dealer?" onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });
});
