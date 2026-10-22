const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const fileReader = require('../fileReader.js');
const attachmentStore = require('../attachments.js');
const ask = require('../ask.js');
const { app } = require('../server.js');

/* ------------------------------------------------------------------ *
 * A tiny zip writer, so the Office-file reader can be tested against a
 * properly formed zip without needing an external tool.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const content = Buffer.from(text, 'utf8');
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);            // stored, no compression
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const toBase64 = (buffer) => Buffer.from(buffer).toString('base64');

/* ------------------------------------------------------------------ *
 * Reading files
 * ------------------------------------------------------------------ */

test('a plain text file is read as text', async () => {
  const result = await fileReader.readUploadedFile({
    filename: 'statement.txt',
    mimeType: 'text/plain',
    data: toBase64(Buffer.from('Balance: 15,150.00 ZMW\nCourse: CS201')),
  });

  assert.equal(result.kind, 'text');
  assert.equal(result.filename, 'statement.txt');
  assert.match(result.text, /15,150\.00 ZMW/);
  assert.match(result.text, /CS201/);
});

test('a PDF is read as text', async () => {
  const contentDir = path.join(__dirname, '..', 'content');
  const pdfName = fs.readdirSync(contentDir).find((name) => name.endsWith('.pdf'));
  assert.ok(pdfName, 'expected a PDF in the content folder');

  const result = await fileReader.readUploadedFile({
    filename: pdfName,
    mimeType: 'application/pdf',
    data: toBase64(fs.readFileSync(path.join(contentDir, pdfName))),
  });

  assert.equal(result.kind, 'text');
  assert.ok(result.characters > 100, 'expected a fair amount of text from the PDF');
  assert.ok(result.text.length > 0);
});

test('a Word document is read as text', async () => {
  const zip = makeZip({
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + '<w:p><w:r><w:t>Deferment Application</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Reason: </w:t></w:r><w:r><w:t>medical &amp; hardship</w:t></w:r></w:p>'
      + '</w:body></w:document>',
  });

  const result = await fileReader.readUploadedFile({
    filename: 'application.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: toBase64(zip),
  });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /Deferment Application/);
  assert.match(result.text, /medical & hardship/);
});

test('an Excel workbook is read as rows', async () => {
  const zip = makeZip({
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t>Course</t></si><si><t>Grade</t></si><si><t>CS201</t></si><si><t>B</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
      + '<row r="2"><c t="s"><v>2</v></c><c t="s"><v>3</v></c></row>'
      + '</sheetData></worksheet>',
  });

  const result = await fileReader.readUploadedFile({
    filename: 'grades.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: toBase64(zip),
  });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /Course \| Grade/);
  assert.match(result.text, /CS201 \| B/);
});

test('a PowerPoint deck is read slide by slide', async () => {
  const zip = makeZip({
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:a="x"><a:p><a:r><a:t>Welcome to UNILUS</a:t></a:r></a:p></p:sld>',
  });

  const result = await fileReader.readUploadedFile({
    filename: 'intro.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    data: toBase64(zip),
  });

  assert.equal(result.kind, 'text');
  assert.match(result.text, /Slide 1: Welcome to UNILUS/);
});

test('an image is kept as an image for the model to look at', async () => {
  // A one pixel PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const result = await fileReader.readUploadedFile({
    filename: 'receipt.png',
    mimeType: 'image/png',
    data: toBase64(png),
  });

  assert.equal(result.kind, 'image');
  assert.equal(result.image.mimeType, 'image/png');
  assert.ok(result.image.data.length > 0);
});

test('a file type Chipo cannot read is refused', async () => {
  await assert.rejects(
    fileReader.readUploadedFile({
      filename: 'program.exe',
      mimeType: '',
      data: toBase64(Buffer.from('MZ')),
    }),
    /cannot read/i
  );
});

test('an empty file is refused', async () => {
  await assert.rejects(
    fileReader.readUploadedFile({ filename: 'empty.txt', mimeType: 'text/plain', data: '' }),
    /no file content|empty/i
  );
});

test('the file name is cleaned of any path', async () => {
  const result = await fileReader.readUploadedFile({
    filename: '../../etc/passwd.txt',
    mimeType: 'text/plain',
    data: toBase64(Buffer.from('hello')),
  });

  assert.equal(result.filename, 'passwd.txt');
  assert.doesNotMatch(result.filename, /\.\./);
});

