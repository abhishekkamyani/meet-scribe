require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Chrome Extension requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Setup temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp_recordings');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Configure Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `meet-recording-${uniqueSuffix}.webm`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const groqConfigured = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here');
  
  res.json({
    status: 'online',
    service: 'MeetScribe Urdu Backend',
    timestamp: new Date().toISOString(),
    config: {
      groqConfigured,
      geminiConfigured
    }
  });
});

/**
 * Step 1: Transcribe audio using Groq Whisper-large-v3 (language: 'ur')
 */
async function transcribeWithGroq(filePath, clientGroqKey) {
  const activeGroqKey = clientGroqKey || process.env.GROQ_API_KEY;
  if (!activeGroqKey || activeGroqKey === 'your_groq_api_key_here') {
    throw new Error('Groq API Key is missing. Please enter your Groq API Key in the MeetScribe extension settings.');
  }

  const groq = new Groq({
    apiKey: activeGroqKey
  });

  const fileStream = fs.createReadStream(filePath);

  console.log(`[Groq Whisper] Sending audio file (${filePath}) to Groq whisper-large-v3...`);
  
  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3',
    language: 'ur',
    response_format: 'verbose_json',
    temperature: 0.0,
    prompt: 'Urdu and English speech from Google Meet meeting transcript. گفتگو، کام، میٹنگ، پروجیکٹ، ٹاسک، فیصلہ، ذمہ داری، اگلا لائحہ عمل'
  });

  const rawText = transcription.text ? transcription.text.trim() : '';
  console.log(`[Groq Whisper] Transcription complete. Length: ${rawText.length} characters.`);
  return rawText;
}

/**
 * Step 2: Format and translate transcript using Google Generative AI (Gemini)
 */
