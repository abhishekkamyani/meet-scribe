require('dotenv').config(); // C8 fix: load .env before anything else so GEMINI_API_KEY / GROQ_API_KEY are available locally
const os = require('os');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');

// Gemini's inline-base64 request path has a hard ~20MB ceiling; anything larger
// must go through the File API (upload once, reference by URI).
const GEMINI_INLINE_LIMIT_BYTES = 15 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const GROQ_TEXT_MODEL_CANDIDATES = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b'
];

function geminiModelCandidates() {
  return [...new Set([
    process.env.GEMINI_MODEL,
    DEFAULT_GEMINI_MODEL
  ].filter(Boolean))];
}

function isTransientProviderError(error) {
  const message = String(error?.message || error).toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  return status === 408 || status === 429 || status >= 500 ||
    /fetch failed|connection error|econnreset|etimedout|enotfound|socket hang up|network error/.test(message);
}

async function retryTransientProviderRequest(label, request, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isTransientProviderError(error) || attempt === attempts) break;
      const delayMs = attempt * 1000;
      console.warn(`${label} failed due to a temporary connection error; retrying in ${delayMs / 1000}s (${attempt}/${attempts - 1})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

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

// N4: Only create temp dir when running locally — on Vercel the filesystem is ephemeral
if (!isVercel) {
  try {
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  } catch (dirErr) {
    console.warn('[MeetScribe] Note on temp directory:', dirErr.message);
  }
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
});/**
 * Helper: Strip any speaker tags or name prefixes from text
 * Guarantees 100% plain text output with zero "[Speaker]:" or "[Name]:" prefixes.
 */
function stripSpeakerTags(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/^\uFEFF/, '')
    .replace(/^\[?\s*(?:Speaker(?:\s*\d+)?|Participant(?:\s*\d+)?|Person(?:\s*\d+)?|User|Host|Attendee|Unknown|You|آپ|مقرر|بولنے\s*والا|[^\]:\n]{1,40})\s*\]?\s*:\s*/gim, '')
    .replace(/\n\[?\s*(?:Speaker(?:\s*\d+)?|Participant(?:\s*\d+)?|Person(?:\s*\d+)?|User|Host|Attendee|Unknown|You|آپ|مقرر|بولنے\s*والا|[^\]:\n]{1,40})\s*\]?\s*:\s*/gim, '\n')
    .replace(/•\s*\[?\s*(?:Speaker(?:\s*\d+)?|Participant|Person|User|Host|Attendee|Unknown|You|آپ|[^\]]+)\s*\]?\s*:\s*/gim, '• ')
    .replace(/\[?Speaker(?:\s*\d+)?\]?\s*:\s*/gi, '')
    .replace(/\[Speaker\]/gi, '')
    .trim();
}

function sanitizePlainMeetingNotes(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    transcript_urdu: stripSpeakerTags(data.transcript_urdu),
    transcript_english: stripSpeakerTags(data.transcript_english),
    action_items_urdu: stripSpeakerTags(data.action_items_urdu),
    action_items_english_improved: stripSpeakerTags(data.action_items_english_improved)
  };
}

/**
 * Helper: Structure and Translate Meeting Text with Google Gemini
 * Generates plain bilingual transcripts and action items without any speaker names.
 */
async function processCaptionsWithGemini(rawTranscript, participants = [], clientGeminiKey) {
  const activeGeminiKey = clientGeminiKey || process.env.GEMINI_API_KEY;
  if (!activeGeminiKey || activeGeminiKey === 'your_gemini_api_key_here') {
    throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in settings.');
  }

  const genAI = new GoogleGenerativeAI(activeGeminiKey);
  const modelCandidates = geminiModelCandidates();

  const systemInstruction = `You are an exact bilingual Urdu/English meeting transcriber. Your ONLY job is to preserve the meeting conversation and create faithful transcripts. You do NOT summarize, paraphrase, rewrite, invent, or add content.

MANDATORY RULES — VIOLATING ANY IS UNACCEPTABLE:

1. STRICTLY EXCLUDE ALL SPEAKER NAMES:
   - Do NOT include any speaker names, labels, or tags anywhere in the output (e.g. do NOT output "[Speaker Name]:", "[Speaker]:", "[Person]:", "[You]:", or name prefixes).
   - Provide clean, continuous, natural plain content without attributing who said what.

2. VERBATIM URDU TRANSCRIPT (transcript_urdu):
   - Capture the conversation in Pakistani/Indian Urdu script (اردو رسم الخط / نستعلیق), exactly as spoken.
   - Do NOT correct Urdu grammar, improve wording, paraphrase, summarize, reorder, combine, omit repetitions, or add explanation.
   - Preserve Urdish and technical words as spoken (for example UI, API, frontend, ڈیسک ٹاپ). Only add sentence breaks and punctuation where needed for readability.
   - Strictly NO speaker names or tags.

3. FAITHFUL ENGLISH TRANSCRIPT (transcript_english):
   - Translate every part of the conversation into English in the same order and with the same meaning.
   - Correct only English grammar, spelling, and punctuation. Do NOT polish, summarize, reword, make it more professional, or change the level of detail.
   - Preserve technical terms and repetitions when they were spoken.
   - Strictly NO speaker names or tags.

4. ACTION ITEMS WITHOUT NAMES:
   - Extract only real, explicit tasks and decisions discussed; never invent or infer tasks.
   - Format: "• [Specific task or decision]"
   - Strictly do NOT assign or prefix with person names (e.g. do NOT write "• [Person]: task", just write "• [Specific task]").
   - If no action items were discussed: "• No specific action items were identified."

OUTPUT JSON (strict schema, no extra keys):
{
  "transcript_urdu": "Verbatim Urdu/Urdish conversation in Urdu script without speaker names.",
  "transcript_english": "Faithful English translation with grammar corrected only, without speaker names.",
  "action_items_urdu": "Bullet list of real tasks in Urdu without person names, or empty state.",
  "action_items_english_improved": "Bullet list of real tasks in English without person names, or empty state."
}`;

  let lastError = null;
  for (const modelName of modelCandidates) {
    try {
      console.log(`[Backend Gemini] Structuring plain notes with model: ${modelName}...`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.0,
          responseMimeType: 'application/json'
        },
        systemInstruction: systemInstruction
      });

      const prompt = `Below is the meeting content transcribed from audio.
Format it into a verbatim Urdu/Urdish transcript, a faithful English translation with grammar corrected only, and bullet-point action items. Strictly exclude speaker names or tags.
Note: The spoken dialogue is Pakistani/Indian corporate/tech Urdish (software development, web, UI/UX, tech, or business). Fix any obvious phonetic speech-to-text misrecognitions (for example: "UI" or "یو آئی" should not be transcribed as "اوائی"; "desktop / screen" should not be confused with "موسیقی").
Do NOT add, remove, or alter the meaning.\n\n---\n${rawTranscript}\n---\n\nReturn JSON only.`;
      const result = await retryTransientProviderRequest(
        `[Backend Gemini] ${modelName}`,
        () => model.generateContent(prompt)
      );
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

      console.log(`[Backend Gemini] Successfully structured notes with ${modelName}.`);
      return sanitizePlainMeetingNotes(parsedData);
    } catch (err) {
      console.warn(`[Backend Gemini] Error with ${modelName}:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Content processing failed: ${lastError ? lastError.message : 'Unknown error'}`);
}

/**
 * Fallback: Process Meeting Text with Groq LLM
 */
async function processCaptionsWithGroq(rawTranscript, participants = [], clientGroqKey) {
  const activeGroqKey = clientGroqKey || process.env.GROQ_API_KEY;
  if (!activeGroqKey || activeGroqKey === 'your_groq_api_key_here') {
    throw new Error('Groq API Key is missing.');
  }

  const groq = new Groq({ apiKey: activeGroqKey });

  // Try multiple Groq models in order — free tier may not have access to all
  const groqModelCandidates = GROQ_TEXT_MODEL_CANDIDATES;

  const messages = [
    {
      role: 'system',
      content: `You are an exact bilingual Urdu/English meeting transcriber.
Return ONLY valid JSON with keys: "transcript_urdu", "transcript_english", "action_items_urdu", "action_items_english_improved".
Strictly DO NOT include any speaker names or speaker tags. Keep transcript_urdu verbatim: do not paraphrase, correct Urdu grammar, summarize, reorder, or omit details. Make transcript_english a faithful English translation; correct English grammar, spelling, and punctuation only, without polishing or changing meaning. Action items must be bullets containing only explicit tasks or decisions, without names. Spoken language is Urdu/English, NOT Arabic.`
    },
    {
      role: 'user',
      content: `Create a verbatim Urdu/Urdish transcript, a faithful English translation with grammar corrected only, and bullet-point action items from this meeting content (strictly excluding speaker names):\n\n${rawTranscript}`
    }
  ];

  let lastGroqErr = null;
  for (const model of groqModelCandidates) {
    try {
      console.log(`[Backend Groq LLM] Trying model: ${model}...`);
      const completion = await retryTransientProviderRequest(
        `[Backend Groq LLM] ${model}`,
        () => groq.chat.completions.create({
          messages,
          model,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      );
      const content = completion.choices[0]?.message?.content || '{}';
      return sanitizePlainMeetingNotes(JSON.parse(content));
    } catch (groqModelErr) {
      console.warn(`[Backend Groq LLM] Error with ${model}:`, groqModelErr.message);
      lastGroqErr = groqModelErr;
    }
  }

  throw lastGroqErr || new Error('All Groq models failed.');
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
    // Always return 500 for server-side AI errors (avoid leaking upstream HTTP codes like 400/404)
    const safeMsg = (err.message || 'An error occurred while processing meeting captions.')
      .replace(/https?:\/\/\S+/g, '[API endpoint]') // strip internal URLs from user-facing errors
      .slice(0, 300);
    return res.status(500).json({
      success: false,
      error: safeMsg
    });
  }
});

/**
 * Secondary / Legacy Endpoint: Multi-part Audio Upload (Retained for backwards compatibility)
 */
app.post(['/api/process-meeting', '/process-meeting'], upload.single('audio'), async (req, res) => {
  // M8: If captions text was posted here instead of audio, handle it inline (removed broken app._router.handle hack)
  if (req.body?.transcript || req.body?.utterances) {
    const { transcript, utterances, participants = [], geminiApiKey, groqApiKey } = req.body || {};
    const clientGeminiKey = req.headers['x-gemini-api-key'] || geminiApiKey;
    const clientGroqKey = req.headers['x-groq-api-key'] || groqApiKey;
    let formattedTranscript = typeof transcript === 'string' && transcript.trim()
      ? transcript.trim()
      : Array.isArray(utterances)
        ? utterances.map(u => `[${u.speaker || 'Participant'}]: ${u.text || ''}`).join('\n')
        : '';
    try {
      let out = null;
      try { out = await processCaptionsWithGemini(formattedTranscript, participants, clientGeminiKey); }
      catch (e) {
        if (clientGroqKey || process.env.GROQ_API_KEY) out = await processCaptionsWithGroq(formattedTranscript, participants, clientGroqKey);
        else throw e;
      }
      return res.status(200).json({ success: true, data: out });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
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
    let structuredOutput = null;
    let lastTranscriptionError = null;

    // Strategy 1: Google Gemini Direct Multimodal Audio AI (Highest fidelity for Urdu/English)
    const effectiveGeminiKey = clientGeminiKey || process.env.GEMINI_API_KEY;
    if (effectiveGeminiKey && effectiveGeminiKey !== 'your_gemini_api_key_here') {
      const genAI = new GoogleGenerativeAI(effectiveGeminiKey);
      const audioFileSize = fs.statSync(filePath).size;
      const useFileApi = audioFileSize > GEMINI_INLINE_LIMIT_BYTES;

      // Large recordings: upload once via the File API and reference by URI.
      // Small recordings: send inline as base64 (avoids upload+poll round-trip latency).
      let audioPart = null;
      let uploadedGeminiFile = null;
      if (useFileApi) {
        console.log(`[MeetScribe Audio] File is ${(audioFileSize / (1024 * 1024)).toFixed(1)}MB — uploading via Gemini File API...`);
        const fileManager = new GoogleAIFileManager(effectiveGeminiKey);
        uploadedGeminiFile = await fileManager.uploadFile(filePath, { mimeType: 'audio/webm' });
        let fileInfo = uploadedGeminiFile.file;
        while (fileInfo.state === FileState.PROCESSING) {
          await new Promise(r => setTimeout(r, 2000));
          fileInfo = await fileManager.getFile(fileInfo.name);
        }
        if (fileInfo.state === FileState.FAILED) {
          throw new Error('Gemini File API failed to process the uploaded audio.');
        }
        audioPart = { fileData: { fileUri: fileInfo.uri, mimeType: fileInfo.mimeType } };
      } else {
        const fileBuffer = fs.readFileSync(filePath);
        audioPart = { inlineData: { mimeType: 'audio/webm', data: fileBuffer.toString('base64') } };
      }

      const audioModelCandidates = geminiModelCandidates();

      const audioSystemInstruction = `You are an expert bilingual Urdu and English executive scribe.
Listen carefully to this meeting audio recording and produce a complete, verbatim Urdu/Urdish record, a faithful English translation, and concrete action items.

MEETING DOMAIN & VOCABULARY:
- Spoken language is Pakistani/Indian corporate and technical Urdu mixed with English (Urdish).
- Topics frequently include software engineering, web development, frontend, UI/UX design, mobile & desktop apps, responsive layouts, and business:
  e.g., UI, UX, responsive, mobile, desktop, screens, layout, components, buttons, dashboard, frontend, backend, APIs, bugs, features, testing, updates.
- Accurately transcribe English technical words into natural Urdu transliteration or English (e.g. "UI / یو آئی", "رسپانسو / Responsive", "ڈیسک ٹاپ / Desktop", "موبائل / Mobile", "ڈیش بورڈ / Dashboard", "اسکرین / Screen").
- Do NOT mishear tech words as unrelated Arabic or random words (e.g. do NOT confuse "desktop / screen" with "موسیقی", do NOT confuse "UI" with "اوائی").

MANDATORY RULES:
1. STRICTLY ZERO SPEAKER LABELS OR TAGS:
   - Do NOT output "[Speaker]:", "[Speaker 1]:", "[Participant]:", "[Unknown]:", "[Name]:", or ANY prefix.
   - Every paragraph must start directly with the spoken words.
   - Provide clean, continuous, natural plain content without attributing who said what.

2. VERBATIM URDU TRANSCRIPT (transcript_urdu):
   - Transcribe the entire spoken Urdu/Urdish conversation exactly as spoken in Urdu script (اردو رسم الخط / نستعلیق).
   - Do NOT correct Urdu grammar, paraphrase, polish, summarize, reorder, remove repetitions, or add information. Only add paragraph breaks and punctuation for readability.
   - Strictly NO speaker names or tags.

3. FAITHFUL ENGLISH TRANSCRIPT (transcript_english):
   - Translate every spoken part faithfully into English, in the original order.
   - Correct only English grammar, spelling, and punctuation. Do NOT make the content professional, polished, shorter, clearer, or otherwise different from what was said.
   - Retain full technical domain accuracy and all relevant detail.
   - Strictly NO speaker names or tags.

4. ACTION ITEMS WITHOUT NAMES (action_items_urdu & action_items_english_improved):
   - Extract only real, explicit tasks and decisions discussed in the audio; do not infer or invent any.
   - Format: "• [Specific task or decision]"
   - Strictly do NOT assign to or prefix with speaker/person names.
   - If no specific action items were discussed: "• No specific action items were identified."

OUTPUT JSON (strict schema, no extra keys):
{
  "transcript_urdu": "Verbatim Urdu/Urdish conversation in Urdu script without speaker names.",
  "transcript_english": "Faithful English translation with grammar corrected only, without speaker names.",
  "action_items_urdu": "Bullet list of real tasks in Urdu without person names, or empty state.",
  "action_items_english_improved": "Bullet list of real tasks in English without person names, or empty state."
}`;

      for (const modelName of audioModelCandidates) {
        try {
          console.log(`[MeetScribe Audio] Processing audio directly with Google Gemini (${modelName})...`);
          const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json'
            },
            systemInstruction: audioSystemInstruction
          });

          const result = await retryTransientProviderRequest(
            `[MeetScribe Audio] Gemini Audio (${modelName})`,
            () => model.generateContent([
              `Please listen carefully to this meeting audio recording and generate the plain bilingual meeting notes (strictly excluding speaker names) according to the system instructions. Return JSON only.`,
              audioPart
            ])
          );

          const response = await result.response;
          const responseText = (response.text() || '').trim();
          const cleanedJsonStr = responseText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          const parsedData = JSON.parse(cleanedJsonStr);
          if (parsedData && (parsedData.transcript_urdu || parsedData.transcript_english)) {
            structuredOutput = parsedData;
            console.log(`[MeetScribe Audio] Direct Gemini Audio (${modelName}) succeeded ✓`);
            break;
          }
        } catch (geminiAudioErr) {
          console.warn(`[MeetScribe Audio] Gemini Audio (${modelName}) attempt failed:`, geminiAudioErr.message);
          lastTranscriptionError = geminiAudioErr;
        }
      }

      if (uploadedGeminiFile) {
        try {
          const fileManager = new GoogleAIFileManager(effectiveGeminiKey);
          await fileManager.deleteFile(uploadedGeminiFile.file.name);
        } catch (cleanupErr) {
          console.warn('[MeetScribe Audio] Could not delete temporary Gemini file:', cleanupErr.message);
        }
      }
    }

    // Strategy 2: Groq Whisper Large v3 Fallback (if Gemini Audio failed or was unavailable)
    if (!structuredOutput) {
      let rawText = '';
      const effectiveGroqKey = clientGroqKey || process.env.GROQ_API_KEY;
      if (effectiveGroqKey && effectiveGroqKey !== 'your_groq_api_key_here') {
        try {
          console.log('[MeetScribe Audio] Falling back to Groq Whisper Large v3...');
          const groq = new Groq({ apiKey: effectiveGroqKey });
          const transcription = await retryTransientProviderRequest(
            '[MeetScribe Audio] Groq Whisper',
            () => groq.audio.transcriptions.create({
              file: fs.createReadStream(filePath),
              model: 'whisper-large-v3',
              language: 'ur',
              response_format: 'verbose_json',
              temperature: 0.0,
              prompt: 'یہ ایک تکنیکی میٹنگ کی ہائی کوالٹی اردو اور انگریزی گفتگو ہے۔ الفاظ: ٹھیک ہے، ماڈیولز، ڈیپلائمنٹ، اسپیڈ، پیجز، لوڈ، UI، UX، رسپانسو، ڈیسک ٹاپ، موبائل۔'
            })
          );
          rawText = transcription.text ? transcription.text.trim() : '';

          // Scrub common Whisper silence hallucinations
          if (rawText) {
            rawText = rawText
              .replace(/\b(Thank you for watching|Thank you very much|Thank you|Subtitles by|Amara\.org)\b[\.\!\?]?/gi, '')
              .replace(/\s+/g, ' ')
              .trim();
          }
        } catch (whisperErr) {
          console.warn('[MeetScribe Audio] Groq Whisper fallback error:', whisperErr.message);
          lastTranscriptionError = whisperErr;
        }
      }

      if (!rawText) {
        if (lastTranscriptionError && isTransientProviderError(lastTranscriptionError)) {
          throw new Error('Could not transcribe audio because Gemini and Groq could not be reached after retrying. Please check your internet connection and try this recording again.');
        }
        throw new Error('Could not transcribe audio. Please ensure your Gemini API Key or Groq API Key is configured in settings.');
      }

      // Structure Whisper raw text with Gemini (fallback to Groq LLM)
      try {
        structuredOutput = await processCaptionsWithGemini(rawText, [], clientGeminiKey);
      } catch (gemErr) {
        if (clientGroqKey || process.env.GROQ_API_KEY) {
          structuredOutput = await processCaptionsWithGroq(rawText, [], clientGroqKey);
        } else {
          throw gemErr;
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: sanitizePlainMeetingNotes(structuredOutput)
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

// Central error handler — catches Multer errors (e.g. oversized uploads) and any
// other thrown/async errors so clients always get a clean JSON response instead of
// an HTML stack trace or a hung connection.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'Audio recording exceeds the 500MB server upload limit.'
    });
  }
  console.error('[MeetScribe] Unhandled server error:', err);
  res.status(500).json({
    success: false,
    error: (err && err.message) || 'Internal server error.'
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
