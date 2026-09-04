'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Store, ChevronLeft, PlayCircle, FileText, Sparkles, Mic, RotateCcw } from 'lucide-react';
import { apiClient } from '../api';
import { getAudioLink } from '../utils/meetingApi';
import {
  SectionHeader, Card, FilterBar, SearchBar, DataTable, EmptyState, Button,
  RepMultiSelect, DealerMultiSelect,
} from '../components';
import { colors, typography, spacing } from '../theme';
import { toDateInputValue } from '../utils/reports.jsx';

const SUB_TABS = [
  { key: 'representatives', label: 'Representatives', icon: Users },
  { key: 'dealers', label: 'Dealers', icon: Store },
];

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toDateInputValue(d);
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** One recording — date/time, status, on-demand audio player, transcript,
 * summary. `subjectLabel`/`subjectName` render "at <dealer>" under a rep's
 * recording, or "by <rep>" under a dealer's — whichever the caller doesn't
 * already know from context. */
function RecordingCard({ recording, subjectLabel, subjectName }) {
  const [audioUrl, setAudioUrl] = useState(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState('');

  const handlePlay = async () => {
    if (audioUrl || loadingAudio) return;
    setLoadingAudio(true);
    setAudioError('');
    try {
      const url = await getAudioLink(recording.audio_file_id);
      setAudioUrl(url);
    } catch (err) {
      // Surfaces the real cause (e.g. a network error reaching
      // NEXT_PUBLIC_MEETING_BACKEND_URL if it's unset/misconfigured, vs. an
      // actual server error) instead of a single generic message that gives
      // no signal for diagnosing a real failure.
      const detail = err.response
        ? `Server responded ${err.response.status}: ${JSON.stringify(err.response.data)?.slice(0, 200)}`
        : err.message || String(err);
      console.error('Failed to load audio link:', err);
      setAudioError(`Could not load audio — ${detail}`);
    } finally {
      setLoadingAudio(false);
    }
  };

  return (
    <Card style={styles.recCard}>
      <div style={styles.recHeader}>
        <div>
          <div style={styles.recTitle}>{recording.recording_name || 'Untitled Recording'}</div>
          <div style={styles.recMeta}>
            {formatDateTime(recording.created_at)}
            {recording.duration ? ` · ${recording.duration}` : ''}
            {subjectName ? ` · ${subjectLabel} ${subjectName}` : ''}
          </div>
        </div>
        {recording.processing_status !== 'success' && (
          <span style={{
            ...styles.statusPill,
            backgroundColor: recording.processing_status === 'failed' ? colors.dangerLight : colors.warningLight,
            color: recording.processing_status === 'failed' ? colors.dangerDark : colors.warningDark,
          }}
          >
            {recording.processing_status === 'failed' ? 'Failed' : 'Processing'}
          </span>
        )}
      </div>

      {!!recording.audio_file_id && (
        <div style={{ marginTop: spacing.md }}>
          {audioUrl ? (
            <audio controls src={audioUrl} style={{ width: '100%', height: 36 }} />
          ) : (
            <Button
              variant="secondary"
              icon={<PlayCircle size={15} />}
              onClick={handlePlay}
              loading={loadingAudio}
              style={{ height: 36, padding: '0 14px', fontSize: 12 }}
            >
              Play recording
            </Button>
          )}
          {!!audioError && <div style={styles.audioError}>{audioError}</div>}
        </div>
      )}

      {!!recording.summary && recording.summary_status === 'success' && (
        <div style={styles.section}>
          <div style={styles.sectionLabel}><Sparkles size={13} color={colors.primary} /> Summary</div>
          <div style={styles.sectionText}>{recording.summary}</div>
        </div>
      )}

      {!!recording.transcript_text && (
        <div style={styles.section}>
          <div style={styles.sectionLabel}><FileText size={13} color={colors.primary} /> Transcript</div>
          <div style={{ ...styles.sectionText, ...styles.transcriptBox }}>{recording.transcript_text}</div>
        </div>
      )}
    </Card>
  );
}

/** Shared filter bar for both detail views — date range + search + an
 * entity multi-select (dealers on the rep page, reps on the dealer page)
 * passed in as `entityFilter`. */
function DetailFilters({ from, setFrom, to, setTo, search, setSearch, entityFilter, onReset }) {
  return (
    <FilterBar onReset={onReset}>
      <div style={styles.dateField}>
        <input type="date" style={styles.dateInput} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
      </div>
      <span style={styles.filterDash}>to</span>
      <div style={styles.dateField}>
        <input type="date" style={styles.dateInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </div>
      {entityFilter}
      <SearchBar value={search} onChange={setSearch} placeholder="Search transcripts..." style={{ minWidth: 220 }} />
    </FilterBar>
  );
}

function RepresentativeDetail({ employeeId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => toDateInputValue(new Date()));
  const [search, setSearch] = useState('');
  const [dealerIds, setDealerIds] = useState([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (search.trim()) params.search = search.trim();
      if (dealerIds.length > 0) params.dealer_ids = dealerIds.join(',');
      const res = await apiClient.get(`/recordings/representatives/${employeeId}`, { params });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load recordings.');
    } finally {
      setLoading(false);
    }
  }, [employeeId, from, to, search, dealerIds]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div>
      <button type="button" className="ft-btn ft-btn-secondary" style={styles.backBtn} onClick={onBack}>
        <ChevronLeft size={15} /> Back to representatives
      </button>

      <SectionHeader
        title={data?.representative?.name || 'Representative'}
        subtitle={data?.representative?.region || undefined}
      />

      <DetailFilters
        from={from} setFrom={setFrom} to={to} setTo={setTo} search={search} setSearch={setSearch}
        entityFilter={(
          <DealerMultiSelect dealers={data?.dealers || []} selectedIds={dealerIds} onChange={setDealerIds} style={{ minWidth: 220 }} />
        )}
        onReset={() => { setFrom(defaultFrom()); setTo(toDateInputValue(new Date())); setSearch(''); setDealerIds([]); }}
      />

      {error ? (
        <EmptyState title="Couldn't load recordings" subtitle={error} onRetry={fetchData} />
      ) : loading ? (
        <Card><div style={styles.loadingText}>Loading recordings…</div></Card>
      ) : (data?.recordings || []).length === 0 ? (
        <EmptyState icon={<Mic size={22} color={colors.textMuted} />} title="No recordings match these filters" subtitle="Try widening the date range or clearing the dealer filter." />
      ) : (
        <div style={styles.recList}>
          {data.recordings.map((r) => (
            <RecordingCard key={r.id} recording={r} subjectLabel="at" subjectName={r.dealer_name} />
          ))}
        </div>
      )}
    </div>
  );
}

function DealerDetail({ dealerId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => toDateInputValue(new Date()));
  const [search, setSearch] = useState('');
  const [employeeIds, setEmployeeIds] = useState([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (search.trim()) params.search = search.trim();
      if (employeeIds.length > 0) params.employee_ids = employeeIds.join(',');
      const res = await apiClient.get(`/recordings/dealers/${dealerId}`, { params });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load recordings.');
    } finally {
      setLoading(false);
    }
  }, [dealerId, from, to, search, employeeIds]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div>
      <button type="button" className="ft-btn ft-btn-secondary" style={styles.backBtn} onClick={onBack}>
        <ChevronLeft size={15} /> Back to dealers
      </button>

      <SectionHeader
        title={data?.dealer?.name || 'Dealer'}
        subtitle={data?.dealer?.address || undefined}
      />

      <DetailFilters
        from={from} setFrom={setFrom} to={to} setTo={setTo} search={search} setSearch={setSearch}
        entityFilter={(
          <RepMultiSelect employees={data?.representatives || []} selectedIds={employeeIds} onChange={setEmployeeIds} style={{ minWidth: 220 }} />
        )}
        onReset={() => { setFrom(defaultFrom()); setTo(toDateInputValue(new Date())); setSearch(''); setEmployeeIds([]); }}
      />

      {error ? (
        <EmptyState title="Couldn't load recordings" subtitle={error} onRetry={fetchData} />
      ) : loading ? (
        <Card><div style={styles.loadingText}>Loading recordings…</div></Card>
      ) : (data?.recordings || []).length === 0 ? (
        <EmptyState icon={<Mic size={22} color={colors.textMuted} />} title="No recordings match these filters" subtitle="Try widening the date range or clearing the representative filter." />
      ) : (
        <div style={styles.recList}>
          {data.recordings.map((r) => (
            <RecordingCard key={r.id} recording={r} subjectLabel="by" subjectName={r.employee_name} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepresentativesList({ onSelect }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => toDateInputValue(new Date()));

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (search.trim()) params.search = search.trim();
      const res = await apiClient.get('/recordings/representatives', { params });
      setRows(res.data.representatives || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load representatives.');
    } finally {
      setLoading(false);
    }
  }, [from, to, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo(() => [
    { key: 'name', label: 'Representative' },
    { key: 'region', label: 'Region' },
    { key: 'recording_count', label: 'Recordings', width: 120 },
    { key: 'last_recording_at', label: 'Last recording', render: (row) => formatDateTime(row.last_recording_at) },
  ], []);

  return (
    <div>
      <FilterBar onReset={() => { setFrom(defaultFrom()); setTo(toDateInputValue(new Date())); setSearch(''); }}>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </div>
        <span style={styles.filterDash}>to</span>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        <SearchBar value={search} onChange={setSearch} placeholder="Search representatives..." style={{ minWidth: 240 }} />
      </FilterBar>

      <Card noPadding style={{ overflow: 'hidden' }}>
        {error ? (
          <EmptyState title="Couldn't load representatives" subtitle={error} onRetry={fetchData} />
        ) : (
          <DataTable
            key={`${from}-${to}-${search}`}
            columns={columns}
            rows={rows}
            loading={loading}
            emptyTitle="No representatives have recordings in this range"
            emptySubtitle="Try widening the date range."
            onRowClick={(row) => onSelect(row.id)}
          />
        )}
      </Card>
    </div>
  );
}

function DealersList({ onSelect }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => toDateInputValue(new Date()));

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (search.trim()) params.search = search.trim();
      const res = await apiClient.get('/recordings/dealers', { params });
      setRows(res.data.dealers || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load dealers.');
    } finally {
      setLoading(false);
    }
  }, [from, to, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo(() => [
    { key: 'name', label: 'Dealer' },
    { key: 'address', label: 'Address' },
    { key: 'recording_count', label: 'Recordings', width: 120 },
    { key: 'last_recording_at', label: 'Last recording', render: (row) => formatDateTime(row.last_recording_at) },
  ], []);

  return (
    <div>
      <FilterBar onReset={() => { setFrom(defaultFrom()); setTo(toDateInputValue(new Date())); setSearch(''); }}>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </div>
        <span style={styles.filterDash}>to</span>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        <SearchBar value={search} onChange={setSearch} placeholder="Search dealers..." style={{ minWidth: 240 }} />
      </FilterBar>

      <Card noPadding style={{ overflow: 'hidden' }}>
        {error ? (
          <EmptyState title="Couldn't load dealers" subtitle={error} onRetry={fetchData} />
        ) : (
          <DataTable
            key={`${from}-${to}-${search}`}
            columns={columns}
            rows={rows}
            loading={loading}
            emptyTitle="No dealers have recordings in this range"
            emptySubtitle="Try widening the date range."
            onRowClick={(row) => onSelect(row.id)}
          />
        )}
      </Card>
    </div>
  );
}

export default function RecordingsPage() {
  const [activeTab, setActiveTab] = useState('representatives');
  const [selectedRepId, setSelectedRepId] = useState(null);
  const [selectedDealerId, setSelectedDealerId] = useState(null);

  const inDetailView = !!selectedRepId || !!selectedDealerId;

  return (
    <div style={styles.page} className="ft-page">
      {!inDetailView && (
        <SectionHeader
          title="Recordings"
          subtitle="Meeting recordings and transcripts, by representative or by dealer"
        />
      )}

      {!inDetailView && (
        <Card noPadding style={{ padding: spacing.lg, marginBottom: spacing.md }}>
          <div style={styles.tabRow}>
            {SUB_TABS.map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  className={`ft-btn ${active ? 'ft-btn-primary' : 'ft-btn-secondary'}`}
                  style={{ height: 36, padding: '0 16px', fontSize: 13 }}
                  onClick={() => setActiveTab(t.key)}
                  aria-pressed={active}
                >
                  <Icon size={14} /> {t.label}
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {selectedRepId ? (
        <RepresentativeDetail employeeId={selectedRepId} onBack={() => setSelectedRepId(null)} />
      ) : selectedDealerId ? (
        <DealerDetail dealerId={selectedDealerId} onBack={() => setSelectedDealerId(null)} />
      ) : activeTab === 'representatives' ? (
        <RepresentativesList onSelect={setSelectedRepId} />
      ) : (
        <DealersList onSelect={setSelectedDealerId} />
      )}
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  tabRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  dateField: { display: 'flex', alignItems: 'center', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0 10px', height: 42 },
  dateInput: { border: 'none', outline: 'none', fontSize: 13, color: colors.text, background: 'transparent' },
  filterDash: { fontSize: 13, color: colors.textMuted },
  backBtn: { height: 36, padding: '0 14px', fontSize: 12, marginBottom: spacing.lg },
  loadingText: { ...typography.body, color: colors.textSecondary, textAlign: 'center', padding: spacing.xl },
  recList: { display: 'flex', flexDirection: 'column', gap: spacing.md },
  recCard: { padding: spacing.lg },
  recHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  recTitle: { ...typography.bodyMedium, color: colors.text, fontWeight: 700 },
  recMeta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  statusPill: { fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, flexShrink: 0 },
  audioError: { ...typography.caption, color: colors.dangerDark, marginTop: 6 },
  section: { marginTop: spacing.md, paddingTop: spacing.md, borderTop: `1px solid ${colors.border}` },
  sectionLabel: { display: 'flex', alignItems: 'center', gap: 6, ...typography.caption, fontWeight: 700, color: colors.text, marginBottom: 6 },
  sectionText: { ...typography.body, fontSize: 13, color: colors.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  transcriptBox: { maxHeight: 220, overflowY: 'auto' },
};
