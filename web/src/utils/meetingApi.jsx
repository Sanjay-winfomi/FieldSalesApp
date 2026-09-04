import axios from 'axios';

/**
 * meetingApi.jsx — the ONE call the Recordings tab needs outside apiClient's
 * normal /api/* surface: resolving a playable audio URL. That endpoint
 * (GET /get-audio-link) lives on the same backend as apiClient's API_BASE,
 * but mounted unprefixed (see app/routers/meeting_recorder.py's own comment
 * on why) and with no auth of its own — same shape the mobile app's
 * meetingApi.js already calls this same endpoint with.
 */
function resolveMeetingBase() {
  const configured = process.env.NEXT_PUBLIC_MEETING_BACKEND_URL;
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    console.error('NEXT_PUBLIC_MEETING_BACKEND_URL must be set for production builds.');
    return null;
  }

  console.warn(
    'NEXT_PUBLIC_MEETING_BACKEND_URL is not set — the Recordings tab will not be able ' +
    'to play audio. Set it in web/.env (see .env.example).'
  );
  return 'http://localhost:3001';
}

const MEETING_BASE = resolveMeetingBase();

export async function getAudioLink(fileId) {
  const { data } = await axios.get(`${MEETING_BASE}/get-audio-link`, { params: { file_id: fileId } });
  return data.webUrl;
}
