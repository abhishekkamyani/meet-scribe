require('dotenv').config(); // C8 fix: load .env before anything else so GEMINI_API_KEY / GROQ_API_KEY are available locally
const crypto = require('crypto');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
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
// must go through the File API (upload once, reference by URI). Keep this close to
// that real ceiling so we avoid the extra File API upload+poll round trip (and its
// own failure mode) whenever we don't strictly need it.
const GEMINI_INLINE_LIMIT_BYTES = 19 * 1024 * 1024;
// In-memory store for background audio-transcription jobs: jobId -> { status, data?, error?, createdAt }
const audioJobs = new Map();
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const GROQ_TEXT_MODEL_CANDIDATES = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768'
];

function normalizeApiKey(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';
  if (/your_(gemini|groq)_api_key_here|replace_me|changeme|demo_key|dummy_key|example_key/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function geminiModelCandidates() {
  return [...new Set([
    process.env.GEMINI_MODEL,
    DEFAULT_GEMINI_MODEL,
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ].filter(Boolean))];
}

function isQuotaExceededError(error) {
  const message = String(error?.message || error).toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  return status === 429 && /quota exceeded|free tier|rate limit|current quota|too many requests/i.test(message);
}

function isTransientProviderError(error) {
  const message = String(error?.message || error).toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (isQuotaExceededError(error)) {
    return false;
  }
  if (status === 404 || /not found|is not supported|invalid model|unsupported model/i.test(message)) {
    return false;
  }
  return status === 408 || status === 429 || status >= 500 ||
    /fetch failed|connection error|econnreset|etimedout|enotfound|socket hang up|network error/.test(message);
}

async function retryTransientProviderRequest(label, request, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isTransientProviderError(error) || attempt === attempts) break;
      const delayMs = Math.min(1000, attempt * 500);
      console.warn(`${label} failed due to a temporary connection error; retrying in ${delayMs / 1000}s (${attempt}/${attempts - 1})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// Gemini's JSON mode occasionally appends trailing content (e.g. a repeated/partial
// object) after a complete, valid JSON object on long audio responses. Rather than
// letting JSON.parse choke on the trailing bytes, extract just the first balanced
// top-level {...} object and parse that.
function parseFirstJsonObject(text) {
  const source = String(text || '').trim();
  const start = source.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model response.');

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let completedObjectEnd = -1;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        completedObjectEnd = i;
        const candidate = source.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (candidateErr) {
          // The model may have returned a valid prefix followed by truncated text.
          // Keep walking to the last complete closing brace that still parses.
        }
      }
    }
  }

  for (let end = source.length - 1; end > start; end--) {
    const candidate = source.slice(start, end + 1);
    if (!candidate.includes('{') || !candidate.includes('}')) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try shorter prefixes until we find a parseable JSON object.
    }
  }

  throw new Error('Unterminated JSON object in model response.');
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
    uploadPage: '/upload',
    processCaptions: '/api/process-captions',
    processMeeting: '/api/process-meeting'
  });
});

// Interactive Web Page for Manual Recording Audio Processing
app.get('/upload', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeetScribe Urdu - Manual Audio Reprocessing</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --subtext: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --accent: #10b981;
      --border: #334155;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 800px;
      width: 100%;
    }
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .header h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    .header p {
      color: var(--subtext);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .drop-zone {
      border: 2px dashed var(--primary);
      border-radius: 8px;
      padding: 2.5rem;
      text-align: center;
      cursor: pointer;
      transition: background 0.2s;
    }
    .drop-zone:hover {
      background: rgba(59, 130, 246, 0.05);
    }
    .drop-zone p {
      margin: 0.5rem 0 0;
      color: var(--subtext);
    }
    input[type="file"] {
      display: none;
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      margin-top: 1rem;
      font-size: 1rem;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-group label {
      display: block;
      font-size: 0.875rem;
      margin-bottom: 0.25rem;
      color: var(--subtext);
    }
    .form-group input {
      width: 100%;
      padding: 0.5rem;
      background: #0f172a;
      border: 1px solid var(--border);
      color: white;
      border-radius: 6px;
      box-sizing: border-box;
    }
    .status-box {
      margin-top: 1rem;
      padding: 1rem;
      border-radius: 6px;
      display: none;
    }
    .status-loading { background: rgba(59, 130, 246, 0.1); color: var(--primary); border: 1px solid var(--primary); }
    .status-success { background: rgba(16, 185, 129, 0.1); color: var(--accent); border: 1px solid var(--accent); }
    .status-error { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid #ef4444; }
    .results-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-top: 1rem;
    }
    .result-box {
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
    }
    .result-box h3 {
      margin-top: 0;
      font-size: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 0.875rem;
      max-height: 200px;
      overflow-y: auto;
      color: var(--subtext);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎙️ MeetScribe Urdu Audio Reprocessor</h1>
      <p>Upload any meeting recording (.webm, .mp3, .wav, .m4a) to generate transcripts &amp; action items</p>
    </div>

    <div class="card">
      <div class="form-group">
        <label>Google Gemini API Key (Optional override if not set in server .env):</label>
        <input type="password" id="geminiKey" placeholder="AIzaSy...">
      </div>
      
      <div class="drop-zone" id="dropZone" onclick="document.getElementById('audioInput').click()">
        <div style="font-size: 2rem;">📂</div>
        <strong id="fileLabel">Click to select audio recording file or drag &amp; drop here</strong>
        <p>Supports 0_meeting_audio.webm or any WebM / MP3 / WAV file</p>
      </div>
      <input type="file" id="audioInput" accept="audio/*,.webm,.mp3,.wav,.m4a,.ogg">

      <button id="processBtn" class="btn" disabled>Upload &amp; Process Audio</button>
      
      <div id="statusBox" class="status-box"></div>
    </div>

    <div id="resultsCard" class="card" style="display: none;">
      <h2>🎉 Transcripts &amp; Action Items Generated</h2>
      <div class="results-grid">
        <div class="result-box">
          <h3>Urdu Transcript <button onclick="downloadText('1_transcript_urdu.txt', document.getElementById('urTrans').textContent)">💾</button></h3>
          <pre id="urTrans"></pre>
        </div>
        <div class="result-box">
          <h3>English Transcript <button onclick="downloadText('2_transcript_english.txt', document.getElementById('enTrans').textContent)">💾</button></h3>
          <pre id="enTrans"></pre>
        </div>
        <div class="result-box">
          <h3>Urdu Action Items <button onclick="downloadText('3_action_items_urdu.txt', document.getElementById('urAct').textContent)">💾</button></h3>
          <pre id="urAct"></pre>
        </div>
        <div class="result-box">
          <h3>English Action Items <button onclick="downloadText('4_action_items_english_improved.txt', document.getElementById('enAct').textContent)">💾</button></h3>
          <pre id="enAct"></pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    const audioInput = document.getElementById('audioInput');
    const dropZone = document.getElementById('dropZone');
    const fileLabel = document.getElementById('fileLabel');
    const processBtn = document.getElementById('processBtn');
    const statusBox = document.getElementById('statusBox');
    const resultsCard = document.getElementById('resultsCard');
    let selectedFile = null;

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.background = 'rgba(59, 130, 246, 0.1)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.background = 'transparent'; });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.background = 'transparent';
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    audioInput.addEventListener('change', (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
      selectedFile = file;
      fileLabel.textContent = 'Selected: ' + file.name + ' (' + (file.size / (1024 * 1024)).toFixed(2) + ' MB)';
      processBtn.disabled = false;
    }

    processBtn.addEventListener('click', async () => {
      if (!selectedFile) return;
      processBtn.disabled = true;
      statusBox.className = 'status-box status-loading';
      statusBox.style.display = 'block';
      statusBox.textContent = '⏳ Uploading audio & generating notes with Gemini AI... Please wait.';
      resultsCard.style.display = 'none';

      const formData = new FormData();
      formData.append('audio', selectedFile);
      const key = document.getElementById('geminiKey').value.trim();
      if (key) formData.append('geminiApiKey', key);

      try {
        const res = await fetch('/api/process-meeting', {
          method: 'POST',
          headers: key ? { 'X-Gemini-API-Key': key } : {},
          body: formData
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || 'Processing failed');

        statusBox.className = 'status-box status-success';
        statusBox.textContent = '✓ Meeting notes generated successfully!';
        resultsCard.style.display = 'block';

        document.getElementById('urTrans').textContent = json.data.transcript_urdu || '';
        document.getElementById('enTrans').textContent = json.data.transcript_english || '';
        document.getElementById('urAct').textContent = json.data.action_items_urdu || '';
        document.getElementById('enAct').textContent = json.data.action_items_english_improved || '';
      } catch (err) {
        statusBox.className = 'status-box status-error';
        statusBox.textContent = '✕ Error: ' + err.message;
      } finally {
        processBtn.disabled = false;
      }
    });

    function downloadText(filename, text) {
      const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
    }
  </script>
</body>
</html>`;
  res.send(html);
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
  const fallbackEnglish = 'No English transcript captured for this recording.';
  const fallbackUrduAction = '• کوئی مخصوص ایکشن آئٹمز نہیں ملے۔';
  const fallbackEnglishAction = '• No specific action items were identified.';

  return {
    transcript_urdu: stripSpeakerTags(data.transcript_urdu || ''),
    transcript_english: stripSpeakerTags(data.transcript_english || fallbackEnglish),
    action_items_urdu: stripSpeakerTags(data.action_items_urdu || fallbackUrduAction),
    action_items_english_improved: stripSpeakerTags(data.action_items_english_improved || fallbackEnglishAction)
  };
}

/**
 * Helper: Structure and Translate Meeting Text with Google Gemini
 * Generates plain bilingual transcripts and action items without any speaker names.
 */
async function processCaptionsWithGemini(rawTranscript, participants = [], clientGeminiKey) {
  const activeGeminiKey = normalizeApiKey(clientGeminiKey || process.env.GEMINI_API_KEY);
  if (!activeGeminiKey) {
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
          responseMimeType: 'application/json',
          maxOutputTokens: 20000
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

      const parsedData = parseFirstJsonObject(cleanedJsonStr);
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
  const activeGroqKey = normalizeApiKey(clientGroqKey || process.env.GROQ_API_KEY);
  if (!activeGroqKey) {
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
  const clientGeminiKey = normalizeApiKey(req.headers['x-gemini-api-key'] || geminiApiKey);
  const clientGroqKey = normalizeApiKey(req.headers['x-groq-api-key'] || groqApiKey);

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

  // Long recordings can take minutes to transcribe — respond immediately with a job id
  // so the client isn't stuck holding one long HTTP connection open, then process in
  // the background and let the client poll /api/job-status/:jobId for the result.
  const jobId = crypto.randomUUID();
  audioJobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  res.status(202).json({ success: true, jobId, status: 'processing' });

  runAudioTranscriptionPipeline(filePath, clientGeminiKey, clientGroqKey)
    .then((structuredOutput) => {
      audioJobs.set(jobId, { status: 'done', data: sanitizePlainMeetingNotes(structuredOutput), createdAt: Date.now() });
    })
    .catch((err) => {
      console.error('[MeetScribe Audio Error]:', err, err.cause ? `\nCause: ${err.cause}` : '');
      audioJobs.set(jobId, { status: 'error', error: err.message || 'Audio processing failed.', createdAt: Date.now() });
    })
    .finally(() => {
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      // Keep the result around long enough for the client to poll it, then reclaim memory.
      setTimeout(() => audioJobs.delete(jobId), 30 * 60 * 1000).unref();
    });
});

app.get('/api/job-status/:jobId', (req, res) => {
  const job = audioJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or has expired.' });
  }
  return res.status(200).json({ success: true, ...job });
});

async function runAudioTranscriptionPipeline(filePath, clientGeminiKey, clientGroqKey) {
    let structuredOutput = null;
    let lastTranscriptionError = null;

    const effectiveGeminiKey = normalizeApiKey(clientGeminiKey || process.env.GEMINI_API_KEY);
    const effectiveGroqKey = normalizeApiKey(clientGroqKey || process.env.GROQ_API_KEY);

    if (!effectiveGeminiKey && !effectiveGroqKey) {
      throw new Error('No API keys configured. Please save your Gemini or Groq key in the extension settings before recording.');
    }

    // Strategy 1: Google Gemini Direct Multimodal Audio AI (Highest fidelity for Urdu/English)
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
        uploadedGeminiFile = await retryTransientProviderRequest(
          '[MeetScribe Audio] Gemini File API upload',
          () => fileManager.uploadFile(filePath, { mimeType: 'audio/webm' })
        );
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
              responseMimeType: 'application/json',
              maxOutputTokens: 20000
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
          const finishReason = response.candidates?.[0]?.finishReason;
          if (finishReason === 'MAX_TOKENS') {
            console.warn(`[MeetScribe Audio] Gemini Audio (${modelName}) hit maxOutputTokens — response was truncated.`);
          }
          const responseText = (response.text() || '').trim();
          const cleanedJsonStr = responseText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          const parsedData = parseFirstJsonObject(cleanedJsonStr);
          const requiredKeys = ['transcript_urdu', 'transcript_english', 'action_items_urdu', 'action_items_english_improved'];
          requiredKeys.forEach((key) => {
            if (!parsedData[key]) {
              parsedData[key] = key === 'transcript_english' ? 'No English transcript captured for this recording.'
                : key === 'action_items_urdu' ? '• کوئی مخصوص ایکشن آئٹمز نہیں ملے۔'
                : key === 'action_items_english_improved' ? '• No specific action items were identified.'
                : '';
            }
          });

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

    return structuredOutput;
}

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
