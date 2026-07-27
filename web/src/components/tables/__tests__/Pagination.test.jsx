import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import Pagination from '../Pagination';

describe('Pagination', () => {
  test('renders nothing when there is only one page', () => {
    const { container } = render(<Pagination page={1} pageCount={1} totalItems={5} pageSize={10} onPageChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test('shows the correct item range', () => {
    render(<Pagination page={2} pageCount={3} totalItems={25} pageSize={10} onPageChange={() => {}} />);
    expect(screen.getByText('11–20')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  test('disables Previous on the first page and Next on the last page', () => {
    render(<Pagination page={1} pageCount={3} totalItems={25} pageSize={10} onPageChange={() => {}} />);
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
    expect(screen.getByLabelText('Next page')).not.toBeDisabled();
  });

  test('calls onPageChange with the next page number', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageCount={3} totalItems={25} pageSize={10} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
