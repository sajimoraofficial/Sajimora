#!/usr/bin/env node
/**
 * Sajimora Native Binary Runner (Zero-Dependency)
 * Launches native Rust binaries (sajimora, sajimora-mcp) from npm/npx.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');

const PKG = require('../package.json');
const VERSION = PKG.version;
const REPO = 'sajimoraofficial/sajimora';

const TARGET_MAP = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', ext: 'tar.gz', suffix: '' },
  'darwin-x64': { target: 'x86_64-apple-darwin', ext: 'tar.gz', suffix: '' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', ext: 'tar.gz', suffix: '' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', ext: 'zip', suffix: '.exe' },
};

function getPlatformKey() {
  return `${os.platform()}-${os.arch()}`;
}

function getCacheDir() {
  const home = os.homedir();
  return path.join(home, '.sajimora', 'bin', `v${VERSION}`);
}

function resolveBinary(binaryName) {
  const platKey = getPlatformKey();
  const spec = TARGET_MAP[platKey];
  if (!spec) {
    console.error(`[sajimora] Unsupported platform/architecture: ${platKey}`);
    console.error(`[sajimora] Supported: ${Object.keys(TARGET_MAP).join(', ')}`);
    process.exit(1);
  }

  const binaryFilename = `${binaryName}${spec.suffix}`;

  // 1. Check local Rust build (for development in repo, prefer newer of release/debug)
  const localRelease = path.resolve(__dirname, '..', 'rust', 'target', 'release', binaryFilename);
  const localDebug = path.resolve(__dirname, '..', 'rust', 'target', 'debug', binaryFilename);
  const hasRelease = fs.existsSync(localRelease);
  const hasDebug = fs.existsSync(localDebug);
  if (hasRelease && hasDebug) {
    return fs.statSync(localRelease).mtimeMs >= fs.statSync(localDebug).mtimeMs ? localRelease : localDebug;
  }
  if (hasRelease) return localRelease;
  if (hasDebug) return localDebug;

  // 2. Check cached binary in ~/.sajimora/bin/vX.Y.Z/
  const cachedDir = getCacheDir();
  const cachedPath = path.join(cachedDir, binaryFilename);
  if (fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  // 3. Auto-download from GitHub Release
  ensureBinaryDownloaded(binaryName, spec, cachedDir);
  if (fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  console.error(`[sajimora] Failed to locate or download ${binaryFilename}.`);
  console.error(`[sajimora] Please install manually from https://github.com/${REPO}/releases/tag/v${VERSION}`);
  process.exit(1);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect (GitHub Release -> S3)
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function ensureBinaryDownloaded(binaryName, spec, cachedDir) {
  const archiveName = `sajimora-v${VERSION}-${spec.target}.${spec.ext}`;
  const releaseUrl = `https://github.com/${REPO}/releases/download/v${VERSION}/${archiveName}`;

  fs.mkdirSync(cachedDir, { recursive: true });
  const archivePath = path.join(cachedDir, archiveName);

  console.error(`[sajimora] Downloading native ${binaryName} binary v${VERSION} for ${spec.target}...`);

  try {
    // Synchronous download via curl/tar or node
    const isWindows = os.platform() === 'win32';
    if (!isWindows) {
      // Use curl + tar for instant extraction on Unix
      const cmd = `curl -fsSL "${releaseUrl}" | tar -xz -C "${cachedDir}"`;
      const res = spawnSync('sh', ['-c', cmd], { stdio: ['inherit', 2, 2] });
      if (res.status !== 0) {
        throw new Error(`Extraction failed with exit code ${res.status}`);
      }
    } else {
      // Windows PowerShell extraction
      const psCmd = `
        $ProgressPreference = 'SilentlyContinue';
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;
        Invoke-WebRequest -Uri "${releaseUrl}" -OutFile "${archivePath}";
        Expand-Archive -Path "${archivePath}" -DestinationPath "${cachedDir}" -Force;
        Remove-Item "${archivePath}";
      `;
      const res = spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: ['inherit', 2, 2] });
      if (res.status !== 0) {
        throw new Error(`Windows download/extraction failed with exit code ${res.status}`);
      }
    }

    // Ensure permissions
    const extractedBin = path.join(cachedDir, `${binaryName}${spec.suffix}`);
    if (fs.existsSync(extractedBin) && !isWindows) {
      fs.chmodSync(extractedBin, 0o755);
    }
  } catch (err) {
    console.error(`[sajimora] Error downloading release binary: ${err.message}`);
  }
}

function run(binaryName) {
  const binaryPath = resolveBinary(binaryName);
  const args = process.argv.slice(2);
  const result = spawnSync(binaryPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

module.exports = { run, resolveBinary };
