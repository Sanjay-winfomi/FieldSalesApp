"""meeting_recorder.py — ported from the standalone meeting-recorder-app-backend
service (previously its own FastAPI app on AWS App Runner, then Render) into a
router on this app. Business logic is unchanged from that port; only the
FastAPI wiring changed (APIRouter instead of a second FastAPI() app, no
second CORS middleware — this app's own DynamicCORSMiddleware already covers
these routes, startup hook moved into app/main.py's lifespan since APIRouter
has no on_event of its own).

Deliberately kept as plain `def` (sync) route handlers with a psycopg2
ThreadedConnectionPool, exactly as in the original — NOT ported to this app's
own asyncpg pool (app/db/pool.py), which talks to a different Postgres
database entirely (fieldtrack vs this feature's own "transcript" DB). FastAPI
runs sync `def` routes in a thread pool automatically, so the blocking
psycopg2 calls here don't block the event loop used by the rest of the app.
All of this feature's own env vars (AZURE_*, SP_*, DATABASE_URL, etc.) are
read ad-hoc via os.getenv with graceful fallbacks (db_pool stays None if
unset) rather than through app/core/config.py's fail-fast run_boot_checks() —
so a missing meeting-recorder secret degrades only this feature, and never
prevents the whole app (and the unrelated, already-in-production field-sales
API) from booting.
"""
import os
import json
import requests
import time
import re
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, BackgroundTasks, Response, Depends, Request
import hmac
import hashlib
import base64
from pydantic import BaseModel
from typing import List, Optional
import tempfile
import pydub
import psycopg2
from psycopg2 import pool
from azure.storage.blob import BlobServiceClient, BlobSasPermissions, generate_blob_sas, ContentSettings
from urllib.parse import quote
from openai import AzureOpenAI
from geopy.geocoders import Nominatim

router = APIRouter()

# Added a unique user_agent and increased timeout to 10s to reduce Nominatim Geocoding Errors
geolocator = Nominatim(user_agent="winfomi_meeting_recorder_production_v2", timeout=10)

# ── Pydantic Models ────────────────────────────────────────────────────────────────
class SasTokenRequest(BaseModel):
    file_name: Optional[str] = None

class DeleteTokenRequest(BaseModel):
    file: str

class StatusRequest(BaseModel):
    session_id: str

class ProcessingRequest(BaseModel):
    recording_names: List[str]
    title: str = "Untitled Recording"
    session_id: str
    translate_tanglish: bool = False
    owner_email: str = ""
    device_os: str = "Unknown"
    client_upload_time_ms: int = 0
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    ui_folder_id: Optional[str] = None
    duration: int = 0

class MeetingPayload(BaseModel):
    recording_id: str
    latitude: float
    longitude: float

# ── Azure Storage ──────────────────────────────────────────────────────────────────
CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
CONTAINER_NAME = "recordings"

# ── Azure Speech ──────────────────────────────────────────────────────────────────
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY")
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION")
TRANSCRIBE_URL = f"https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions"

# ── Azure OpenAI ──────────────────────────────────────────────────────────────────
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_KEY = os.getenv("AZURE_OPENAI_KEY")
AZURE_OPENAI_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "gpt-4o-mini")

# ── SharePoint / Microsoft Graph (Client Credentials flow) ─────────────────────
SP_CLIENT_ID = os.getenv("SP_CLIENT_ID")
SP_TENANT_ID = os.getenv("SP_TENANT_ID")
SP_CLIENT_SECRET = os.getenv("SP_CLIENT_SECRET")
SP_SITE_ID = os.getenv("SP_SITE_ID")
SP_DRIVE_ID = os.getenv("SP_DRIVE_ID")
SP_BASE_PATH = os.getenv("SP_BASE_PATH", "Salesforce/Mobile Recording")

GRAPH_BASE_URL = f"https://graph.microsoft.com/v1.0/sites/{SP_SITE_ID}/drives/{SP_DRIVE_ID}"


# ═══════════════════════════════════════════════════════════════════════════════
#  AZURE BLOB STORAGE ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/get-sas-token")
def get_sas_token(req: SasTokenRequest = Depends()):
    file_name = req.file_name
    try:
        blob_service_client = BlobServiceClient.from_connection_string(CONNECTION_STRING)

        # Use the file name supplied by the app, or generate a unique fallback
        if not file_name:
            file_name = f"meeting-{int(datetime.now().timestamp())}.wav"

        # Create a 60-minute write-only token
        sas_token = generate_blob_sas(
            account_name=blob_service_client.account_name,
            container_name=CONTAINER_NAME,
            blob_name=file_name,
            account_key=blob_service_client.credential.account_key,
            permission=BlobSasPermissions(write=True),
            expiry=datetime.now(timezone.utc) + timedelta(minutes=60)
        )

        url = f"https://{blob_service_client.account_name}.blob.core.windows.net/{CONTAINER_NAME}/{file_name}"

        return {"url": url, "sasToken": f"?{sas_token}"}

    except Exception as e:
        print(f"❌ SAS Generation Error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/get-delete-token")
def get_delete_token(req: DeleteTokenRequest = Depends()):
    file = req.file
    try:
        blob_service_client = BlobServiceClient.from_connection_string(CONNECTION_STRING)

        # Create a 60-minute delete-only token for the specified blob
        sas_token = generate_blob_sas(
            account_name=blob_service_client.account_name,
            container_name=CONTAINER_NAME,
            blob_name=file,
            account_key=blob_service_client.credential.account_key,
            permission=BlobSasPermissions(delete=True),
            expiry=datetime.now(timezone.utc) + timedelta(minutes=60)
        )

        url = f"https://{blob_service_client.account_name}.blob.core.windows.net/{CONTAINER_NAME}/{file}"

        return {"url": url, "sasToken": f"?{sas_token}"}

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Delete Token Error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

DATABASE_URL = os.getenv("DATABASE_URL")

try:
    db_pool = pool.ThreadedConnectionPool(1, 30, DATABASE_URL) if DATABASE_URL else None
except Exception as e:
    print(f"⚠️ Failed to initialize connection pool: {e}")
    db_pool = None

