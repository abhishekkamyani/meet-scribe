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
 * Step 2: Format and translate transcript using Google Generative AI (Gemini)
 * Generates speaker-wise dialogue transcript and ownership-attributed action items.
 */
async function processWithGemini(rawTranscript, clientGeminiKey, participants = []) {
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

  const participantsList = Array.isArray(participants) ? participants.filter(Boolean) : [];
  const participantsHint = participantsList.length > 0
    ? `KNOWN MEETING ATTENDEES (from Google Meet tab):\n${participantsList.map(p => `- ${p}`).join('\n')}\n\nIMPORTANT: Use these exact attendee names for dialogue speaker tags whenever they are speaking.`
    : `SPEAKER INFERENCE:\nInfer actual speaker names (e.g., Abhishek, Shoaib, Sahil, Ali, Sara) from conversational cues, name calls, greetings, and introductions. If any speaker is not identifiable, use "Speaker 1:", "Speaker 2:" consistently.`;

  const systemInstruction = `You are an elite bilingual linguistic expert and AI meeting transcriber specializing in Pakistani & international workplace conversations (Urdu, English, and mixed 'Urdish').

Your task is to take the raw speech-to-text transcript from Groq Whisper and produce an ACCURATE, HIGH-FIDELITY, SPEAKER-DIARIZED bilingual record.

${participantsHint}

CORE RESPONSIBILITIES:
1. FAITHFUL TRANSCRIPTION (DO NOT INVENT CONTENT):
   - Every sentence must accurately reflect what was ACTUALLY spoken in the audio.
   - Fix minor Speech-to-Text acoustic misinterpretations (e.g., technical terms, names, slang, mixed Urdish phrases) so sentences read grammatically and naturally in both languages.
   - Do NOT invent fictional agendas, fake discussions, or generic corporate filler.

2. DUAL-LANGUAGE OUTPUTS:
   - "transcript_urdu": Complete, natural verbatim conversation rendered cleanly in Urdu script (اردو رسم الخط / نستعلیق). Format every line as "Speaker Name: [Urdu dialogue]".
   - "transcript_english": Complete, accurate, natural English translation of the entire conversation turn-by-turn. Format every line as "Speaker Name: [English dialogue]".

3. CONCRETE ACTION ITEMS:
   - Extract only real commitments, decisions, tasks, or follow-ups mentioned in the speech.
   - Format: "• [Responsible Person]: [Concrete action item or deliverable]"
   - If no tasks were assigned, write:
     Urdu: "• میٹنگ میں کوئی مخصوص ٹاسک یا ایکشن آئٹم تفویض نہیں کیا گیا۔"
     English: "• No specific action items were assigned in this discussion."

OUTPUT JSON SCHEMA:
{
  "transcript_urdu": "Full speaker-wise dialogue transcript in Urdu script (e.g. 'ابھیشیک: ...\\nشعیب: ...')",
  "transcript_english": "Full speaker-wise dialogue translation in English (e.g. 'Abhishek: ...\\nShoaib: ...')",
  "action_items_urdu": "Bullet-pointed tasks with assigned person names in Urdu (e.g. '• ابھیشیک: ...\\n• شعیب: ...')",
  "action_items_english_improved": "Polished business English action items with assigned person names (e.g. '• Abhishek: ...\\n• Shoaib: ...')"
}

CRITICAL: Output ONLY valid, parseable JSON matching the schema above.`;

  for (const modelName of modelCandidates) {
    try {
      console.log(`[Gemini] Attempting speaker-diarized structuring with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Here is the raw transcribed meeting audio speech:\n\n${rawTranscript}\n\nGenerate the complete speaker-attributed bilingual dialogue transcript and action items in JSON format.`;

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

      console.log(`[Gemini] Successfully generated speaker-wise notes using ${modelName}.`);
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
  console.log(`[MeetScribe] Received audio file: ${uploadedFile.originalname} (${uploadedFile.size} bytes), participants:`, participants);

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

    // 3. Process and Structure via Gemini LLM with Speaker Diarization
    const structuredOutput = await processWithGemini(rawTranscript, clientGeminiKey, participants);

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


