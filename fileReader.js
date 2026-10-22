// fileReader.js
//
// Turns an uploaded file into something Chipo can read.
//
// Supported:
//   - plain text        .txt .md .csv .tsv .json .xml .html .log .rtf
//   - PDF               via pdf-parse (already a dependency)
//   - Word              .docx  (Office Open XML — read with a small zip reader)
//   - PowerPoint        .pptx
//   - Excel             .xlsx
//   - Images            .png .jpg .jpeg .webp .gif .bmp — handed to the model
//                       as pixels so Chipo can look at them
//
// The Office formats are zip containers, and there is no zip library in the
// project, so readZipEntries() below walks the zip structure directly. That
// keeps the app free of new dependencies.

'use strict';

const path = require('path');
const zlib = require('zlib');

// pdf-parse's default export has moved around between versions, so resolve
// the parser function the same way ask.js does.
const pdfParseModule = require('pdf-parse');
let pdfParse;
if (typeof pdfParseModule === 'function') {
  pdfParse = pdfParseModule;
} else if (pdfParseModule && typeof pdfParseModule.default === 'function') {
  pdfParse = pdfParseModule.default;
} else if (pdfParseModule && typeof pdfParseModule.pdfParse === 'function') {
  pdfParse = pdfParseModule.pdfParse;
} else if (pdfParseModule && typeof pdfParseModule.parse === 'function') {
  pdfParse = pdfParseModule.parse;
} else {
  pdfParse = async (buffer) => new pdfParseModule(buffer);
}

const MAX_BYTES = 8 * 1024 * 1024;        // 8 MB
const MAX_TEXT_CHARS = 120000;            // ~15k tokens of file text
const MAX_PDF_PAGES = 60;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
]);

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

const OFFICE_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx']);

const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS, '.pdf', '.rtf',
]);

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function tooLarge(message) {
  const err = new Error(message);
  err.statusCode = 413;
  return err;
}

/* ------------------------------------------------------------------ *
 * Zip reading (for .docx / .pptx / .xlsx)
 * ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readZipEntries(buffer) {
  // The end-of-central-directory record sits at the end of the file, after
  // an optional comment, so scan backwards for its signature.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw badRequest('That file is not a readable Office document.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // Office writes forward slashes, but a few tools write backslashes, so
    // normalise and look the entry up either way.
    entries.set(name.replace(/\\/g, '/'), { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const local = entry.localOffset;
    if (local + 30 > buffer.length) return null;
    if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) return null;

    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + entry.compressedSize);

    try {
      if (entry.method === 0) return data;
      if (entry.method === 8) return zlib.inflateRawSync(data);
    } catch (err) {
      return null;
    }
    return null;
  }

  return { names: [...entries.keys()], readEntry };
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Word XML -> readable text. */
function docxText(buffer) {
  const zip = readZipEntries(buffer);
  const xml = zip.readEntry('word/document.xml');
  if (!xml) throw badRequest('The Word file could not be opened (no document body).');
  return decodeEntities(
    xml.toString('utf8')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:cr[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n').trim();
}

/** PowerPoint XML -> one line per slide. */
function pptxText(buffer) {
  const zip = readZipEntries(buffer);
  const slides = zip.names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));

  if (!slides.length) throw badRequest('The PowerPoint file has no slides.');

  return slides.map((name) => {
    const entry = zip.readEntry(name);
    const xml = entry ? entry.toString('utf8') : '';
    const parts = (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || [])
      .map((part) => decodeEntities(part.replace(/<[^>]+>/g, '')))
      .filter(Boolean);
    return `Slide ${name.match(/slide(\d+)/)[1]}: ${parts.join(' ')}`;
  }).join('\n\n');
}