def save_pending_transcription(job_id: str, metadata: dict):
    """Persist job metadata so it survives process restarts."""
    if not db_pool:
        print("[Pending Transcriptions] ⚠️ DB Pool not initialized — job metadata NOT persisted!")
        return
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO pending_transcriptions
                (job_id, session_id, title, owner_email, device_os, merged_filename,
                 recording_names, folder_id, audio_file_id, latitude, longitude, final_duration_seconds)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (job_id) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                title = EXCLUDED.title,
                owner_email = EXCLUDED.owner_email,
                device_os = EXCLUDED.device_os,
                merged_filename = EXCLUDED.merged_filename,
                recording_names = EXCLUDED.recording_names,
                folder_id = EXCLUDED.folder_id,
                audio_file_id = EXCLUDED.audio_file_id,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                final_duration_seconds = EXCLUDED.final_duration_seconds
        """, (
            job_id, metadata["session_id"], metadata["title"], metadata["owner_email"],
            metadata["device_os"], metadata["merged_filename"],
            json.dumps(metadata["recording_names"]), metadata["folder_id"],
            metadata["audio_file_id"], metadata["latitude"], metadata["longitude"],
            metadata["final_duration_seconds"]
        ))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"[Pending Transcriptions] ❌ Failed to save job {job_id}: {e}")
    finally:
        if conn:
            db_pool.putconn(conn)


def load_pending_transcription(job_id: str) -> dict | None:
    """Fetch job metadata by job_id. Returns None if not found or DB unavailable."""
    if not db_pool:
        return None
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("""
            SELECT session_id, title, owner_email, device_os, merged_filename,
                   recording_names, folder_id, audio_file_id, latitude, longitude, final_duration_seconds
            FROM pending_transcriptions WHERE job_id = %s
        """, (job_id,))
        row = cur.fetchone()
        cur.close()
        if not row:
            return None
        return {
            "session_id": row[0], "title": row[1], "owner_email": row[2], "device_os": row[3],
            "merged_filename": row[4], "recording_names": row[5], "folder_id": row[6],
            "audio_file_id": row[7], "latitude": row[8], "longitude": row[9],
            "final_duration_seconds": row[10],
        }
    except Exception as e:
        print(f"[Pending Transcriptions] ❌ Failed to load job {job_id}: {e}")
        return None
    finally:
        if conn:
            db_pool.putconn(conn)


def delete_pending_transcription(job_id: str):
    """Remove a job's metadata once it's been processed (success or failure)."""
    if not db_pool:
        return
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("DELETE FROM pending_transcriptions WHERE job_id = %s", (job_id,))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"[Pending Transcriptions] ❌ Failed to delete job {job_id}: {e}")
    finally:
        if conn:
            db_pool.putconn(conn)

def set_db_status(session_id: str, status: str):
    if not db_pool:
        print("[DB Status] ⚠️ DB Pool not initialized")
        return
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()

        update_query = "UPDATE call_recording SET processing_status = %s WHERE session_id = %s"
        cur.execute(update_query, (status, session_id))

        if cur.rowcount == 0:
            insert_query = "INSERT INTO call_recording (session_id, processing_status) VALUES (%s, %s)"
            cur.execute(insert_query, (session_id, status))

        conn.commit()
        cur.close()
    except Exception as e:
        print(f"[DB Status] ⚠️ Failed to update status '{status}': {e}")
    finally:
        if conn:
            db_pool.putconn(conn)

def get_db_status(session_id: str) -> str:
    if not db_pool:
        return "unknown"
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("SELECT processing_status FROM call_recording WHERE session_id = %s", (session_id,))
        row = cur.fetchone()
        cur.close()
        if row and row[0]:
            return row[0]
    except Exception as e:
        print(f"[DB Status] ⚠️ Failed to get status: {e}")
    finally:
        if conn:
            db_pool.putconn(conn)
    return "unknown"

def format_duration(total_seconds: float) -> str:
    total_seconds = int(total_seconds)
    hrs = total_seconds // 3600
    mins = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    parts = []
    if hrs > 0:
        parts.append(f"{hrs} hr")
    if mins > 0:
        parts.append(f"{mins} min")
    if secs > 0 or not parts:
        parts.append(f"{secs} sec")

    return " ".join(parts)

# ═══════════════════════════════════════════════════════════════════════════════
#  SHAREPOINT / MICROSOFT GRAPH HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def get_graph_access_token() -> str:
    """Obtain an app-only access token via the Client Credentials OAuth2 flow."""
    token_url = f"https://login.microsoftonline.com/{SP_TENANT_ID}/oauth2/v2.0/token"

    resp = requests.post(token_url, data={
        "client_id": SP_CLIENT_ID,
        "client_secret": SP_CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    })

    if resp.status_code != 200:
        raise Exception(f"Failed to get Graph token: {resp.status_code} {resp.text}")

    token = resp.json().get("access_token")
    if not token:
        raise Exception("No access_token in token response")

    return token


def ensure_sharepoint_folder(title: str, token: str) -> str:
    """Create meeting folder under BASE_PATH, or return existing folder's ID."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    encoded_path = quote(SP_BASE_PATH)
    endpoint = f"{GRAPH_BASE_URL}/root:/{encoded_path}:/children"

    safe_title = re.sub(r'[<>:"/\\|?*]', '', title).strip() or 'recording'

    # Try to create — use "fail" conflict behavior so we don't create duplicates
    resp = requests.post(endpoint, headers=headers, json={
        "name": safe_title,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    })

    if resp.status_code in [200, 201]:
        folder_id = resp.json()["id"]
        print(f"[SharePoint] 📁 Created folder: {title} (ID: {folder_id})")
        return folder_id

    if resp.status_code == 409:
        # Folder already exists — look it up by path
        lookup_url = f"{GRAPH_BASE_URL}/root:/{encoded_path}/{quote(safe_title)}"
        lookup_resp = requests.get(lookup_url, headers=headers)

        if lookup_resp.status_code == 200:
            folder_id = lookup_resp.json()["id"]
            return folder_id

        raise Exception(f"Folder exists but lookup failed: {lookup_resp.status_code} {lookup_resp.text}")

    raise Exception(f"Failed to create folder: {resp.status_code} {resp.text}")


