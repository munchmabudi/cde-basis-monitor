// analysis/cde_log_rotation.js
//
// The stats/calibration read path (loadLog) parses the ENTIRE log file into
// memory every time it's called. That's fine at a few MB, but at hundreds of
// MB the fully-parsed object graph is many times the raw file size — that's
// exactly what crashed the monitor with an out-of-memory error at ~929MB.
//
// This module keeps the ACTIVE log file bounded by moving anything older
// than a retention window into dated archive files. It's deliberately
// designed to never need the whole file in memory at once, even during the
// rotation itself:
//   - Checking WHETHER rotation is needed reads only the first line (a few
//     hundred bytes), not the whole file — cheap even at gigabytes.
//   - Actually performing a rotation streams line-by-line (readline) into
//     two output files as it goes, holding only the current line at a time.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Reads just enough of the file's start to get the first full line, growing
// the read size if a real log line (a full multi-token snapshot can run several
// KB) doesn't fit in one chunk. Capped so a corrupt file with no newlines for
// megabytes can't force a huge read.
const PEEK_MAX_BYTES = 1_048_576; // 1MB cap — any real poll line is a few KB

function peekFirstLineTimestamp(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    let chunkSize = 8192;
    let text = '';
    let newlineIdx = -1;
    while (chunkSize <= PEEK_MAX_BYTES) {
      const buf = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, bytesRead);
      newlineIdx = text.indexOf('\n');
      if (newlineIdx !== -1 || bytesRead < chunkSize) break; // found it, or hit EOF
      chunkSize *= 4;
    }
    const line = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim();
    if (!line) return null;
    const obj = JSON.parse(line);
    const tMs = Date.parse(obj.t);
    return isNaN(tMs) ? null : tMs;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function needsRotation(logPath, maxActiveDays) {
  if (!fs.existsSync(logPath)) return false;
  const oldestMs = peekFirstLineTimestamp(logPath);
  if (oldestMs == null) return false;
  const cutoffMs = Date.now() - maxActiveDays * 86_400_000;
  return oldestMs < cutoffMs;
}

async function rotateLog(logPath, maxActiveDays) {
  if (!fs.existsSync(logPath)) return { rotated: false, reason: 'no log file' };

  const cutoffMs = Date.now() - maxActiveDays * 86_400_000;
  const archiveDir = path.join(path.dirname(logPath), 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10);
  const archivePath = path.join(archiveDir, `${path.basename(logPath, '.jsonl')}_archived_${dateTag}.jsonl`);
  const tmpKeepPath = logPath + '.rotating.tmp';

  const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const keepStream = fs.createWriteStream(tmpKeepPath, { flags: 'w' });
  const archiveStream = fs.createWriteStream(archivePath, { flags: 'a' });

  let kept = 0, archived = 0, corrupt = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let tMs;
    try {
      tMs = Date.parse(JSON.parse(trimmed).t);
    } catch {
      corrupt++; continue;
    }
    if (isNaN(tMs)) { corrupt++; continue; }
    if (tMs < cutoffMs) {
      archiveStream.write(trimmed + '\n');
      archived++;
    } else {
      keepStream.write(trimmed + '\n');
      kept++;
    }
  }

  await new Promise((resolve, reject) => keepStream.end(err => err ? reject(err) : resolve()));
  await new Promise((resolve, reject) => archiveStream.end(err => err ? reject(err) : resolve()));

  fs.renameSync(tmpKeepPath, logPath);

  return { rotated: true, kept, archived, corrupt, archivePath };
}

async function rotateLogIfNeeded(logPath, maxActiveDays) {
  if (!needsRotation(logPath, maxActiveDays)) return { rotated: false };
  return rotateLog(logPath, maxActiveDays);
}

module.exports = { peekFirstLineTimestamp, needsRotation, rotateLog, rotateLogIfNeeded };