async function processWithGemini(rawTranscript, clientGeminiKey) {
  const activeGeminiKey = clientGeminiKey || process.env.GEMINI_API_KEY;
  if (!activeGeminiKey || activeGeminiKey === 'your_gemini_api_key_here') {
    throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in the MeetScribe extension settings.');
  }

  const genAI = new GoogleGenerativeAI(activeGeminiKey);
  
  // Prioritized list of active models (verified against Google AI API)
  const userConfiguredModel = process.env.GEMINI_MODEL;
  const modelCandidates = [
    ...(userConfiguredModel ? [userConfiguredModel] : []),
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-2.5-flash-lite',
    'gemini-pro-latest'
  ];
  let lastError = null;

  const systemInstruction = `You are an elite bilingual AI meeting scribe and linguistic expert specializing in Pakistani corporate/workplace conversations (Urdu, English, and mixed 'Urdish').

Your job is to analyze raw speech-to-text transcripts of Google Meet calls and produce a comprehensive, structured output in JSON format adhering strictly to this schema:
{
  "transcript_urdu": "Full verbatim transcript written cleanly in Urdu script (نستعلیق / اردو رسم الخط). Fix minor STT phonetic misinterpretations and ensure proper Urdu grammar, punctuation, and flow while preserving all original conversation content.",
  "transcript_english": "Accurate, end-to-end, natural English translation of the entire meeting conversation.",
  "action_items_urdu": "Clear, bullet-pointed list of decisions, assigned tasks, and next steps in Urdu (اردو میں لائحہ عمل اور ٹاسکس). Format with bullet points (•).",
  "action_items_english_improved": "Grammatically polished, professional business English action items with clear ownership, deliverables, and deadlines if mentioned. Format with bullet points (•)."
}

CRITICAL RULES:
1. You must return ONLY valid, parseable JSON matching the exact schema above.
2. Do not wrap the JSON in Markdown code fences (\`\`\`json ... \`\`\`). Return pure JSON.
3. Ensure the Urdu text uses proper Unicode Arabic/Urdu characters.
4. If the transcript is brief or contains mixed English terms (e.g., 'API', 'Sprint', 'Deployment', 'Client'), keep technical terms in context.`;

  for (const modelName of modelCandidates) {
    try {
      console.log(`[Gemini] Attempting structuring with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Here is the raw transcribed meeting speech:\n\n${rawTranscript}\n\nGenerate the complete structured bilingual output in JSON format.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const responseText = response.text().trim();

      // Clean possible markdown wrappers if present
      const cleanedJsonStr = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const parsedData = JSON.parse(cleanedJsonStr);

      // Validate required keys
      const requiredKeys = ['transcript_urdu', 'transcript_english', 'action_items_urdu', 'action_items_english_improved'];
      const missingKeys = requiredKeys.filter(k => !(k in parsedData));
      
      if (missingKeys.length > 0) {
        console.warn(`[Gemini] Model ${modelName} returned JSON missing keys:`, missingKeys);
        // Fill missing keys with defaults
        missingKeys.forEach(k => {
          parsedData[k] = parsedData[k] || '';
        });
      }

      console.log(`[Gemini] Successfully generated structured notes using ${modelName}.`);
      return parsedData;
    } catch (err) {
      console.warn(`[Gemini] Error with model ${modelName}:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Failed to generate notes with Gemini: ${lastError ? lastError.message : 'Unknown error'}`);
}

// Main meeting processing endpoint
app.post('/api/process-meeting', upload.single('audio'), async (req, res) => {
  const uploadedFile = req.file;

  if (!uploadedFile) {
    return res.status(400).json({
      success: false,
      error: 'No audio file provided. Please upload a .webm file under the "audio" field.'
    });
  }

  // Extract client-supplied API keys from headers or body
  const clientGroqKey = req.headers['x-groq-api-key'] || req.body?.groqApiKey;
  const clientGeminiKey = req.headers['x-gemini-api-key'] || req.body?.geminiApiKey;

  const filePath = uploadedFile.path;
  console.log(`[MeetScribe] Received audio file: ${uploadedFile.originalname} (${uploadedFile.size} bytes)`);

  try {
    // 1. Check file size
    if (uploadedFile.size === 0) {
      throw new Error('Recorded audio file is empty (0 bytes). Please ensure audio was captured during the meeting.');
    }

    // 2. Transcribe via Groq Whisper
    const rawTranscript = await transcribeWithGroq(filePath, clientGroqKey);

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          transcript_urdu: "میٹنگ میں کوئی قابلِ فہم آواز یا گفتگو نہیں سنی گئی۔",
          transcript_english: "No intelligible speech was detected during the meeting recording.",
          action_items_urdu: "• کوئی ٹاسک یا ایکشن آئٹم ریکارڈ نہیں ہوا۔",
          action_items_english_improved: "• No action items were identified."
        },
        meta: {
          rawTranscript: ""
        }
      });
    }

    // 3. Process and Structure via Gemini LLM
    const structuredOutput = await processWithGemini(rawTranscript, clientGeminiKey);

    return res.status(200).json({
      success: true,
      data: {
        transcript_urdu: structuredOutput.transcript_urdu || rawTranscript,
        transcript_english: structuredOutput.transcript_english || "",
        action_items_urdu: structuredOutput.action_items_urdu || "",
        action_items_english_improved: structuredOutput.action_items_english_improved || ""
      },
      meta: {
        rawTranscript: rawTranscript
      }
    });

  } catch (err) {
    console.error('[MeetScribe] Processing error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal error occurred while processing meeting audio.'
    });
  } finally {
    // Cleanup temporary audio file immediately
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[MeetScribe] Cleaned up temporary file: ${filePath}`);
      }
    } catch (cleanupErr) {
      console.error('[MeetScribe] Error deleting temporary file:', cleanupErr.message);
    }
  }
});

// Function to start server with automatic port discovery
function startServer(portToTry, attemptsLeft = 10) {
  const srv = app.listen(portToTry, () => {
    console.log(`===================================================`);
    console.log(`  MeetScribe Urdu Backend running on port ${portToTry}`);
    console.log(`  Health Check: http://localhost:${portToTry}/api/health`);
    console.log(`  Process API:  http://localhost:${portToTry}/api/process-meeting`);
    console.log(`===================================================`);
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const nextPort = Number(portToTry) + 1;
      console.warn(`[MeetScribe] Port ${portToTry} is busy. Retrying automatically on port ${nextPort}...`);
      startServer(nextPort, attemptsLeft - 1);
    } else {
      console.error('[MeetScribe] Server listen error:', err.message);
    }
  });
}

startServer(Number(PORT) || 3000);


