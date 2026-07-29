import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silences Next's workspace-root inference — a sibling package-lock.json
  // one level up (C:\Users\Lenovo) would otherwise get picked as the root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
