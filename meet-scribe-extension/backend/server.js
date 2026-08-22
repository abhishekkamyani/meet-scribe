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
    ? `KNOWN MEETING PARTICIPANTS:\n${participantsList.map(p => `- ${p}`).join('\n')}\n\nIMPORTANT: Use these exact participant names for speaker turns when their dialogue occurs in the conversation.`
    : `PARTICIPANT INFERENCE:\nInfer actual speaker names (e.g., Abhishek, Shoaib, Sahil, Ali, Sara, etc.) from greetings, self-introductions, handovers ("Over to you Shoaib", "Thanks Abhishek"), question-answer exchanges, and conversational context. If any speaker's real name is not mentioned or deducible, use "Speaker 1:", "Speaker 2:", etc. consistently.`;

  const systemInstruction = `You are an elite bilingual AI meeting scribe and linguistic expert specializing in corporate and professional Google Meet conversations (Urdu, English, and mixed 'Urdish').

Your mission is to convert raw speech-to-text transcripts into a POLISHED, DIALOGUE-STYLE, SPEAKER-BY-SPEAKER conversation transcript and actionable meeting minutes.

${participantsHint}

CRITICAL RULES FOR TRANSCRIPTS:
1. DIALOGUE FORMAT (MANDATORY FOR BOTH URDU AND ENGLISH):
   Every dialogue turn MUST start with the speaker's name followed by a colon.
   
   Example Format in Urdu:
     ابھیشیک: السلام علیکم شعیب، کیا حال ہے؟
     شعیب: وعلیکم السلام، میں بالکل ٹھیک ہوں۔ پروجیکٹ کا کام کہاں تک پہنچا؟
     ساحل: ہیلو سب کو، میں نے اے پی آئی انٹیگریشن مکمل کر لی ہے۔
   
   Example Format in English:
     Abhishek: Hey Shoaib, how are you?
     Shoaib: I am good. How far has the project progressed?
     Sahil: Hello guys, I have completed the API integration.

2. SPEAKER DIARIZATION & FLOW:
   - Carefully detect speaker transitions, question-and-answer pairs, greetings, and turn-taking.
   - Clean up audio stutter or minor STT acoustic errors while preserving 100% of the conversational meaning.
   - Keep technical terms (e.g., 'API', 'Sprint', 'Deployment', 'Database', 'PR') in accurate context.

3. ACTION ITEMS WITH EXPLICIT OWNERSHIP:
   - Every single action item MUST explicitly assign ownership to the responsible participant!
   - Format: "• [Responsible Person]: [Specific action, decision, or deliverable with deadline if mentioned]"
   - Example in Urdu: "• ساحل: کل شام تک ڈیٹا بیس مائیگریشن اور اے پی آئی ٹیسٹنگ مکمل کرنا۔"
   - Example in English: "• Sahil: Complete the database migration and API testing by tomorrow evening."

OUTPUT JSON SCHEMA:
{
  "transcript_urdu": "Full speaker-wise dialogue transcript in Urdu script (e.g. 'ابھیشیک: ...\\nشعیب: ...')",
  "transcript_english": "Full speaker-wise dialogue translation in English (e.g. 'Abhishek: ...\\nShoaib: ...')",
  "action_items_urdu": "Bullet-pointed list of tasks with owner names in Urdu (e.g. '• ابھیشیک: ...\\n• شعیب: ...')",
  "action_items_english_improved": "Polished business English action items with owner names (e.g. '• Abhishek: ...\\n• Shoaib: ...')"
}

CRITICAL: Return ONLY valid, parseable JSON. Do not wrap in markdown code blocks.`;

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


