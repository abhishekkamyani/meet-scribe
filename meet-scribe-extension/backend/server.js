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
  
  // High-accuracy bilingual transcription (allows natural Urdu, English, and code-switched Urdish)
  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    temperature: 0.0,
    prompt: 'Bilingual Urdu, English, and Urdish speech from a corporate Google Meet meeting (اردو اور انگریزی گفتگو).'
  });

  const rawText = transcription.text ? transcription.text.trim() : '';
  console.log(`[Groq Whisper] Raw transcription received: "${rawText}" (Length: ${rawText.length} characters)`);
  return rawText;
}

/**
 * Primary Engine: Direct Multimodal Audio Processing with Google Gemini
 * Ingests the raw audio file directly to capture exact voice tones, authentic Urdu speech, and technical terms.
 */
async function processDirectAudioWithGemini(filePath, clientGeminiKey, participants = []) {
  const activeGeminiKey = clientGeminiKey || process.env.GEMINI_API_KEY;
  if (!activeGeminiKey || activeGeminiKey === 'your_gemini_api_key_here') {
    throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in settings.');
  }

  const genAI = new GoogleGenerativeAI(activeGeminiKey);
  const audioBase64 = fs.readFileSync(filePath).toString('base64');
  const audioPart = {
    inlineData: {
      data: audioBase64,
      mimeType: 'audio/webm'
    }
  };

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

  const participantsList = Array.isArray(participants) ? participants.filter(Boolean) : [];
  const participantsHint = participantsList.length > 0
    ? `KNOWN MEETING PARTICIPANTS:\n${participantsList.map(p => `- ${p}`).join('\n')}\n\nAttribute speaker tags to these participants whenever they are speaking in the audio.`
    : `SPEAKER INFERENCE:\nInfer actual speaker names (e.g., Abhishek, Shoaib, Sahil, Ali, Sara) from greetings, voice introductions, and conversational context. If a speaker is unidentified, use "Speaker 1:", "Speaker 2:" consistently.`;

  const systemInstruction = `You are an elite bilingual AI meeting scribe specializing in Urdu, English, and mixed Pakistani/Indian corporate conversations (Urdish).

Your mission is to listen directly to the recorded meeting audio and generate an ACCURATE, SPEAKER-DIARIZED bilingual meeting transcript and action items.

${participantsHint}

CRITICAL RULES:
1. STRICT URDU LANGUAGE (ABSOLUTELY NO ARABIC):
   - The spoken language is URDU / HINDI / URDISH (اردو زبان) and English.
   - NEVER output Arabic greetings or phrases like "مرحبا" or "بارک اللہ" or "أهلا وسهلا".
   - Use authentic conversational Urdu (مثلاً: "ہیلو", "السلام علیکم", "کیا حال ہے", "کیسے ہیں", "ٹھیک ہوں", "اپ ڈیٹ", "بٹن", "یو آئی", "پیج", "اینڈ پوائنٹ", "کام").

2. STRICT FIDELITY TO ACTUAL AUDIO:
   - Transcribe and translate ONLY what was ACTUALLY spoken in the audio recording.
   - Do NOT invent fictional agendas, fake meeting topics, or generic filler.
   - Keep technical English terms (e.g., UI, Button, API, Page, Endpoint, Deployment, Bug, Fix) intact and properly spelled.

3. DIALOGUE FORMAT (MANDATORY FOR BOTH URDU AND ENGLISH):
   Every dialogue line MUST start with the speaker's name:
   Urdu: "ابھیشیک: [اردو میں اصل گفتگو]"
   English: "Abhishek: [Accurate English translation]"

4. CONCRETE ACTION ITEMS:
   - Extract only real commitments, bug fixes, tasks, or follow-ups mentioned in the speech.
   - Format: "• [Responsible Person]: [Specific action item or task]"
   - If no tasks were discussed, write:
     Urdu: "• اس گفتگو میں کوئی مخصوص ٹاسک یا ایکشن آئٹم زیرِ بحث نہیں آیا۔"
     English: "• No specific action items were discussed in this conversation."

OUTPUT JSON SCHEMA:
{
  "transcript_urdu": "Full speaker-wise dialogue transcript in Urdu script (e.g. 'ابھیشیک: ...\\nشعیب: ...')",
  "transcript_english": "Full speaker-wise dialogue translation in English (e.g. 'Abhishek: ...\\nShoaib: ...')",
  "action_items_urdu": "Bullet-pointed tasks with assigned person names in Urdu (e.g. '• ابھیشیک: ...\\n• شعیب: ...')",
  "action_items_english_improved": "Polished business English action items with assigned person names (e.g. '• Abhishek: ...\\n• Shoaib: ...')"
}

CRITICAL: Return ONLY valid, parseable JSON. Do not wrap in markdown code blocks.`;

  let lastError = null;

  for (const modelName of modelCandidates) {
    try {
      console.log(`[Gemini Multimodal] Listening directly to audio recording with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Listen carefully to this meeting audio recording and generate the full speaker-attributed bilingual dialogue transcript and action items in JSON format adhering strictly to the schema.`;

      const result = await model.generateContent([prompt, audioPart]);
      const response = await result.response;
      const responseText = response.text().trim();

      const cleanedJsonStr = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const parsedData = JSON.parse(cleanedJsonStr);

      const requiredKeys = ['transcript_urdu', 'transcript_english', 'action_items_urdu', 'action_items_english_improved'];
      requiredKeys.forEach(k => {
        parsedData[k] = parsedData[k] || '';
      });

      console.log(`[Gemini Multimodal] Successfully generated notes directly from audio using ${modelName}.`);
      return parsedData;
    } catch (err) {
      console.warn(`[Gemini Multimodal] Direct audio attempt with ${modelName} encountered error:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Direct audio processing failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

/**
 * Secondary / Fallback Engine: Groq Whisper STT + Gemini Post-Processor
 */
async function processWithGroqAndGemini(filePath, clientGroqKey, clientGeminiKey, participants = []) {
  // 1. Transcribe with Groq Whisper
  const rawTranscript = await transcribeWithGroq(filePath, clientGroqKey);

  if (!rawTranscript || rawTranscript.trim().length === 0) {
    return {
      transcript_urdu: "میٹنگ میں کوئی قابلِ فہم آواز یا گفتگو نہیں سنی گئی۔",
      transcript_english: "No intelligible speech was detected during the meeting recording.",
      action_items_urdu: "• کوئی ٹاسک یا ایکشن آئٹم ریکارڈ نہیں ہوا۔",
      action_items_english_improved: "• No action items were identified."
    };
  }

  // 2. Structure with Gemini
  const activeGeminiKey = clientGeminiKey || process.env.GEMINI_API_KEY;
  if (!activeGeminiKey || activeGeminiKey === 'your_gemini_api_key_here') {
    throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in settings.');
  }

  const genAI = new GoogleGenerativeAI(activeGeminiKey);
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

  const participantsList = Array.isArray(participants) ? participants.filter(Boolean) : [];
  const participantsHint = participantsList.length > 0
    ? `KNOWN ATTENDEES:\n${participantsList.map(p => `- ${p}`).join('\n')}`
    : `SPEAKER INFERENCE: Infer actual speaker names from greetings and turn-taking.`;

  const systemInstruction = `You are a bilingual Urdu/English meeting notes editor.
Convert the raw speech-to-text transcript into clean speaker-by-speaker dialogue and action items.

${participantsHint}

CRITICAL RULES:
- The spoken language is URDU (اردو) and English. NEVER output Arabic greetings like "مرحبا" or "بارک اللہ".
- Faithful transcription: Transcribe and translate the exact words from the speech text. Fix minor phonetic errors (e.g. "یو آئی اپ ڈیٹ کرنا ہے", "بٹن سیٹ کرنا ہے").
- Format dialogue as "Speaker Name: [Content]".
- Extract only real action items discussed.

OUTPUT JSON SCHEMA:
{
  "transcript_urdu": "Full speaker dialogue in Urdu script.",
  "transcript_english": "Full speaker dialogue in English translation.",
  "action_items_urdu": "Bullet-pointed tasks with assigned person in Urdu.",
  "action_items_english_improved": "Polished business English action items with assigned person."
}`;

  let lastError = null;
  for (const modelName of modelCandidates) {
    try {
      console.log(`[Gemini STT-PostProcessor] Structuring raw text with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Here is the raw transcribed meeting speech:\n\n${rawTranscript}\n\nFormat into speaker dialogue and action items in JSON.`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const cleanedJsonStr = response.text().trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const parsedData = JSON.parse(cleanedJsonStr);
      return parsedData;
    } catch (err) {
      console.warn(`[Gemini STT-PostProcessor] Error with ${modelName}:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Structuring failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

// Main meeting processing endpoint (Dual-Engine: Direct Multimodal Audio with Groq Fallback)
app.post('/api/process-meeting', upload.single('audio'), async (req, res) => {
  const uploadedFile = req.file;

  if (!uploadedFile) {
    return res.status(400).json({
      success: false,
      error: 'No audio file provided. Please upload a .webm file under the "audio" field.'
    });
  }

  // Extract client-supplied API keys and participants from headers or body
  const clientGroqKey = req.headers['x-groq-api-key'] || req.body?.groqApiKey;
  const clientGeminiKey = req.headers['x-gemini-api-key'] || req.body?.geminiApiKey;
  
  let participants = [];
  if (req.body?.participants) {
    try {
      participants = typeof req.body.participants === 'string' ? JSON.parse(req.body.participants) : req.body.participants;
    } catch (e) {
      participants = [];
    }
  }

  const filePath = uploadedFile.path;
  console.log(`[MeetScribe] Received audio file: ${uploadedFile.originalname} (${uploadedFile.size} bytes), attendees:`, participants);

  try {
    if (uploadedFile.size === 0) {
      throw new Error('Recorded audio file is empty (0 bytes). Please ensure audio was captured during the meeting.');
    }

    let structuredOutput = null;

    // 1. Try Direct Multimodal Audio with Gemini (Highest fidelity - listens directly to raw audio)
    try {
      console.log('[MeetScribe] Attempting Direct Multimodal Audio processing with Gemini...');
      structuredOutput = await processDirectAudioWithGemini(filePath, clientGeminiKey, participants);
    } catch (directAudioErr) {
      console.warn('[MeetScribe] Direct audio processing failed, falling back to Groq Whisper + Gemini pipeline:', directAudioErr.message);
      
      // 2. Fallback: Groq Whisper STT + Gemini Structuring
      structuredOutput = await processWithGroqAndGemini(filePath, clientGroqKey, clientGeminiKey, participants);
    }

    return res.status(200).json({
      success: true,
      data: structuredOutput
    });

  } catch (err) {
    console.error('[MeetScribe] Pipeline Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'An unexpected error occurred while processing meeting notes.'
    });
  } finally {
    // Delete temporary audio file from disk
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`[MeetScribe] Cleaned up temporary file: ${filePath}`);
      } catch (cleanupErr) {
        console.error('[MeetScribe] Error deleting temporary file:', cleanupErr.message);
      }
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


