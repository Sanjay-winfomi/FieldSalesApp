#!/bin/bash
set -e

cd "$(dirname "$0")"

export PYTHONUNBUFFERED=1
export PYTHONIOENCODING=utf-8
export PATH="$(pwd)/bin:$PATH"

echo "[INFO] Installing Python dependencies..."
python3 -m pip install -r requirements.txt

echo "[DEBUG] Checking available tools:"
for tool in curl tar gzip xz unzip python3 pip3; do
  command -v "$tool" >/dev/null 2>&1 && echo "  ✅ $tool" || echo "  ❌ $tool missing"
done

# Download FFmpeg in the background so it doesn't block Uvicorn startup and cause health check timeouts!
(
  echo "[INFO] Setting up FFmpeg in background..."
  if [ ! -f "./bin/ffmpeg" ]; then
      mkdir -p ./bin
      curl -sSL -o ffmpeg.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
      python3 -c "
import tarfile
with tarfile.open('ffmpeg.tar.xz') as t:
    t.extractall('.')
"
      cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg ./bin/
      cp ffmpeg-master-latest-linux64-gpl/bin/ffprobe ./bin/
      chmod +x ./bin/ffmpeg ./bin/ffprobe
      rm -rf ffmpeg.tar.xz ffmpeg-master-latest-linux64-gpl
      echo "[INFO] FFmpeg setup complete."
  else
      echo "[INFO] FFmpeg already exists."
  fi
) &

echo "[INFO] Starting Uvicorn web server..."
# Render (and most PaaS hosts) assign the port dynamically via $PORT and
# require the app to bind to it — App Runner's apprunner.yaml instead fixed
# this at 8000 via its own `network.port` config, so default to 8000 only
# when $PORT isn't set (e.g. running this script directly on a dev machine).
exec python3 -m uvicorn main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1
