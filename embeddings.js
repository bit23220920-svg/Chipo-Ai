// embeddings.js
//
// The Gemini embedding client and cosine-similarity helper, pulled out of
// ask.js so faqs.js can compute FAQ embeddings without ask.js and faqs.js
// having to require each other.

require('dotenv').config();
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
      // A daily quota will not clear in two seconds; retrying only burns more of it.
      if (attempt === retries || /per day|PerDay|quota/i.test(String(err && err.message))) throw err;
      console.log(`  Retry ${attempt}/${retries}...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

module.exports = { genAI, embedText, cosineSimilarity };
