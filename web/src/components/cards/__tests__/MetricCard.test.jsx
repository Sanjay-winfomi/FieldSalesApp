import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import { TrendingUp } from 'lucide-react';
import MetricCard from '../MetricCard';

describe('MetricCard', () => {
  test('renders value, label, and subtitle', () => {
    render(<MetricCard icon={<TrendingUp />} value="42" label="Visits today" subtitle="+3 vs yesterday" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Visits today')).toBeInTheDocument();
    expect(screen.getByText('+3 vs yesterday')).toBeInTheDocument();
  });

  test('shows an upward trend indicator for a positive trend', () => {
    render(<MetricCard icon={<TrendingUp />} value="10" label="Dealers" trend={5} />);
    expect(screen.getByText('5%')).toBeInTheDocument();
  });

  test('shows the absolute value for a negative trend', () => {
    render(<MetricCard icon={<TrendingUp />} value="10" label="Dealers" trend={-8} />);
    expect(screen.getByText('8%')).toBeInTheDocument();
  });

  test('omits the trend indicator when trend is not provided', () => {
    render(<MetricCard icon={<TrendingUp />} value="10" label="Dealers" />);
    expect(screen.queryByText('%', { exact: false })).not.toBeInTheDocument();
  });
});
