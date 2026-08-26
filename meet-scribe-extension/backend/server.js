const os = require('os');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for Chrome Extension requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Groq-API-Key', 'X-Gemini-API-Key']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Setup temp directory for audio files if needed
const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const TEMP_DIR = isVercel ? path.join(os.tmpdir(), 'temp_recordings') : path.join(__dirname, 'temp_recordings');

try {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch (dirErr) {
  console.warn('[MeetScribe] Note on temp directory:', dirErr.message);
}

// Configure Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetDir = fs.existsSync(TEMP_DIR) ? TEMP_DIR : os.tmpdir();
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `meet-recording-${uniqueSuffix}.webm`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MeetScribe Urdu API (Express Backend)',
    health: '/api/health',
    processCaptions: '/api/process-captions',
    processMeeting: '/api/process-meeting'
  });
});

// Health check endpoints
app.get(['/api/health', '/health'], (req, res) => {
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
 * Helper: Structure and Translate Captions with Google Gemini
 * Takes ground-truth speaker-tagged captions from Google Meet and produces
 * bilingual transcripts and action items with 100% accurate speaker attribution.
 */
async function processCaptionsWithGemini(rawTranscript, participants = [], clientGeminiKey) {
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
    ? `AUTHENTIC GOOGLE MEET ATTENDEES IN THIS CALL:\n${participantsList.map(p => `- ${p}`).join('\n')}`
    : `SPEAKER ATTRIBUTION: Preserve the exact speaker names provided in the caption stream.`;

  const systemInstruction = `You are a world-class bilingual executive scribe and translator specializing in Urdu, English, and corporate conversations (Urdish).

You are given the VERBATIM, 100% GROUND-TRUTH CLOSED CAPTIONS captured live from a Google Meet call. Every sentence has already been tagged with the authentic speaker name by Google Meet.

${participantsHint}

CRITICAL RULES:
1. STRICT SPEAKER NAME PRESERVATION:
   - ALWAYS preserve the exact speaker names attached to each line (e.g. "[Shoaib Shah]: ...", "[Abhishek Kamyani]: ...").
   - NEVER invent, hallucinate, or replace real names with fictional names or generic tags like "[Host]", "[Speaker 1]", or "[Unknown]".

2. AUTHENTIC URDU LANGUAGE (ABSOLUTELY NO ARABIC):
   - Spoken language is URDU (اردو) / URDISH and English.
   - NEVER output Arabic greetings like "مرحبا" or "بارک اللہ". Use standard Urdu ("السلام علیکم", "ہیلو", "جی ٹھیک ہے", "کیا حال ہے").
   - Transcribe Urdu speech cleanly into Urdu script (نستعلیق / اردو رسم الخط). Keep technical loan words natural (e.g. "یو آئی", "بٹن", "اپ ڈیٹ", "اسکرین شیئر", "ٹیسٹ").

3. DIALOGUE FORMAT (MANDATORY):
   - Urdu transcript (transcript_urdu):
     "[Speaker Name]: [Urdu dialogue in Urdu script]"
   - English transcript (transcript_english):
     "[Speaker Name]: [Accurate, polished English translation of the dialogue]"

4. CONCRETE ACTION ITEMS:
   - Extract real decisions, commitments, tasks, and bugs discussed in the meeting.
   - Format: "• [Responsible Person]: [Specific action item description]"
   - If no actionable tasks were assigned:
     Urdu: "• کوئی مخصوص ٹاسک یا ایکشن آئٹم تفویض نہیں ہوا۔"
     English: "• No specific action items were assigned."

5. SILENCE / EMPTY HANDLING:
   - If the captions contain no substantive speech, return clean empty messages without hallucination.

OUTPUT JSON SCHEMA:
{
  "transcript_urdu": "Full speaker-wise dialogue in Urdu script.",
  "transcript_english": "Full speaker-wise dialogue translation in English.",
  "action_items_urdu": "Bullet-pointed tasks with assigned person names in Urdu.",
  "action_items_english_improved": "Polished business English action items with assigned person names."
}`;

  let lastError = null;
  for (const modelName of modelCandidates) {
    try {
      console.log(`[Backend Gemini Captions] Structuring with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Here are the verbatim Google Meet closed captions recorded during the meeting:\n\n${rawTranscript}\n\nConvert into full bilingual dialogue transcripts and action items in JSON adhering strictly to the schema.`;
      const result = await model.generateContent(prompt);
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

      console.log(`[Backend Gemini Captions] Successfully structured notes with ${modelName}.`);
      return parsedData;
    } catch (err) {
      console.warn(`[Backend Gemini Captions] Error with ${modelName}:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Captions processing failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

/**
 * Fallback: Process Captions with Groq LLM (llama-3.3-70b-versatile or mixtral)
 */
async function processCaptionsWithGroq(rawTranscript, participants = [], clientGroqKey) {
  const activeGroqKey = clientGroqKey || process.env.GROQ_API_KEY;
  if (!activeGroqKey || activeGroqKey === 'your_groq_api_key_here') {
    throw new Error('Groq API Key is missing.');
  }

  const groq = new Groq({ apiKey: activeGroqKey });
  console.log('[Backend Groq LLM] Structuring captions with Groq...');

  const completion = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: `You are a bilingual Urdu/English meeting notes assistant.
Return ONLY valid JSON with keys: "transcript_urdu", "transcript_english", "action_items_urdu", "action_items_english_improved".
Preserve exact speaker names. Spoken language is Urdu/English, NOT Arabic.`
      },
      {
        role: 'user',
        content: `Format these Google Meet captions into bilingual transcripts and action items:\n\n${rawTranscript}`
      }
    ],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  const content = completion.choices[0]?.message?.content || '{}';
  return JSON.parse(content);
}

/**
 * PRIMARY CAPTIONS PROCESSING ENDPOINT
 * Receives speaker-tagged captions text/utterances directly from the Chrome extension content script.
 */
app.post(['/api/process-captions', '/process-captions'], async (req, res) => {
  const { transcript, utterances, participants = [], geminiApiKey, groqApiKey } = req.body || {};
  const clientGeminiKey = req.headers['x-gemini-api-key'] || geminiApiKey;
  const clientGroqKey = req.headers['x-groq-api-key'] || groqApiKey;

  // Build raw transcript text if array of utterances was provided
  let formattedTranscript = '';
  if (typeof transcript === 'string' && transcript.trim()) {
    formattedTranscript = transcript.trim();
  } else if (Array.isArray(utterances) && utterances.length > 0) {
    formattedTranscript = utterances
      .map(u => `[${u.speaker || 'Participant'}]: ${u.text || ''}`)
      .join('\n');
  }

  console.log(`[MeetScribe] Received captions payload. Length: ${formattedTranscript.length} chars, Attendees:`, participants);

  if (!formattedTranscript || formattedTranscript.length === 0) {
    return res.status(200).json({
      success: true,
      data: {
        transcript_urdu: "میٹنگ میں کوئی کیپشن یا قابلِ فہم گفتگو ریکارڈ نہیں ہوئی۔",
        transcript_english: "No captions or intelligible speech were captured during this recording.",
        action_items_urdu: "• کوئی ٹاسک یا ایکشن آئٹم ریکارڈ نہیں ہوا۔",
        action_items_english_improved: "• No action items were identified."
      }
    });
  }

  try {
    let structuredOutput = null;

    // 1. Primary: Google Gemini
    try {
      structuredOutput = await processCaptionsWithGemini(formattedTranscript, participants, clientGeminiKey);
    } catch (geminiErr) {
      console.warn('[MeetScribe] Gemini captions processing failed, attempting Groq fallback:', geminiErr.message);
      if (clientGroqKey || process.env.GROQ_API_KEY) {
        structuredOutput = await processCaptionsWithGroq(formattedTranscript, participants, clientGroqKey);
      } else {
        throw geminiErr;
      }
    }

    return res.status(200).json({
      success: true,
      data: structuredOutput
    });

  } catch (err) {
    console.error('[MeetScribe] Captions Pipeline Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'An error occurred while processing meeting captions.'
    });
  }
});

/**
 * Secondary / Legacy Endpoint: Multi-part Audio Upload (Retained for backwards compatibility)
 */
app.post(['/api/process-meeting', '/process-meeting'], upload.single('audio'), async (req, res) => {
  // If captions were supplied in body instead of audio file
  if (req.body?.transcript || req.body?.utterances) {
    return app._router.handle(req, res);
  }

  const uploadedFile = req.file;
  if (!uploadedFile) {
    return res.status(400).json({
      success: false,
      error: 'No audio or captions provided.'
    });
  }

  const clientGroqKey = req.headers['x-groq-api-key'] || req.body?.groqApiKey;
  const clientGeminiKey = req.headers['x-gemini-api-key'] || req.body?.geminiApiKey;
  const filePath = uploadedFile.path;

  try {
    const groq = new Groq({ apiKey: clientGroqKey || process.env.GROQ_API_KEY });
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
      temperature: 0.0,
      prompt: 'Urdu and English Google Meet conversation.'
    });

    const rawText = transcription.text ? transcription.text.trim() : '';
    const structuredOutput = await processCaptionsWithGemini(rawText, [], clientGeminiKey);

    return res.status(200).json({
      success: true,
      data: structuredOutput
    });
  } catch (err) {
    console.error('[MeetScribe Audio Error]:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Audio processing failed.'
    });
  } finally {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }
});

/**
 * Scaffolding for Future Authentication (Email / Password / Google OAuth)
 */
app.post('/api/auth/register', (req, res) => {
  const { email, name } = req.body || {};
  res.json({
    success: true,
    message: 'User registration endpoint ready for database integration',
    user: { email, name, plan: 'free' }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email } = req.body || {};
  res.json({
    success: true,
    token: 'mock-jwt-token-ready-for-future-auth',
    user: { email, name: email ? email.split('@')[0] : 'User' }
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: false,
    authSystem: 'Ready for OAuth 2.0 / Firebase Auth / JWT'
  });
});

// Export app for Vercel Serverless deployments
module.exports = app;

// Function to start server with automatic port discovery (when running standalone)
function startServer(portToTry, attemptsLeft = 10) {
  const srv = app.listen(portToTry, () => {
    console.log(`===================================================`);
    console.log(`  MeetScribe Urdu Backend running on port ${portToTry}`);
    console.log(`  Health Check:     http://localhost:${portToTry}/api/health`);
    console.log(`  Process Captions: http://localhost:${portToTry}/api/process-captions`);
    console.log(`===================================================`);
  });

  srv.timeout = 600000;
  srv.keepAliveTimeout = 600000;

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

// Only start standalone server if executed directly (Local / Render / Koyeb)
if (require.main === module || !process.env.VERCEL) {
  startServer(Number(PORT) || 3000);
}
