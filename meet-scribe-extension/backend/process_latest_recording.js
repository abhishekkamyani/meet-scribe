#!/usr/bin/env node
require('dotenv').config();
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
const fs = require('fs');
const path = require('path');
const os = require('os');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function processLatestRecording() {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  const hasGemini = geminiKey && geminiKey !== 'your_gemini_api_key_here';
  const hasGroq = groqKey && groqKey !== 'your_groq_api_key_here';

  if (!hasGemini && !hasGroq) {
    console.error('\n❌ ERROR: No API Key found in backend/.env');
    console.error('Please add your GEMINI_API_KEY or GROQ_API_KEY to backend/.env and run again.\n');
    process.exit(1);
  }

  // 1. Locate audio file
  let audioPath = process.argv[2];
  if (!audioPath) {
    const baseDir = path.join(os.homedir(), 'Downloads', 'MeetScribe_Urdu');
    if (!fs.existsSync(baseDir)) {
      console.error(`❌ Could not find MeetScribe folder at ${baseDir}`);
      process.exit(1);
    }

    const folders = fs.readdirSync(baseDir)
      .filter(f => f.startsWith('Meeting_'))
      .map(f => path.join(baseDir, f))
      .filter(f => fs.statSync(f).isDirectory())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    if (folders.length === 0) {
      console.error('❌ No meeting folders found in Downloads/MeetScribe_Urdu');
      process.exit(1);
    }

    const latestFolder = folders[0];
    audioPath = path.join(latestFolder, '0_meeting_audio.webm');
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`❌ Audio file not found at: ${audioPath}`);
    process.exit(1);
  }

  const meetingDir = path.dirname(audioPath);
  const fileSizeMB = (fs.statSync(audioPath).size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎙️ Processing meeting audio: ${audioPath} (${fileSizeMB} MB)`);

  let rawDialogue = '';

  // Strategy 1: Gemini Audio (Native Urdu speech, ML technical vocabulary, acoustic diarization)
  if (hasGemini) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const fileBuffer = fs.readFileSync(audioPath);
    const base64Audio = fileBuffer.toString('base64');
    const audioModels = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.0-flash', 'gemini-2.5-flash'].filter(Boolean))];

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

    for (const modelName of audioModels) {
      try {
        console.log(`✨ Transcribing with Google Gemini Audio (${modelName})...`);
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: `You are an expert bilingual speech-to-text transcriber for Pakistani/Indian Urdu and English (Urdish).
Listen to the audio recording and transcribe all spoken content verbatim.
Strict rules:
1. Strictly DO NOT include any speaker names, labels, or tags (no [Speaker]:, [Speaker 1]:, etc.). Provide plain continuous dialogue.
2. Accurately transcribe modern software, web development, UI/UX, and technical terms in natural script or English:
   - UI, UX, responsive, mobile, desktop, screens, frontend, backend, layout, components, CSS, buttons, dashboard, API, bugs.
   - Machine learning: SimpleImputer, Pipeline, ColumnTransformer, Cross Validation, mean, null values.
3. Preserve authentic Urdu grammar and natural paragraph breaks.`
        });
        const result = await model.generateContent([
          `Please listen carefully to this meeting audio recording and transcribe all spoken Urdu and English dialogue verbatim.
Strictly do NOT include any speaker names, labels, or speaker tags.
Preserve all technical vocabulary (UI, UX, responsive, mobile, desktop, layout, components, SimpleImputer, Pipeline, etc.) accurately.
Format the output as clean, continuous, natural plain text with clear paragraph breaks.`,
          {
            inlineData: {
              mimeType: 'audio/webm',
              data: base64Audio
            }
          }
        ]);
        const res = await result.response;
        rawDialogue = stripSpeakerTags((res.text() || '').trim());
        if (rawDialogue) {
          console.log(`✨ Gemini Audio (${modelName}) succeeded ✓`);
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Gemini Audio (${modelName}) failed:`, e.message);
      }
    }
  }

  // Strategy 2: Groq Whisper Fallback (if Gemini Audio was unavailable)
  if (!rawDialogue && hasGroq) {
    try {
      console.log('⚡ Falling back to Groq Whisper Large v3...');
      const groq = new Groq({ apiKey: groqKey });
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-large-v3',
        language: 'ur',
        response_format: 'verbose_json',
        temperature: 0.0,
        prompt: 'یہ ایک تکنیکی میٹنگ کی ہائی کوالٹی اردو اور انگریزی گفتگو ہے۔ الفاظ: ٹھیک ہے، ماڈیولز، ڈیپلائمنٹ، اسپیڈ، پیجز، لوڈ، UI، UX، رسپانسو، ڈیسک ٹاپ، موبائل۔'
      });
      rawDialogue = transcription.text ? transcription.text.trim() : '';
      if (rawDialogue) {
        rawDialogue = stripSpeakerTags(rawDialogue
          .replace(/\b(Thank you for watching|Thank you very much|Thank you|Subtitles by|Amara\.org)\b[\.\!\?]?/gi, '')
          .replace(/\s+/g, ' ')
          .trim());
      }
    } catch (e) {
      console.warn('⚠️ Groq Whisper failed:', e.message);
    }
  }

  if (!rawDialogue) {
    console.error('❌ Could not transcribe audio with configured keys.');
    process.exit(1);
  }

  console.log('📝 Structuring plain bilingual transcripts & action items with Gemini...');
  let jsonText = '';

  if (hasGemini) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const structModels = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.0-flash', 'gemini-2.5-flash'].filter(Boolean))];

    for (const modelName of structModels) {
      try {
        const structModel = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          },
          systemInstruction: `You are an exact bilingual Urdu/English meeting transcriber.
Convert raw dialogue into a verbatim Urdu/Urdish transcript, a faithful English translation, and action items.
Rules:
- Strictly NO speaker names, labels, or tags anywhere in the output.
- transcript_urdu must preserve what was said exactly: do not correct Urdu grammar, paraphrase, polish, summarize, reorder, or omit repetitions. Only add punctuation and paragraph breaks.
- Preserve UI/UX, web, software, and data technical vocabulary accurately (UI, responsive, mobile, desktop, layout, components).
- transcript_english must be a faithful English translation in the original order. Correct English grammar, spelling, and punctuation only; do not polish or change the meaning or detail.
- Action items must be bullet points containing only explicit tasks/decisions, without person names or assignments.
Output JSON schema:
{
  "transcript_urdu": "Verbatim Urdu/Urdish dialogue in Urdu script without speaker names",
  "transcript_english": "Faithful English translation with grammar corrected only, without speaker names",
  "action_items_urdu": "Bullet-pointed tasks in Urdu without person names",
  "action_items_english_improved": "Bullet-pointed explicit tasks and decisions in English without person names"
}`
        });

        const structRes = await structModel.generateContent(
          `Here is the raw transcribed meeting dialogue:\n\n${rawDialogue}\n\nCreate a verbatim Urdu/Urdish transcript, a faithful English translation with grammar corrected only, and bullet-point action items. Strictly exclude speaker names and follow the schema.`
        );
        jsonText = structRes.response.text().trim()
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '');
        if (jsonText) break;
      } catch (e) {
        console.warn(`⚠️ Structuring with ${modelName} failed:`, e.message);
      }
    }
  }

  // Fallback to Groq LLM if Gemini failed
  if (!jsonText && hasGroq) {
    try {
      console.log('⚡ Structuring with Groq LLaMA models...');
      const groq = new Groq({ apiKey: groqKey });
      const groqCandidates = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768'];
      for (const model of groqCandidates) {
        try {
          console.log(`⚡ Trying Groq model: ${model}...`);
          const completion = await groq.chat.completions.create({
            model,
            messages: [
              {
                role: 'system',
                content: `You are an exact bilingual Urdu/English meeting transcriber.
Return a verbatim Urdu/Urdish transcript: do not correct Urdu grammar, paraphrase, polish, summarize, reorder, or omit detail. Return a faithful English translation in the original order: correct English grammar, spelling, and punctuation only, without polishing or changing meaning. Action items must be bullet points containing only explicit tasks or decisions, without names.
Schema:
{
  "transcript_urdu": "string",
  "transcript_english": "string",
  "action_items_urdu": "string",
  "action_items_english_improved": "string"
}`
              },
              {
                role: 'user',
                content: `Meeting dialogue:\n${rawDialogue}\nOutput valid JSON without markdown wrapping.`
              }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
          });
          jsonText = completion.choices[0]?.message?.content?.trim();
          if (jsonText) break;
        } catch (mErr) {
          console.warn(`⚠️ Groq model ${model} failed:`, mErr.message);
        }
      }
    } catch (e) {
      console.warn('⚠️ Groq structuring failed:', e.message);
    }
  }

  if (!jsonText) {
    throw new Error('Failed to structure notes with available AI models.');
  }

  const rawParsed = JSON.parse(jsonText);
  const data = sanitizePlainMeetingNotes(rawParsed);
  const utf8BOM = '\uFEFF';

  fs.writeFileSync(path.join(meetingDir, '1_transcript_urdu.txt'), utf8BOM + (data.transcript_urdu || ''), 'utf8');
  fs.writeFileSync(path.join(meetingDir, '2_transcript_english.txt'), utf8BOM + (data.transcript_english || ''), 'utf8');
  fs.writeFileSync(path.join(meetingDir, '3_action_items_urdu.txt'), utf8BOM + (data.action_items_urdu || ''), 'utf8');
  fs.writeFileSync(path.join(meetingDir, '4_action_items_english_improved.txt'), utf8BOM + (data.action_items_english_improved || ''), 'utf8');

  console.log(`\n🎉 Success! Transcripts and action items saved to:\n📁 ${meetingDir}\n`);
  console.log('Files updated:');
  console.log(' - 1_transcript_urdu.txt');
  console.log(' - 2_transcript_english.txt');
  console.log(' - 3_action_items_urdu.txt');
  console.log(' - 4_action_items_english_improved.txt\n');
}

processLatestRecording().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
