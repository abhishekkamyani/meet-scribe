#!/usr/bin/env node
require('dotenv').config();
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

  // Strategy 1: Groq Whisper
  if (hasGroq) {
    try {
      console.log('⚡ Transcribing with Groq Whisper Large v3...');
      const groq = new Groq({ apiKey: groqKey });
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
        temperature: 0.0,
        prompt: 'Urdu and English corporate meeting conversation between participants.'
      });
      rawDialogue = transcription.text ? transcription.text.trim() : '';
    } catch (e) {
      console.warn('⚠️ Groq Whisper failed:', e.message);
    }
  }

  // Strategy 2: Gemini Audio
  if (!rawDialogue && hasGemini) {
    try {
      console.log('✨ Transcribing with Google Gemini Audio (gemini-2.0-flash)...');
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const fileBuffer = fs.readFileSync(audioPath);
      const base64Audio = fileBuffer.toString('base64');

      const result = await model.generateContent([
        `Please listen to this meeting audio recording and transcribe all spoken Urdu and English dialogue verbatim.
Identify and attribute distinct speakers (e.g. [Speaker 1], [Speaker 2], [Host]).
Format:
[Speaker Name]: [Spoken dialogue]`,
        {
          inlineData: {
            mimeType: 'audio/webm',
            data: base64Audio
          }
        }
      ]);
      const res = await result.response;
      rawDialogue = res.text().trim();
    } catch (e) {
      console.warn('⚠️ Gemini Audio failed:', e.message);
    }
  }

  if (!rawDialogue) {
    console.error('❌ Could not transcribe audio with configured keys.');
    process.exit(1);
  }

  console.log('📝 Structuring bilingual transcripts & action items with Gemini...');
  const genAI = new GoogleGenerativeAI(geminiKey || groqKey);
  const structModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    },
    systemInstruction: `You are a world-class bilingual executive scribe for Urdu and English (Urdish).
Convert raw dialogue into polished bilingual transcripts and action items.
Rules:
- Strict speaker attribution: [Speaker Name]: on every line of transcripts.
- Authentic Urdu script (نستعلیق / اردو رسم الخط) - NO Arabic greetings.
- English transcript must be accurate professional English translation.
- Action items: bullet points with assigned person names.
Output JSON schema:
{
  "transcript_urdu": "Full speaker-wise dialogue in Urdu script",
  "transcript_english": "Full speaker-wise dialogue translation in English",
  "action_items_urdu": "Bullet-pointed tasks with assigned person names in Urdu",
  "action_items_english_improved": "Polished business English action items"
}`
  });

  const structRes = await structModel.generateContent(
    `Here is the raw transcribed meeting dialogue:\n\n${rawDialogue}\n\nFormat into bilingual transcripts and action items adhering strictly to schema.`
  );
  const jsonText = structRes.response.text().trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  const data = JSON.parse(jsonText);
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