/** Excel XML -> one block per sheet, rows separated by " | ". */
function xlsxText(buffer) {
  const zip = readZipEntries(buffer);
  const shared = [];

  const sharedXml = zip.readEntry('xl/sharedStrings.xml');
  if (sharedXml) {
    const xml = sharedXml.toString('utf8');
    for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = (match[1].match(/<t[^>]*>[\s\S]*?<\/t>/g) || [])
        .map((part) => decodeEntities(part.replace(/<[^>]+>/g, '')));
      shared.push(parts.join(''));
    }
  }

  const sheets = zip.names
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));

  if (!sheets.length) throw badRequest('The Excel file has no sheets.');

  return sheets.map((name) => {
    const entry = zip.readEntry(name);
    const xml = entry ? entry.toString('utf8') : '';
    const rows = [];

    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = cellMatch[1] || '';
        const body = cellMatch[2] || '';
        const type = (attributes.match(/\st="(\w+)"/) || [])[1];
        let value = (body.match(/<v>([^<]*)<\/v>/) || [])[1] || '';

        const inline = (body.match(/<is>([\s\S]*?)<\/is>/) || [])[1];
        if (inline) {
          value = (inline.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [])
            .map((part) => decodeEntities(part.replace(/<[^>]+>/g, '')))
            .join('');
        }
        if (type === 's') value = shared[Number(value)] || value;
        cells.push(decodeEntities(value));
      }
      if (cells.length) rows.push(cells.join(' | '));
    }

    return `Sheet ${name.match(/sheet(\d+)/)[1]}:\n${rows.join('\n')}`;
  }).join('\n\n');
}

/** RTF -> plain text (drop the control words and braces). */
function rtfText(buffer) {
  return buffer.toString('utf8')
    .replace(/\\'[\0-9a-f]{2}/g, '')
    .replace(/\\[a-z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Read an uploaded file.
 *
 * @param {{filename?: string, mimeType?: string, data: string}} file
 *   `data` is the file content as base64.
 * @returns {Promise<{kind: string, filename: string, text?: string,
 *                    image?: {mimeType: string, data: string},
 *                    characters?: number, truncated?: boolean, preview?: string}>}
 */
async function readUploadedFile({ filename = '', mimeType = '', data = '' } = {}) {
  const name = path.basename(String(filename || '')).slice(0, 180) || 'attachment';
  const extension = path.extname(name).toLowerCase();

  if (!data) throw badRequest('No file content was received.');

  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch (err) {
    throw badRequest('The file could not be decoded.');
  }
  if (!buffer.length) throw badRequest('The file is empty.');
  if (buffer.length > MAX_BYTES) {
    throw tooLarge(`That file is too large. The limit is ${Math.round(MAX_BYTES / (1024 * 1024))} MB.`);
  }

  // Images are passed to the model as pixels.
  if (IMAGE_EXTENSIONS.has(extension) || String(mimeType).startsWith('image/')) {
    const imageMimeType = IMAGE_MIME_TYPES[extension]
      || (String(mimeType).startsWith('image/') ? String(mimeType) : 'image/png');
    return {
      kind: 'image',
      filename: name,
      image: { mimeType: imageMimeType, data: buffer.toString('base64') },
      characters: 0,
      preview: 'image',
    };
  }

  let text = '';

  if (extension === '.pdf' || mimeType === 'application/pdf') {
    let data2;
    try {
      data2 = await pdfParse(buffer);
    } catch (err) {
      throw badRequest('That PDF could not be read. It may be password protected or damaged.');
    }
    text = String(data2.text || '').trim();
    if (!text) throw badRequest('No text could be extracted from that PDF (it may be a scan of an image).');
  } else if (extension === '.docx') {
    text = docxText(buffer);
  } else if (extension === '.pptx') {
    text = pptxText(buffer);
  } else if (extension === '.xlsx') {
    text = xlsxText(buffer);
  } else if (extension === '.rtf') {
    text = rtfText(buffer);
  } else if (TEXT_EXTENSIONS.has(extension) || /^text\//.test(String(mimeType))) {
    text = buffer.toString('utf8');
  } else {
    throw badRequest(
      `Chipo cannot read "${extension || 'that file type'}". Supported: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), plain text, and images.`
    );
  }

  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw badRequest('No text could be read from that file.');

  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[... the rest of the file was left out because it is too long ...]`;
  }

  return {
    kind: 'text',
    filename: name,
    text,
    characters: text.length,
    truncated,
    preview: text.slice(0, 240).replace(/\s+/g, ' '),
  };
}

module.exports = {
  readUploadedFile,
  SUPPORTED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  OFFICE_EXTENSIONS,
  MAX_BYTES,
  MAX_TEXT_CHARS,
};
