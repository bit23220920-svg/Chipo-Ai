require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedText(text, retries = 3) {
  const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`  Retry ${attempt}/${retries}...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const contentDir = path.join(__dirname, 'content');
  const files = fs.readdirSync(contentDir);

  const chunks = [];
  for (const file of files) {
    const filepath = path.join(contentDir, file);
    let text;
    if (file.endsWith('.pdf')) {
      const buffer = fs.readFileSync(filepath);
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      text = fs.readFileSync(filepath, 'utf-8');
    }
    chunks.push({ filename: file, text });
  }

  console.log(`Loaded ${chunks.length} content files:`, chunks.map(c => c.filename));
  chunks.forEach(c => console.log(`  ${c.filename}: ${c.text.length} characters`));

  console.log("Embedding content...");
  for (const chunk of chunks) {
    chunk.embedding = await embedText(chunk.text);
  }
  console.log("Done embedding.");

  const question = "How much does it cost to study here?";
  console.log(`\nQuestion: "${question}"`);
  const questionEmbedding = await embedText(question);

  const scored = chunks.map((chunk) => ({
    filename: chunk.filename,
    score: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  console.log("\nRanked matches:");
  scored.forEach((s) => console.log(`${s.filename}: ${s.score.toFixed(4)}`));

  console.log(`\nBest match: ${scored[0].filename}`);
}

main().catch((err) => {
  console.error("ERROR:");
  console.error(err.cause || err);
});