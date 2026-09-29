console.log("1. Script started");

require('dotenv').config();
console.log("2. Env loaded, key exists:", !!process.env.GEMINI_API_KEY);

const { GoogleGenerativeAI } = require('@google/generative-ai');
console.log("3. Package loaded");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
console.log("4. Client created");

async function main() {
  const modelsToTry = [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite"
  ];

  const context = `
    University Admission Requirements:
    Applicants must have a minimum of 5 credits including English and Mathematics.
    The application deadline for the 2026 academic year is October 31.
  `;
  const question = "Whats my name?";
  const prompt = `You are a university admissions assistant. Only answer using the provided context. If the answer isn't in the context, say you don't have that information.
  Context:
  ${context}
  Question: ${question}`;

  for (const modelName of modelsToTry) {
    console.log(`\n--- Testing model: ${modelName} ---`);
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      console.log(`SUCCESS with ${modelName}:`);
      console.log(result.response.text());
      return; // Stop at first successful model
    } catch (err) {
      console.error(`FAILED with ${modelName}:`, err.message || err);
    }
  }
}

main().catch((err) => {
  console.error("ERROR in main loop:");
  console.error(err.cause || err);
});