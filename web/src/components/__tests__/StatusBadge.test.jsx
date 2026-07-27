import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import StatusBadge from '../StatusBadge';

describe('StatusBadge', () => {
  test('renders the label text', () => {
    render(<StatusBadge label="Checked in" tone="success" />);
    expect(screen.getByText('Checked in')).toBeInTheDocument();
  });

  test('falls back to the neutral tone for an unknown tone', () => {
    render(<StatusBadge label="Unknown" tone="not-a-real-tone" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