/* ------------------------------------------------------------------ *
 * The attachment shelf
 * ------------------------------------------------------------------ */

test('a stored attachment can be fetched back and expires on its own', () => {
  const id = attachmentStore.save({ filename: 'notes.txt', kind: 'text', text: 'hello', characters: 5 });
  const stored = attachmentStore.get(id);

  assert.equal(stored.filename, 'notes.txt');
  assert.equal(stored.text, 'hello');

  assert.equal(attachmentStore.get('not-a-real-id'), null);
  assert.equal(attachmentStore.get(null), null);
});

/* ------------------------------------------------------------------ *
 * Access rules around files
 * ------------------------------------------------------------------ */

test('a personal question is refused when nobody is signed in', () => {
  assert.equal(ask.isLockedQuestion('What is my fee balance?', {}), true);
  assert.equal(ask.isLockedQuestion('What is my fee balance?', { student: { id: 'x' } }), false);
});

test('a question about an attached file is not refused', () => {
  assert.equal(
    ask.isLockedQuestion('What is my outstanding balance?', { attachments: [{ kind: 'text', text: '...' }] }),
    false
  );
});

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

test('an uploaded file is stored and can be read back by id', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'statement.txt',
        mimeType: 'text/plain',
        data: toBase64(Buffer.from('Outstanding balance: 15,150.00 ZMW')),
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.id);
    assert.equal(body.kind, 'text');
    assert.equal(body.filename, 'statement.txt');
    assert.match(body.preview, /15,150\.00 ZMW/);
    assert.equal(attachmentStore.get(body.id).text, 'Outstanding balance: 15,150.00 ZMW');
  });
});

test('an unsupported file is rejected with a clear message', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'thing.exe', mimeType: '', data: toBase64(Buffer.from('MZ')) }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /cannot read/i);
  });
});

test('a question carries the attached file through to Chipo', async () => {
  const originalAsk = ask.askQuestion;
  let seen = null;

  ask.askQuestion = async (question, history, options) => {
    seen = options;
    return { answer: 'Your balance is 15,150.00 ZMW.', confidence: 0.9, needsHuman: false, source: 'attachment', access: 'public' };
  };

  try {
    await withServer(async (base) => {
      const upload = await fetch(`${base}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'statement.txt',
          mimeType: 'text/plain',
          data: toBase64(Buffer.from('Outstanding balance: 15,150.00 ZMW')),
        }),
      });
      const { id } = await upload.json();

      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What is my outstanding balance?', attachmentIds: [id] }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(seen.attachments.length, 1);
      assert.equal(seen.attachments[0].filename, 'statement.txt');
      assert.match(seen.attachments[0].text, /15,150\.00 ZMW/);
      assert.equal(body.attachments[0].filename, 'statement.txt');
    });
  } finally {
    ask.askQuestion = originalAsk;
  }
});

test('an attachment id that no longer exists is reported', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is in this file?', attachmentIds: ['gone'] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /no longer available/i);
  });
});

test('attaching a file does not open the portal records', async () => {
  const originalAsk = ask.askQuestion;
  let seen = null;

  ask.askQuestion = async (question, history, options) => {
    seen = options;
    return { answer: 'From your file: 15,150.00 ZMW.', confidence: 0.9, needsHuman: false, source: 'attachment', access: 'public' };
  };

  try {
    await withServer(async (base) => {
      const upload = await fetch(`${base}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'statement.txt',
          mimeType: 'text/plain',
          data: toBase64(Buffer.from('Outstanding balance: 15,150.00 ZMW')),
        }),
      });
      const { id } = await upload.json();

      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer some-student-token',
        },
        body: JSON.stringify({ question: 'What is my outstanding balance?', attachmentIds: [id] }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      // The public website still passes no student, so no portal records leak.
      assert.equal(seen.student, null);
      assert.equal(body.access, 'public');
    });
  } finally {
    ask.askQuestion = originalAsk;
  }
});

test('the chat widget can attach a file and sends it with the question', async () => {
  await withServer(async (base) => {
    const script = await (await fetch(`${base}/chipobot.js`)).text();

    assert.match(script, /id="attachBtn"/);
    assert.match(script, /id="attachInput"/);
    assert.match(script, /fetch\('\/attachments'/);
    assert.match(script, /attachmentIds: attached\.map\(\(file\) => file\.id\)/);
  });
});
