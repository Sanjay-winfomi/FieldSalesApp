import React from 'react';

/**
 * Shared page backdrop for every authenticated view (Dashboard, Reports,
 * Admin, RepDetails, Notifications) — soft blurred grey blobs fixed to the
 * viewport (same neutral grey as the "Not logged in" badge), so the app
 * reads as one consistent backdrop instead of a flat fill. Purely decorative
 * (aria-hidden, pointer-events: none) and pinned behind the actual page
 * content via z-index.
 */
export default function AppBackground({ children }) {
  return (
    <div style={styles.root}>
      <div style={styles.blobOne} aria-hidden="true" />
      <div style={styles.blobTwo} aria-hidden="true" />
      <div style={styles.blobThree} aria-hidden="true" />
      <div style={styles.content}>{children}</div>
    </div>
  );
}

const styles = {
  root: { position: 'relative', minHeight: '100vh', backgroundColor: '#F3F4F6' },
  blobOne: {
    position: 'fixed', top: '-14%', left: '-10%', width: 460, height: 460, borderRadius: '50%',
    background: 'rgba(148,163,184,0.28)', filter: 'blur(100px)', pointerEvents: 'none', zIndex: 0,
  },
  blobTwo: {
    position: 'fixed', bottom: '-16%', right: '-10%', width: 500, height: 500, borderRadius: '50%',
    background: 'rgba(203,213,225,0.30)', filter: 'blur(110px)', pointerEvents: 'none', zIndex: 0,
  },
  blobThree: {
    position: 'fixed', top: '35%', left: '45%', width: 360, height: 360, borderRadius: '50%',
    background: 'rgba(226,232,240,0.20)', filter: 'blur(120px)', pointerEvents: 'none', zIndex: 0,
  },
  content: { position: 'relative', zIndex: 1 },
};