def upload_transcript_to_sharepoint(folder_id: str, transcript_text: str, file_name: str, token: str):
    """Upload a plain-text transcript file into the given SharePoint folder."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "text/plain",
    }

    endpoint = f"{GRAPH_BASE_URL}/items/{folder_id}:/{quote(file_name)}:/content"

    resp = requests.put(endpoint, headers=headers, data=transcript_text.encode("utf-8"))

    if resp.status_code in [200, 201]:
        print(f"[SharePoint] ✅ Diarized transcript uploaded: {file_name}")
        return resp.json().get("id")
    else:
        raise Exception(f"Transcript upload failed: {resp.status_code} {resp.text}")

def upload_large_file_to_sharepoint(folder_id: str, file_path: str, file_name: str, token: str):
    """Upload a large file to SharePoint using an upload session."""
    headers = {"Authorization": f"Bearer {token}"}
    endpoint = f"{GRAPH_BASE_URL}/items/{folder_id}:/{quote(file_name)}:/createUploadSession"
    res = requests.post(endpoint, headers=headers, json={"item": {"@microsoft.graph.conflictBehavior": "replace"}})

    if res.status_code not in [200, 201]:
        raise Exception(f"Failed to create upload session: {res.text}")

    upload_url = res.json()["uploadUrl"]
    file_size = os.path.getsize(file_path)
    chunk_size = 320 * 1024 * 10  # 3.2 MB chunks

    with open(file_path, 'rb') as f:
        for i in range(0, file_size, chunk_size):
            chunk_data = f.read(chunk_size)
            chunk_end = min(i + len(chunk_data) - 1, file_size - 1)
            chunk_headers = {
                "Content-Length": str(len(chunk_data)),
                "Content-Range": f"bytes {i}-{chunk_end}/{file_size}"
            }
            upload_res = requests.put(upload_url, headers=chunk_headers, data=chunk_data)
            if upload_res.status_code in [200, 201]:
                item_id = upload_res.json().get("id")
                print(f"[SharePoint] ✅ Large file uploaded: {file_name} (ID: {item_id})")
                return item_id
            elif upload_res.status_code == 202:
                continue
            else:
                raise Exception(f"Chunk upload failed: {upload_res.text}")

    raise Exception("Upload finished but didn't receive a 200/201 created response.")


def delete_blob(blob_file_name: str):
    """Delete a blob from Azure Storage after processing is complete (cost savings)."""
    try:
        blob_service_client = BlobServiceClient.from_connection_string(CONNECTION_STRING)
        sas_token = generate_blob_sas(
            account_name=blob_service_client.account_name,
            container_name=CONTAINER_NAME,
            blob_name=blob_file_name,
            account_key=blob_service_client.credential.account_key,
            permission=BlobSasPermissions(delete=True),
            expiry=datetime.now(timezone.utc) + timedelta(minutes=10)
        )

        url = f"https://{blob_service_client.account_name}.blob.core.windows.net/{CONTAINER_NAME}/{blob_file_name}?{sas_token}"
        resp = requests.delete(url)

        if resp.status_code in [200, 202, 404]:
            pass
        else:
            print(f"[Azure] ⚠️ Blob delete returned {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[Azure] ❌ Blob delete error: {e}")


def delete_transcription_job(job_id: str):
    """Deletes a completed Azure Speech batch-transcription job. Microsoft
    recommends removing jobs once their results are retrieved — leaving them
    on the resource indefinitely is exactly what this backend used to do
    (78+ jobs going back months, all still 'Succeeded' and never cleaned up),
    which Microsoft's own docs warn degrades the account over time. Best-
    effort/non-fatal: called after the transcript is already safely
    downloaded, so a failure here must never fail the pipeline."""
    try:
        resp = requests.delete(f"{TRANSCRIBE_URL}/{job_id}", headers={"Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY})
        if resp.status_code not in (200, 202, 204, 404):
            print(f"[Azure Speech] ⚠️ Failed to delete transcription job {job_id}: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"[Azure Speech] ❌ Error deleting transcription job {job_id}: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
#  TANGLISH → ENGLISH TRANSLATION (Azure OpenAI)
# ═══════════════════════════════════════════════════════════════════════════════

def get_filtered_word_count(segments_list: list) -> int:
    """Calculates the word count of the transcript excluding low-confidence segments."""
    valid_words = 0
    for seg in segments_list:
        confidence = seg.get("confidence", 0.0)
        if confidence >= 0.5:
            text = seg.get("text", "")
            valid_words += len(text.split())
    return valid_words

def translate_tanglish_to_english(raw_transcript: str) -> tuple:
    """Translates a Tanglish (Tamil + English) meeting transcript to professional English.
    Preserves speaker diarization labels. Returns raw transcript on failure."""
    try:
        client = AzureOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_KEY,
            api_version="2024-02-01"
        )

        print("[Translation] 🌐 Sending transcript to Azure OpenAI for Tanglish → English translation...")

        response = client.chat.completions.create(
            model=AZURE_OPENAI_DEPLOYMENT,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert corporate translator. "
                        "The user will provide a meeting transcript spoken in 'Tanglish' (a mix of Tamil and English). "
                        "Translate the entire text into clear, professional business English. "
                        "You must preserve all speaker diarization labels (e.g., 'Speaker 1:', 'Speaker 2:') exactly as they appear. "
                        "Do NOT use markdown bolding or asterisks (e.g., **Speaker 1:**) anywhere in the output. Keep it plain text."
                    )
                },
                {
                    "role": "user",
                    "content": raw_transcript
                }
            ],
            temperature=0.3,
        )

        translated = response.choices[0].message.content.strip()
        usage = {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens
        }
        print(f"[Translation] ✅ Translation complete ({len(translated)} chars)")
        return translated, usage

    except Exception as e:
        print(f"[Translation] ❌ Translation failed: {e}")
        return raw_transcript, {"prompt_tokens": 0, "completion_tokens": 0}


# ═══════════════════════════════════════════════════════════════════════════════
#  BACKGROUND PROCESSING PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════

def submit_transcription_job(recording_names: List[str], title: str, session_id: str, translate_tanglish: bool = False, owner_email: str = "", device_os: str = "Unknown", client_upload_time_ms: int = 0, latitude: float = None, longitude: float = None, ui_folder_id: str = None):
    try:
        _submit_transcription_job(recording_names, title, session_id, translate_tanglish, owner_email, device_os, client_upload_time_ms, latitude, longitude, ui_folder_id)
    except Exception as e:
        print(f"[Pipeline] ❌ Fatal error in submit_transcription_job: {e}")
        import traceback
        traceback.print_exc()
        set_db_status(session_id, "failed")

def _submit_transcription_job(recording_names: List[str], title: str, session_id: str, translate_tanglish: bool = False, owner_email: str = "", device_os: str = "Unknown", client_upload_time_ms: int = 0, latitude: float = None, longitude: float = None, ui_folder_id: str = None):
    """Handles merging chunks, Azure Speech → SharePoint pipeline in the background."""
    folder_id = None

    pipeline_start_time = time.time()

    print(f"\n{'='*60}")
    print(f"[Pipeline] Starting processing for: {title} (Session: {session_id})")
    print(f"{'='*60}\n")

    set_db_status(session_id, "processing")

    blob_service_client = BlobServiceClient.from_connection_string(CONNECTION_STRING)
    container_client = blob_service_client.get_container_client(CONTAINER_NAME)

    merged_audio = None

    with tempfile.TemporaryDirectory() as tmpdirname:
        for i, chunk_name in enumerate(recording_names):
            blob_client = container_client.get_blob_client(chunk_name)
            download_path = os.path.join(tmpdirname, chunk_name)

            with open(download_path, "wb") as download_file:
                download_file.write(blob_client.download_blob().readall())

            # Load and merge using pydub
            ext = chunk_name.split('.')[-1].lower()
            try:
                segment = pydub.AudioSegment.from_file(download_path, format=ext)
                if merged_audio is None:
                    merged_audio = segment
                else:
                    merged_audio += segment
            except Exception as e:
                print(f"[Pipeline] ❌ Failed to process chunk {chunk_name}: {e}")

        if merged_audio is None:
            print("[Pipeline] ❌ No valid audio chunks to process.")
            set_db_status(session_id, "failed")
            return

        # Ensure 16kHz Mono for Azure Speech optimal diarization and transcription
        merged_audio = merged_audio.set_frame_rate(16000).set_channels(1)

        merged_filename = f"merged_{session_id}_{int(datetime.now().timestamp())}.wav"
        merged_path = os.path.join(tmpdirname, merged_filename)

        ffmpeg_start = time.time()
        merged_audio.export(merged_path, format="wav")

        # FREE MEMORY IMMEDIATELY: Delete the uncompressed audio from RAM
        final_duration_seconds = merged_audio.duration_seconds
        del merged_audio
        try:
            del segment
        except NameError:
            pass
        import gc
        gc.collect()

        # ── Noise Reduction via FFmpeg afftdn filter ───────────────────────
        denoised_path = os.path.join(tmpdirname, f"denoised_{merged_filename}")
        try:
            import subprocess
            ffmpeg_denoise_cmd = [
                "ffmpeg", "-y",
                "-i", merged_path,
                "-af", "afftdn=nf=-25",   # nf=-25 = noise floor in dBFS; tune between -20 and -40
                "-ar", "16000",           # Keep 16kHz for Azure
                "-ac", "1",               # Keep mono
                denoised_path
            ]
            result = subprocess.run(ffmpeg_denoise_cmd, capture_output=True, text=True, timeout=120)
            if result.returncode == 0 and os.path.exists(denoised_path):
                merged_path = denoised_path  # Use denoised file for all downstream steps
                print(f"[Pipeline] ✅ Noise reduction applied (afftdn). Denoised file: {denoised_path}")
            else:
                print(f"[Pipeline] ⚠️ afftdn failed, using original merged audio. Error: {result.stderr[-300:]}")
        except Exception as e:
            print(f"[Pipeline] ⚠️ Noise reduction step skipped: {e}")
        # ── End Noise Reduction ────────────────────────────────────────────

        wav_size_mb = os.path.getsize(merged_path) / (1024 * 1024)

        # ── Compress to MP3 ────────────────────────────────────────────────
        compressed_path = merged_path.replace(".wav", ".mp3")
        try:
            ffmpeg_compress_cmd = [
                "ffmpeg", "-y",
                "-i", merged_path,
                "-ar", "16000",
                "-ac", "1",
                "-b:a", "64k",
                compressed_path
            ]
            comp_result = subprocess.run(ffmpeg_compress_cmd, capture_output=True, text=True, timeout=120)
            if comp_result.returncode == 0 and os.path.exists(compressed_path):
                merged_path = compressed_path
                merged_filename = merged_filename.replace(".wav", ".mp3")
                mp3_size_mb = os.path.getsize(compressed_path) / (1024 * 1024)
                print(f"[Pipeline] 🗜️ Compressed {wav_size_mb:.2f}MB WAV → {mp3_size_mb:.2f}MB MP3")
            else:
                print(f"[Pipeline] ⚠️ MP3 compression failed, using WAV. Error: {comp_result.stderr[-300:]}")
        except Exception as e:
            print(f"[Pipeline] ⚠️ MP3 compression skipped: {e}")

        file_size_bytes = os.path.getsize(merged_path)

        print(f"[Pipeline] ✅ Chunks merged successfully. Uploading merged file: {merged_filename}")

        # Upload merged file
        with open(merged_path, "rb") as data:
            content_type = "audio/mpeg" if merged_filename.endswith(".mp3") else "audio/wav"
            container_client.upload_blob(
                name=merged_filename,
                data=data,
                overwrite=True,
                content_settings=ContentSettings(content_type=content_type)
            )

        blob_url = f"https://{blob_service_client.account_name}.blob.core.windows.net/{CONTAINER_NAME}/{merged_filename}"

        # ── UPLOAD MERGED AUDIO TO SHAREPOINT ─────────────────────────────
        try:
            graph_token = get_graph_access_token()
            folder_id = ensure_sharepoint_folder(title, graph_token)
            safe_title = re.sub(r'[^a-zA-Z0-9 _-]', '', title).strip() or 'recording'
            sp_audio_filename = f"{safe_title}_{session_id[:8]}{os.path.splitext(merged_filename)[1]}"

            sp_start = time.time()

            # Retry logic for transient SharePoint serviceReadOnly errors
            sp_max_retries = 3
            sp_retry_delay = 15  # seconds between retries
            audio_file_id = None
            for sp_attempt in range(1, sp_max_retries + 1):
                try:
                    print(f"[SharePoint] Uploading merged audio to SharePoint (attempt {sp_attempt}/{sp_max_retries})...")
                    audio_file_id = upload_large_file_to_sharepoint(folder_id, merged_path, sp_audio_filename, graph_token)
                    print(f"[SharePoint] ✅ Audio uploaded successfully on attempt {sp_attempt}.")
                    break  # Success — exit retry loop
                except Exception as sp_err:
                    err_str = str(sp_err)
                    is_readonly = "serviceReadOnly" in err_str or "Read Only" in err_str
                    if is_readonly and sp_attempt < sp_max_retries:
                        print(f"[SharePoint] ⚠️ SharePoint is read-only (Microsoft maintenance). Retrying in {sp_retry_delay}s... (attempt {sp_attempt}/{sp_max_retries})")
                        time.sleep(sp_retry_delay)
                        sp_retry_delay *= 2  # Exponential backoff: 15s → 30s → 60s
                    else:
                        raise  # Re-raise on final attempt or non-retryable error

        except Exception as e:
            print(f"[SharePoint] ❌ Failed to upload merged audio to SP after all retries: {e}")

    speech_headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/json"
    }

    # ── GENERATE READ SAS TOKEN FOR AZURE SPEECH ──────────────────────────────
    try:
        read_sas_token = generate_blob_sas(
            account_name=blob_service_client.account_name,
            container_name=CONTAINER_NAME,
            blob_name=merged_filename,
            account_key=blob_service_client.credential.account_key,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.now(timezone.utc) + timedelta(hours=4)
        )

        blob_sas_url = f"{blob_url}?{read_sas_token}"

    except Exception as e:
        print(f"[Pipeline] ❌ Failed to generate Read SAS token: {e}")
        set_db_status(session_id, "failed")
        return

    # ── STEP 1: Start Azure Batch Transcription ───────────────────────────────
    azure_speech_start = time.time()
    # We now always use the Microsoft Base Model which naturally captures Tanglish
    # perfectly and outputs native Tamil script.

    payload = {
        "contentUrls": [blob_sas_url],
        "locale": "en-IN",
        "displayName": title,
        "properties": {
            "diarizationEnabled": True,
            "languageIdentification": {"candidateLocales": ["en-IN", "ta-IN"]},
            "wordLevelTimestampsEnabled": False,
            "punctuationMode": "DictatedAndAutomatic",
            "profanityFilterMode": "Masked",
            "diarization": {
                "speakers": {"minCount": 1, "maxCount": 10}
            }
        }
    }

    start_res = requests.post(TRANSCRIBE_URL, headers=speech_headers, json=payload)
    if start_res.status_code != 201:
        print(f"[Pipeline] ❌ Failed to start transcription: {start_res.text}")
        set_db_status(session_id, "failed")
        return

    self_url = start_res.json().get("self")
    if not self_url:
        print("[Pipeline] ❌ Failed to get self_url from transcription start.")
        set_db_status(session_id, "failed")
        return

    job_id = self_url.split("/")[-1]

    save_pending_transcription(job_id, {
        "session_id": session_id,
        "title": title,
        "owner_email": owner_email,
        "device_os": device_os,
        "merged_filename": merged_filename,
        "recording_names": recording_names,
        "folder_id": folder_id,
        "audio_file_id": audio_file_id if 'audio_file_id' in locals() else None,
        "latitude": latitude,
        "longitude": longitude,
        "final_duration_seconds": final_duration_seconds
    })

    print(f"[Pipeline] ⏳ Transcription job started (File: {merged_filename}). Webhook will resume pipeline.")
    return


def resume_pipeline_after_transcription(job_id: str, files_url: str, metadata: dict):
    """Resumes the transcription pipeline after Azure Webhook fires."""
    try:
        _resume_pipeline_after_transcription(job_id, files_url, metadata)
    except Exception as e:
        print(f"[Pipeline] ❌ Fatal error in resume_pipeline_after_transcription: {e}")
        import traceback
        traceback.print_exc()
        if "session_id" in metadata:
            set_db_status(metadata["session_id"], "failed")

def _resume_pipeline_after_transcription(job_id: str, files_url: str, metadata: dict):
    session_id = metadata["session_id"]
    title = metadata["title"]
    owner_email = metadata["owner_email"]
    merged_filename = metadata["merged_filename"]
    recording_names = metadata["recording_names"]
    folder_id = metadata["folder_id"]
    audio_file_id = metadata["audio_file_id"]
    latitude = metadata["latitude"]
    longitude = metadata["longitude"]
    final_duration_seconds = metadata["final_duration_seconds"]

    print(f"\n{'='*60}")
    print(f"[Pipeline Resume] Resuming processing for: {title} (Session: {session_id})")
    print(f"{'='*60}\n")

    speech_headers = {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/json"
    }

    # ── STEP 3: Download the Transcript ───────────────────────────────────────
    try:
        files_res = requests.get(files_url, headers=speech_headers).json()
        content_url = next(
            (item["links"]["contentUrl"] for item in files_res.get("values", []) if item["kind"] == "Transcription"),
            None
        )

        if not content_url:
            print("[Pipeline] ❌ Could not find transcription content URL.")
            set_db_status(session_id, "failed")
            return

        transcript_data = requests.get(content_url).json()
    except Exception as e:
        print(f"[Pipeline] ❌ Failed to download transcript from Azure: {e}")
        set_db_status(session_id, "failed")
        return

    # The transcript is safely in hand now, so the job itself has no further
    # purpose on Azure — delete it here (not at the end of the pipeline) so
    # cleanup still happens even if a later step (SharePoint archive, DB
    # write) fails.
    delete_transcription_job(job_id)

    # ── STEP 4: Format with Speaker Diarization ──────────────────────────────
    phrases = transcript_data.get("recognizedPhrases", [])
    formatted_transcript = ""
    current_speaker = -1
    segments_list = []

    for phrase in phrases:
        speaker_id = phrase.get("speaker", 0)
        text = phrase.get("nBest", [{}])[0].get("display", "")
        confidence = phrase.get("nBest", [{}])[0].get("confidence", 0.0)
        start_time = phrase.get("offset", "")
        end_time = phrase.get("duration", "")

        if not text: continue

        segments_list.append({
            "speaker": f"Speaker {speaker_id or 1}",
            "start_time": start_time,
            "end_time": end_time,
            "text": text,
            "confidence": confidence
        })

        if speaker_id != current_speaker:
            if formatted_transcript: formatted_transcript += "\n\n"
            formatted_transcript += f"Speaker {speaker_id or 1}:\n"
            current_speaker = speaker_id
        else:
            formatted_transcript += " "

        formatted_transcript += text

    if not formatted_transcript.strip():
        print("[Pipeline] ⚠️ Transcription returned empty text.")
        formatted_transcript = "No speech detected or empty transcript."

    print(f"[Pipeline] ✅ Transcription complete ({len(phrases)} phrases, {len(formatted_transcript)} chars)")

    translation_cost = 0.0
    # ── STEP 4b (conditional): Tanglish → English translation ───────────────────────
    has_tamil = bool(re.search(r'[஀-௿]', formatted_transcript))
    if has_tamil:
        print("[Pipeline] 🌐 Tamil characters detected — translating to English...")
        llm_start = time.time()
        formatted_transcript, usage = translate_tanglish_to_english(formatted_transcript)

        # Estimate cost: gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output)
        input_cost = (usage.get("prompt_tokens", 0) / 1_000_000) * 0.15
        output_cost = (usage.get("completion_tokens", 0) / 1_000_000) * 0.60
        translation_cost = input_cost + output_cost

    # Extract speaker count
    unique_speakers = len(set(phrase.get("speaker", 0) for phrase in phrases))

    # ── STEP 4c: Generate Summary ──────────────────────────────────────────
    summary_text = None
    summary_status = "pending"
    try:
        summary_threshold = int(os.getenv("SUMMARY_WORD_COUNT_THRESHOLD", "75"))
        filtered_word_count = get_filtered_word_count(segments_list)

        if filtered_word_count < summary_threshold:
            print(f"[Pipeline] ⏭️ Transcript word count ({filtered_word_count}) below threshold ({summary_threshold}). Skipping summary.")
            summary_status = "skipped"
        else:
            print(f"[Pipeline] 📝 Generating summary via Azure OpenAI (filtered word count: {filtered_word_count})...")
            client = AzureOpenAI(
                azure_endpoint=AZURE_OPENAI_ENDPOINT,
                api_key=AZURE_OPENAI_KEY,
                api_version="2024-02-01"
            )
            summary_response = client.chat.completions.create(
                model=AZURE_OPENAI_DEPLOYMENT,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Summarize this meeting transcript in exactly 2-3 short bullet points, "
                            "capturing only the key topics or decisions discussed. Do not add "
                            "commentary, greetings, or anything outside the bullet points."
                        )
                    },
                    {
                        "role": "user",
                        "content": formatted_transcript
                    }
                ],
                temperature=0.3,
            )
            summary_text = summary_response.choices[0].message.content.strip()
            summary_status = "success"
            print(f"[Pipeline] ✅ Summary generated successfully.")
    except Exception as e:
        print(f"[Pipeline] ⚠️ Summary generation failed (non-fatal): {e}")
        summary_status = "failed"

    # ── STEP 5: Upload Transcript to SharePoint (Archive) and Save to Database ─────────────────────
    pipeline_failed = False
    try:
        graph_token = get_graph_access_token()
        folder_id = ensure_sharepoint_folder(title, graph_token)

        # ── Archive to SharePoint ──
        transcript_file_id = None
        try:
            safe_title = re.sub(r'[^a-zA-Z0-9 _-]', '', title).strip() or 'recording'
            transcript_filename = f"{safe_title}_{session_id[:8]}_diarized_transcript.txt"
            transcript_file_id = upload_transcript_to_sharepoint(folder_id, formatted_transcript, transcript_filename, graph_token)
            print(f"[Pipeline] ✅ Diarized transcript archived to SharePoint: {transcript_filename}")
        except Exception as sp_err:
            print(f"[Pipeline] ⚠️ Failed to archive transcript to SharePoint (non-fatal): {sp_err}")

        # ── Reverse Geocoding ──
        readable_address = "Unknown Location"
        if latitude is not None and longitude is not None:
            import random
            location_str = f"{latitude}, {longitude}"
            for geo_attempt in range(3):
                try:
                    location_data = geolocator.reverse(location_str, language='en')
                    readable_address = location_data.address if location_data else "Unknown Location"
                    break
                except Exception as e:
                    print(f"[Pipeline] ⚠️ Geocoding failed (attempt {geo_attempt+1}/3): {e}")
                    readable_address = "Geocoding Error"
                    if geo_attempt < 2:
                        time.sleep(1 + random.uniform(0, 1)) # Jitter 1-2s to avoid rate limits

        if db_pool:
            conn = None
            try:
                duration_val = int(final_duration_seconds) if 'final_duration_seconds' in locals() else 0
                formatted_dur = format_duration(duration_val)
                audio_id = audio_file_id if 'audio_file_id' in locals() else None

                conn = db_pool.getconn()
                cur = conn.cursor()
                update_query = """
                    UPDATE call_recording
                    SET recording_name = %s,
                        transcript_file_id = %s,
                        audio_file_id = %s,
                        folder_id = %s,
                        owner_id = %s,
                        duration = %s,
                        location = %s,
                        transcript_segments = %s,
                        transcript_text = %s,
                        translation_cost = %s,
                        summary = %s,
                        summary_status = %s
                    WHERE session_id = %s
                """
                cur.execute(update_query, (
                    title,
                    transcript_file_id,
                    audio_id,
                    folder_id,
                    owner_email,
                    formatted_dur,
                    readable_address,
                    json.dumps(segments_list),
                    formatted_transcript,
                    translation_cost,
                    summary_text,
                    summary_status,
                    session_id
                ))

                if cur.rowcount == 0:
                    insert_query = """
                        INSERT INTO call_recording
                        (session_id, recording_name, transcript_file_id, audio_file_id, folder_id, owner_id, duration, location, transcript_segments, transcript_text, translation_cost, summary, summary_status)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """
                    cur.execute(insert_query, (
                        session_id,
                        title,
                        transcript_file_id,
                        audio_id,
                        folder_id,
                        owner_email,
                        formatted_dur,
                        readable_address,
                        json.dumps(segments_list),
                        formatted_transcript,
                        translation_cost,
                        summary_text,
                        summary_status
                    ))

                conn.commit()
                cur.close()
                print(f"[Pipeline] ✅ DB Update successful for session: {session_id}")
            except Exception as db_e:
                print(f"[Pipeline] ❌ Error updating DB natively: {db_e}")
                pipeline_failed = True
            finally:
                if conn:
                    db_pool.putconn(conn)

    except Exception as e:
        print(f"[Pipeline] ❌ SharePoint upload or DB notification failed: {e}")
        pipeline_failed = True

    # ── STEP 6: Delete blobs from Azure Storage (cost savings) ────────────────
    try:
        delete_blob(merged_filename)
        for chunk_name in recording_names:
            delete_blob(chunk_name)
        print(f"[Pipeline] 🗑️ Deleted merged audio and chunks from Azure Blob Storage.")
    except Exception as e:
        print(f"[Pipeline] ⚠️ Blob cleanup failed (non-fatal): {e}")

    if pipeline_failed:
        print(f"\n[Pipeline] ❌ Pipeline FAILED for: {title}\n")
        set_db_status(session_id, "failed")
    else:
        print(f"\n[Pipeline] 🎉 Pipeline complete for: {title}\n")
        set_db_status(session_id, "success")


# ═══════════════════════════════════════════════════════════════════════════════
#  WEBHOOK SETUP & RECEIVER
# ═══════════════════════════════════════════════════════════════════════════════

def ensure_webhook_registered():
    """Called from app/main.py's lifespan startup (this module has no
    FastAPI() app of its own to hang an @app.on_event off of anymore)."""
    webhook_secret = os.getenv("WEBHOOK_SECRET")
    public_url = os.getenv("EXPO_PUBLIC_BACKEND_URL")
    region = os.getenv("AZURE_SPEECH_REGION")
    speech_key = os.getenv("AZURE_SPEECH_KEY")

    if not webhook_secret or not public_url:
        print("⚠️ WEBHOOK_SECRET or EXPO_PUBLIC_BACKEND_URL not set. Azure Speech Webhook will not be registered.")
        return

    webhook_secret = webhook_secret.strip()

    endpoint = f"https://{region}.api.cognitive.microsoft.com/speechtotext/v3.2/webhooks"
    headers = {
        "Ocp-Apim-Subscription-Key": speech_key,
        "Content-Type": "application/json"
    }

    try:
        # Check if already registered
        res = requests.get(endpoint, headers=headers)
        if res.status_code == 200:
            webhooks = res.json().get("values", [])
            target_url = f"{public_url.rstrip('/')}/webhook/transcription-complete"
            for wh in webhooks:
                if wh.get("webUrl") == target_url:
                    if wh.get("status") == "Failed":
                        webhook_id = wh.get("self", "").rstrip("/").split("/")[-1]
                        print(f"⚠️ Found existing Failed webhook ({webhook_id}). Deleting it to retry...")
                        if webhook_id:
                            delete_res = requests.delete(f"{endpoint}/{webhook_id}", headers=headers)
                            if delete_res.status_code not in (200, 202, 204, 404):
                                print(f"⚠️ Failed to delete stale webhook {webhook_id}: {delete_res.status_code} {delete_res.text}")
                    else:
                        webhook_id = wh.get("self", "").rstrip("/").split("/")[-1]
                        print(f"✅ Webhook already registered with Azure: {webhook_id}")
                        return

        # Register new webhook
        payload = {
            "displayName": "MeetingRecorderTranscriptionWebhook",
            "properties": {
                "secret": webhook_secret
            },
            "webUrl": f"{public_url.rstrip('/')}/webhook/transcription-complete",
            "events": {
                "transcriptionCompletion": True
            }
        }
        create_res = requests.post(endpoint, headers=headers, json=payload)
        if create_res.status_code == 201:
            new_webhook_id = create_res.json().get("self", "").rstrip("/").split("/")[-1]
            print(f"✅ Successfully registered Azure Speech Webhook! (ID: {new_webhook_id})")
        else:
            print(f"⚠️ Failed to register webhook: {create_res.status_code} {create_res.text}")
    except Exception as e:
        print(f"⚠️ Error during webhook registration: {e}")

@router.post("/webhook/transcription-complete")
async def transcription_webhook(request: Request, background_tasks: BackgroundTasks):
    # Azure Webhook Creation Challenge Handshake
    validation_token = request.query_params.get("validationToken")
    if validation_token:
        print(f"🔔 Received Azure Webhook Challenge! Answering with token.")
        return Response(
            content=validation_token,
            media_type="text/plain",
            status_code=200
        )

    raw_body = await request.body()

    # Fallback Ping Check
    if raw_body == b'':
        print("🔔 Received Azure Webhook Ping (Empty Body)! Answering 200 OK.")
        return Response(status_code=200)

    webhook_secret = os.getenv("WEBHOOK_SECRET")

    # 1. Verify Signature
    if webhook_secret:
        webhook_secret = webhook_secret.strip()
        signature = request.headers.get("X-MicrosoftSpeechServices-Signature", "")
        expected_sig = base64.b64encode(hmac.new(webhook_secret.encode('utf-8'), raw_body, hashlib.sha256).digest()).decode('utf-8')

        if not hmac.compare_digest(signature, expected_sig):
            print(f"❌ Webhook Invalid Signature")
            raise HTTPException(status_code=401, detail="Invalid signature")

    # 2. Parse Payload
    payload = await request.json()

    self_url = payload.get("self", "")
    status = payload.get("status", "")

    # Check if Azure webhook payload structure is different (it might be in a wrapper)
    if not self_url and not status and "transcription" in payload:
        transcription_obj = payload.get("transcription", {})
        self_url = transcription_obj.get("self", "")
        status = transcription_obj.get("status", "")

    if not self_url:
        print("⚠️ Could not find self_url in webhook payload.")
        return Response(status_code=200)

    job_id = self_url.split("/")[-1]

    job_metadata = load_pending_transcription(job_id)
    if job_metadata is None:
        print(f"⚠️ Webhook received for unknown job_id: {job_id}")
        return Response(status_code=200)

    # If the webhook payload is missing the status, fetch it directly from the self_url
    if not status:
        speech_key = os.getenv("AZURE_SPEECH_KEY")
        if not speech_key:
            print("❌ AZURE_SPEECH_KEY is missing/empty when trying to enrich webhook status!")
        else:
            headers = {"Ocp-Apim-Subscription-Key": speech_key}
            try:
                resp = requests.get(self_url, headers=headers)
                if resp.status_code == 200:
                    transcription_data = resp.json()
                    status = transcription_data.get("status", "")
                    if "links" in transcription_data:
                        payload["links"] = transcription_data["links"]
                else:
                    print(f"⚠️ Failed to fetch transcription status: {resp.status_code} {resp.text}")
            except Exception as e:
                print(f"⚠️ Error fetching transcription status: {e}")

    print(f"🔔 Webhook received for job {job_id}. Status: {status}")

    if status == "Succeeded":
        files_url = payload.get("links", {}).get("files")
        if not files_url and "transcription" in payload:
            files_url = payload["transcription"].get("links", {}).get("files")
        if not files_url:
            files_url = f"{self_url}/files"
        background_tasks.add_task(resume_pipeline_after_transcription, job_id, files_url, job_metadata)
        delete_pending_transcription(job_id)
    elif status == "Failed":
        session_id = job_metadata["session_id"]
        set_db_status(session_id, "failed")
        print(f"❌ Transcription job {job_id} failed on Azure.")
        delete_pending_transcription(job_id)

    return Response(status_code=200)


# ═══════════════════════════════════════════════════════════════════════════════
#  API ENDPOINT — TRIGGERED BY THE APP AFTER BLOB UPLOAD
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/start-processing")
def start_processing(request: ProcessingRequest, background_tasks: BackgroundTasks):
    """Endpoint called by the app after a successful Blob upload of all chunks."""

    # Upsert full available metadata into DB immediately — don't wait for pipeline to finish
    if db_pool:
        conn = None
        try:
            conn = db_pool.getconn()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO call_recording (session_id, processing_status, recording_name, owner_id, ui_folder_id, created_at, duration)
                VALUES (%s, %s, %s, %s, %s, NOW(), %s)
                ON CONFLICT (session_id) DO UPDATE
                    SET processing_status = EXCLUDED.processing_status,
                        recording_name = COALESCE(EXCLUDED.recording_name, call_recording.recording_name),
                        owner_id = COALESCE(EXCLUDED.owner_id, call_recording.owner_id),
                        ui_folder_id = COALESCE(EXCLUDED.ui_folder_id, call_recording.ui_folder_id),
                        duration = COALESCE(EXCLUDED.duration, call_recording.duration)
            """, (
                request.session_id,
                "processing",
                request.title or "Untitled Recording",
                request.owner_email or None,
                request.ui_folder_id or None,
                f"{request.duration // 60}:{str(request.duration % 60).zfill(2)}" if request.duration else "0:00"
            ))
            conn.commit()
            cur.close()
            print(f"[DB] ✅ Initial row written for session {request.session_id} (title='{request.title}')")
        except Exception as e:
            print(f"[DB] ⚠️ Failed to write initial row: {e}")
        finally:
            if conn:
                db_pool.putconn(conn)

    background_tasks.add_task(
        submit_transcription_job,
        request.recording_names,
        request.title,
        request.session_id,
        request.translate_tanglish,
        request.owner_email,
        request.device_os,
        request.client_upload_time_ms,
        request.latitude,
        request.longitude,
        request.ui_folder_id
    )

    # Immediately return success to the app so it can close
    return {"message": "Transcription started in the background.", "title": request.title, "session_id": request.session_id}

