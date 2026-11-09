// documents.js
//
// The knowledge documents Chipo answers from live in the content/ folder. The
// retrieval code fingerprints that folder, so adding or removing a file here
// makes Chipo re-read everything on the next question.

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, 'content');
const ALLOWED = ['.pdf', '.txt', '.md'];
const MAX_BYTES = 15 * 1024 * 1024;

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function safeName(filename) {
  const base = path.basename(String(filename || '')).replace(/[^\w.()\- ]+/g, '_').replace(/^\.+/, '').trim();
  if (!base) throw badRequest('A file name is required.');
  if (!ALLOWED.includes(path.extname(base).toLowerCase())) {
    throw badRequest(`Only ${ALLOWED.join(', ')} files can be added.`);
  }
  return base.slice(0, 150);
}

function list() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs.readdirSync(CONTENT_DIR)
    .filter((file) => ALLOWED.includes(path.extname(file).toLowerCase()))
    .map((file) => {
      const stat = fs.statSync(path.join(CONTENT_DIR, file));
      return { filename: file, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

function save({ filename, data }) {
  const name = safeName(filename);
  if (typeof data !== 'string' || !data) throw badRequest('No file content was received.');
  const buffer = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buffer.length) throw badRequest('The file is empty.');
  if (buffer.length > MAX_BYTES) throw badRequest('The file is larger than 15 MB.', 413);
  if (name.toLowerCase().endsWith('.pdf') && buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw badRequest('That file is not a valid PDF.');
  }
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const existed = fs.existsSync(path.join(CONTENT_DIR, name));
  fs.writeFileSync(path.join(CONTENT_DIR, name), buffer);
  return { filename: name, bytes: buffer.length, replaced: existed };
}

function remove(filename) {
  const name = safeName(filename);
  const target = path.join(CONTENT_DIR, name);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

module.exports = { list, save, remove, CONTENT_DIR };
