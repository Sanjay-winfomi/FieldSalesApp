import axios from 'axios';
// SDK 54's expo-file-system (v19) split into a new File/Directory API and a
// `/legacy` subpath that keeps the old uploadAsync/downloadAsync functions —
// uploadAsync no longer exists on the top-level import at all, so importing
// from 'expo-file-system' directly here silently made FileSystem.uploadAsync
// undefined, throwing at call time and surfacing as a generic "Upload
// failed" alert with no indication this was the cause.
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Client for the meeting-recorder backend — a separate FastAPI service
 * (meeting-recorder-app-backend/) from the main FieldTrack API, so it gets
 * its own axios instance/base URL rather than reusing src/services/api.js.
 * It has no login of its own; every endpoint is scoped by an opaque
 * `owner_id` string that the caller (MeetingsScreen etc.) supplies — this
 * app uses the logged-in employee's id for that, so recordings are scoped
 * per FieldTrack account without needing a second auth system.
 */
const getMeetingBaseUrl = () => {
  const configured = process.env.EXPO_PUBLIC_MEETING_BACKEND_URL;
  if (configured) return configured;

  if (__DEV__) {
    console.warn(
      'EXPO_PUBLIC_MEETING_BACKEND_URL is not set — the Meetings tab will not be able ' +
      'to reach the meeting-recorder backend. Set it in mobile/.env (see .env.example).'
    );
    return null;
  }

  console.error('EXPO_PUBLIC_MEETING_BACKEND_URL must be set for production builds.');
  return null;
};

const BASE_URL = getMeetingBaseUrl();

// Same 60s reasoning as api.js: this backend can also cold-start on a
// free/low tier host, and /start-processing itself just enqueues a
// background job so it responds fast — the long timeout mainly protects
// /status and /get-recording-data on a slow network.
export const meetingApi = axios.create({
  baseURL: BASE_URL,
  timeout: 60000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Render's free tier spins this backend down after ~15min idle — the same
// cold-start problem api.js already handles for the field-sales backend
// (see its own comment for why these specific delays). Without this, the
// first request after any idle period fails outright as a 502/503/504
// instead of the same request succeeding seconds later once Render finishes
// booting the container.
const COLD_START_RETRY_DELAYS_MS = [4000, 8000, 15000];

meetingApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if ([502, 503, 504].includes(error.response?.status) && originalRequest) {
      const attempt = originalRequest._coldStartRetries || 0;
      if (attempt < COLD_START_RETRY_DELAYS_MS.length) {
        originalRequest._coldStartRetries = attempt + 1;
        await sleep(COLD_START_RETRY_DELAYS_MS[attempt]);
        return meetingApi(originalRequest);
      }
    }
    return Promise.reject(error);
  }
);

export async function getSasToken(fileName) {
  const { data } = await meetingApi.get('/get-sas-token', { params: { file_name: fileName } });
  return data; // { url, sasToken }
}

export async function getDeleteToken(file) {
  const { data } = await meetingApi.get('/get-delete-token', { params: { file } });
  return data; // { url, sasToken }
}

// Uploads a locally-recorded audio file straight to Azure Blob Storage via
// the SAS url/token pair from getSasToken — the backend never sees the raw
// audio bytes at this step, it only issues the token. x-ms-blob-type is
// required by Azure for a single-shot PUT of a block blob; omitting it
// makes Azure reject the request outright.
export async function uploadRecordingToBlob(localUri, sasUrl, sasToken, contentType) {
  const result = await FileSystem.uploadAsync(`${sasUrl}${sasToken}`, localUri, {
    httpMethod: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': contentType,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Blob upload failed with status ${result.status}`);
  }
  return result;
}

// Deletes a raw chunk blob directly from Azure — used when the rep discards
// an in-progress recording after it's already been uploaded but before
// /start-processing is called, so it doesn't linger in storage forever.
export async function deleteBlobDirect(fileName) {
  const { url, sasToken } = await getDeleteToken(fileName);
  await axios.delete(`${url}${sasToken}`);
}

export async function startProcessing(payload) {
  const { data } = await meetingApi.post('/start-processing', payload);
  return data; // { message, title, session_id }
}

export async function getRecordingStatus(sessionId) {
  const { data } = await meetingApi.get('/status', { params: { session_id: sessionId } });
  return data;
}

// Resolves a Graph driveItem id (audio_file_id/transcript_file_id from
// getRecordingStatus) to an openable SharePoint URL. The id alone isn't a
// URL, and the Graph app-only credentials needed to resolve it live only on
// the backend, so this is a real network call, not a local computation —
// callers should fetch it lazily (e.g. on "Open in SharePoint" tap) rather
// than eagerly for every recording in a list.
export async function getSharePointLink(fileId) {
  const { data } = await meetingApi.get('/get-sharepoint-link', { params: { file_id: fileId } });
  return data.webUrl;
}

export async function getRecordings(ownerId, searchQuery) {
  const { data } = await meetingApi.get('/get-recording-data', {
    params: { owner_id: ownerId, ...(searchQuery ? { search_query: searchQuery } : {}) },
  });
  return data.recording_data || [];
}

export async function deleteRecording(recordId) {
  const { data } = await meetingApi.delete('/delete-recording', { params: { record_id: recordId } });
  return data;
}

export async function getFolders(ownerId) {
  const { data } = await meetingApi.get('/get-folders', { params: { owner_id: ownerId } });
  return data || [];
}

// Full-replace sync, matching the backend's own contract: pass the complete
// current folder list every time (not just the changed one) — anything
// omitted gets deleted server-side.
export async function syncFolders(ownerId, folders) {
  const { data } = await meetingApi.post('/sync-folders', { owner_id: ownerId, folders });
  return data;
}

export async function updateRecordingFolder(sessionId, uiFolderId) {
  const { data } = await meetingApi.post('/update-recording-folder', {
    session_id: sessionId,
    ui_folder_id: uiFolderId,
  });
  return data;
}