@router.get("/status")
def get_status(req: StatusRequest = Depends()):
    session_id = req.session_id
    """Returns the current status + transcript data of the pipeline for a given session ID."""
    if not db_pool:
        return {"processing_status": "unknown"}
    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("""
            SELECT processing_status, transcript_text, duration, recording_name, audio_file_id, transcript_segments, summary, summary_status, transcript_file_id
            FROM call_recording WHERE session_id = %s
        """, (session_id,))
        row = cur.fetchone()
        cur.close()
        if row:
            segments = row[5]
            if isinstance(segments, str):
                try:
                    segments = json.loads(segments)
                except Exception:
                    segments = []

            return {
                "processing_status": row[0] or "unknown",
                "transcript_text": row[1],
                "duration": row[2],
                "recording_name": row[3],
                "audio_file_id": row[4],
                "transcript_segments": segments,
                "summary": row[6],
                "summary_status": row[7],
                "transcript_file_id": row[8],
            }
    except Exception as e:
        print(f"[DB Status] ⚠️ Failed to get status: {e}")
    finally:
        if conn:
            db_pool.putconn(conn)
    return {"processing_status": "unknown"}

class SharePointLinkRequest(BaseModel):
    file_id: str

@router.get("/get-sharepoint-link")
def get_sharepoint_link(req: SharePointLinkRequest = Depends()):
    """Resolves a Graph driveItem id (audio_file_id/transcript_file_id, as
    stored on call_recording) to an openable SharePoint webUrl. The DB only
    ever stores the id — the id alone isn't a URL a client can open, and
    Graph app-only credentials live only on this backend, not on the
    mobile app — so this proxies one short-lived lookup instead of exposing
    those credentials to the client."""
    try:
        graph_token = get_graph_access_token()
        headers = {"Authorization": f"Bearer {graph_token}"}
        resp = requests.get(f"{GRAPH_BASE_URL}/items/{req.file_id}", headers=headers)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Graph lookup failed: {resp.text}")
        web_url = resp.json().get("webUrl")
        if not web_url:
            raise HTTPException(status_code=404, detail="File has no webUrl")
        return {"webUrl": web_url}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[SharePoint] ❌ Failed to resolve link for {req.file_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.api_route("/ping", methods=["GET", "HEAD"])
async def ping_endpoint(response: Response):
    return {"status": "healthy"}

# ═══════════════════════════════════════════════════════════════════════════════
#  FOLDER & RECORDING SYNC APIs (For Mobile UI Folders)
# ═══════════════════════════════════════════════════════════════════════════════

class FolderItem(BaseModel):
    id: str
    name: str
    created_at: Optional[int] = None

class SyncFoldersRequest(BaseModel):
    owner_id: str
    folders: List[FolderItem]

class UpdateRecordingFolderRequest(BaseModel):
    session_id: str
    ui_folder_id: Optional[str] = None

@router.get("/get-recording-data")
def get_recording_data(owner_id: str, search_query: str = None):
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database not configured")
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()

        if search_query and search_query.strip():
            cur.execute("""
                SELECT session_id, recording_name, transcript_file_id, audio_file_id, folder_id, duration, location, created_at, ui_folder_id, transcript_text, processing_status, transcript_segments, summary, summary_status,
                ts_rank(search_vector, plainto_tsquery('english', %s)) AS rank,
                ts_headline('english', coalesce(transcript_text, ''), plainto_tsquery('english', %s), 'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=20, MinWords=7') AS matched_snippet
                FROM call_recording
                WHERE owner_id = %s AND search_vector @@ plainto_tsquery('english', %s)
                ORDER BY rank DESC
            """, (search_query, search_query, owner_id, search_query))
        else:
            cur.execute("""
                SELECT session_id, recording_name, transcript_file_id, audio_file_id, folder_id, duration, location, created_at, ui_folder_id, transcript_text, processing_status, transcript_segments, summary, summary_status,
                0 AS rank,
                NULL AS matched_snippet
                FROM call_recording
                WHERE owner_id = %s
            """, (owner_id,))

        rows = cur.fetchall()
        db_pool.putconn(conn)

        result = []
        for r in rows:
            result.append({
                "id": r[0],
                "recording_name": r[1],
                "transcript_file_id": r[2],
                "audio_file_id": r[3],
                "folder_id": r[4],
                "duration": r[5],
                "location": r[6],
                "created_at": r[7].timestamp() * 1000 if r[7] else None,
                "ui_folder_id": r[8],
                "owner_id": owner_id,
                "transcript_text": r[9],
                "processing_status": r[10],
                "transcript_segments": json.loads(r[11]) if isinstance(r[11], str) else (r[11] or []),
                "summary": r[12],
                "summary_status": r[13],
                "matched_snippet": r[15] if len(r) > 15 else None
            })
        return {"recording_data": result}
    except Exception as e:
        if 'conn' in locals() and conn:
            db_pool.putconn(conn)
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/delete-recording")
def delete_recording_api(record_id: str):
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database not configured")
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("DELETE FROM call_recording WHERE session_id = %s", (record_id,))
        conn.commit()
        db_pool.putconn(conn)
        return {"status": "success", "message": "Recording deleted"}
    except Exception as e:
        if 'conn' in locals() and conn:
            conn.rollback()
            db_pool.putconn(conn)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-folders")
def sync_folders(req: SyncFoldersRequest):
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database not configured")
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        # We perform an upsert (INSERT ... ON CONFLICT DO UPDATE)
        active_ids = []
        for folder in req.folders:
            active_ids.append(folder.id)
            cur.execute("""
                INSERT INTO app_folders (id, name, owner_id, created_at)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET name = EXCLUDED.name
            """, (folder.id, folder.name, req.owner_id, folder.created_at))

        # Delete folders that are not in the list anymore
        if active_ids:
            format_strings = ','.join(['%s'] * len(active_ids))
            cur.execute(f"DELETE FROM app_folders WHERE owner_id = %s AND id NOT IN ({format_strings})", [req.owner_id] + active_ids)
        else:
            cur.execute("DELETE FROM app_folders WHERE owner_id = %s", (req.owner_id,))

        conn.commit()
        db_pool.putconn(conn)
        return {"status": "success"}
    except Exception as e:
        if 'conn' in locals() and conn:
            conn.rollback()
            db_pool.putconn(conn)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/get-folders")
def get_folders(owner_id: str):
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database not configured")
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("SELECT id, name, created_at FROM app_folders WHERE owner_id = %s", (owner_id,))
        rows = cur.fetchall()
        db_pool.putconn(conn)

        result = []
        for r in rows:
            result.append({
                "id": r[0],
                "name": r[1],
                "created_at": r[2]
            })
        return result
    except Exception as e:
        if 'conn' in locals() and conn:
            db_pool.putconn(conn)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/update-recording-folder")
def update_recording_folder(req: UpdateRecordingFolderRequest):
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database not configured")
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        cur.execute("UPDATE call_recording SET ui_folder_id = %s WHERE session_id = %s", (req.ui_folder_id, req.session_id))
        conn.commit()
        db_pool.putconn(conn)
        return {"status": "success"}
    except Exception as e:
        if 'conn' in locals() and conn:
            conn.rollback()
            db_pool.putconn(conn)
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
#  AGENT / RAG PROXY — forwards to a separate chat/RAG service
# ═══════════════════════════════════════════════════════════════════════════════

@router.api_route('/{agent_id}/agent/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
async def proxy_agent_with_id(request: Request, agent_id: str, path: str):
    agent_base_url = os.getenv("AGENT_SERVER_URL", "http://127.0.0.1:8001")
    url = f'{agent_base_url}/{agent_id}/agent/{path}'
    if request.url.query:
        url += f'?{request.url.query}'

    headers = {k: v for k, v in request.headers.items() if k.lower() not in ('host', 'content-length')}
    body = await request.body()

    try:
        resp = requests.request(
            method=request.method,
            url=url,
            headers=headers,
            data=body,
            timeout=120
        )
        return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
    except Exception as e:
        print(f"Proxy Error: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway")

@router.api_route('/agent/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
async def proxy_agent(request: Request, path: str):
    agent_base_url = os.getenv("AGENT_SERVER_URL", "http://127.0.0.1:8001")
    url = f'{agent_base_url}/agent/{path}'
    if request.url.query:
        url += f'?{request.url.query}'

    headers = {k: v for k, v in request.headers.items() if k.lower() not in ('host', 'content-length')}
    body = await request.body()

    try:
        resp = requests.request(
            method=request.method,
            url=url,
            headers=headers,
            data=body,
            timeout=120
        )
        return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
    except Exception as e:
        print(f"Proxy Error: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway")

@router.api_route('/get-rag-chat-messages', methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
async def proxy_rag(request: Request):
    agent_base_url = os.getenv("AGENT_SERVER_URL", "http://127.0.0.1:8001")
    url = f'{agent_base_url}/get-rag-chat-messages'
    if request.url.query:
        url += f'?{request.url.query}'

    headers = {k: v for k, v in request.headers.items() if k.lower() not in ('host', 'content-length')}
    body = await request.body()

    try:
        resp = requests.request(
            method=request.method,
            url=url,
            headers=headers,
            data=body,
            timeout=120
        )
        return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
    except Exception as e:
        print(f"Proxy Error: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway")
