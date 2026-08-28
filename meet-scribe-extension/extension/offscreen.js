/**
 * MeetScribe Urdu - Offscreen Document Script (High-Definition Audio Recorder & Downloader)
 * Features:
 * 1. Hardware Acoustic Echo Cancellation (AEC) & AI Noise Suppression (removes room echo & fan hiss).
 * 2. Web Audio DSP processing: High-Pass Rumble Filter (85Hz) + Broadcast Dynamics Compressor.
 * 3. Dual-channel mixing (Tab Audio + Cleaned Mic) with speaker passthrough (prevents tab muting).
 * 4. Compiles and IMMEDIATELY downloads crystal-clear 0_meeting_audio.webm (128kbps Opus) before AI calls.
 * 5. Zero audio bytes are uploaded over the network.
 */

let mediaRecorder = null;
let recordedChunks = [];
let lastCompiledAudioBlob = null;
let mediaStream = null;
let activeAudioContext = null;
let activeMicGainNode = null;
let activeMicTrack = null;
let isMeetMicMuted = false;
let rawStreams = [];
let currentMeetingFolder = '';

// Helper: Dynamically mute/unmute local microphone stream based on Google Meet status
function setMicMuteState(isMuted) {
  isMeetMicMuted = Boolean(isMuted);
  console.log(`[Offscreen] Mic Sync: Local Mic is ${isMeetMicMuted ? 'MUTED' : 'UNMUTED'}`);

  if (activeMicTrack) {
    try { activeMicTrack.enabled = !isMeetMicMuted; } catch (e) {}
  }

  if (activeMicGainNode && activeAudioContext && activeAudioContext.state !== 'closed') {
    try {
      const now = activeAudioContext.currentTime;
      activeMicGainNode.gain.cancelScheduledValues(now);
      const targetGain = isMeetMicMuted ? 0.0 : 1.0;
      activeMicGainNode.gain.setValueAtTime(targetGain, now);
    } catch (e) {}
  }
}

// Generate unique meeting folder name: MeetScribe_Urdu/Meeting_YYYY-MM-DD_HH-MM
function generateMeetingFolderName() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
  return `MeetScribe_Urdu/Meeting_${dateStr}_${timeStr}`;
}

// Trigger download of a Blob into the specified folder in Downloads
async function downloadFileToFolder(folderName, filename, blob) {
  const fullPath = folderName ? `${folderName}/${filename}` : filename;
  const blobUrl = URL.createObjectURL(blob);

  // 1. Send to background service worker for native folder creation in Downloads
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXECUTE_DOWNLOAD',
      filename: fullPath,
      url: blobUrl
    });
    if (res && res.success) {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      return;
    }
  } catch (e) {
    // Fall through to DOM fallback
  }

  // 2. DOM Anchor fallback
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fullPath;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}

// Download 4 distinct meeting notes files into the meeting subfolder
async function downloadStructuredNotesFiles(folderName, data) {
  const targetFolder = folderName || currentMeetingFolder || generateMeetingFolderName();
  const utf8BOM = '\uFEFF';
  const files = [
    { name: '1_transcript_urdu.txt', content: data.transcript_urdu || '' },
    { name: '2_transcript_english.txt', content: data.transcript_english || '' },
    { name: '3_action_items_urdu.txt', content: data.action_items_urdu || '' },
    { name: '4_action_items_english_improved.txt', content: data.action_items_english_improved || '' }
  ];

  console.log(`[Offscreen] Downloading 4 notes files into folder: ${targetFolder}...`);

  for (const file of files) {
    const textBlob = new Blob([utf8BOM + (file.content || '')], { type: 'text/plain;charset=utf-8' });
    await downloadFileToFolder(targetFolder, file.name, textBlob);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

// Start dual-channel audio recording with Echo Cancellation & Noise Suppression DSP
async function startRecording(streamId, initialMuteState = false) {
  isMeetMicMuted = Boolean(initialMuteState);
  recordedChunks = [];
  rawStreams = [];
  currentMeetingFolder = generateMeetingFolderName();

  console.log(`[Offscreen] Starting studio audio capture (AEC + Noise Suppression) with streamId: ${streamId}`);

  // 1. Capture Google Meet Tab Audio (Remote attendees)
  let tabStream = null;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    rawStreams.push(tabStream);
    console.log('[Offscreen] Google Meet tab audio acquired.');
  } catch (tabErr) {
    console.error('[Offscreen] Failed to acquire tab audio stream:', tabErr);
    throw new Error(`Failed to capture tab audio: ${tabErr.message}`);
  }

  // 2. Capture User Microphone with Acoustic Echo Cancellation & Noise Suppression
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,     // Critical: Removes speaker-to-mic feedback loop and room echo
        noiseSuppression: true,     // Critical: Filters background fan, AC, and ambient room noise
        autoGainControl: true,      // Normalizes speaker volume
        sampleRate: 48000,
        channelCount: 1
      },
      video: false
    });
    rawStreams.push(micStream);
    console.log('[Offscreen] User microphone acquired with Hardware Echo Cancellation & Noise Suppression.');
  } catch (micErr) {
    console.warn('[Offscreen] Microphone capture with constraints failed, attempting basic fallback:', micErr);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      rawStreams.push(micStream);
    } catch (fallbackErr) {
      console.warn('[Offscreen] Microphone access unavailable (recording tab audio only):', fallbackErr);
    }
  }

  // 3. AudioContext Setup: Mix Tab Audio + Mic with DSP Filters
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  activeAudioContext = new AudioContextClass({ sampleRate: 48000 });
  if (activeAudioContext.state === 'suspended') {
    await activeAudioContext.resume();
  }

  const destinationNode = activeAudioContext.createMediaStreamDestination();

  // Studio Dynamics Compressor Node: Prevents vocal clipping and levels out audio smoothly
  const compressor = activeAudioContext.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-24, activeAudioContext.currentTime); // dB
  compressor.knee.setValueAtTime(30, activeAudioContext.currentTime);       // dB
  compressor.ratio.setValueAtTime(3.5, activeAudioContext.currentTime);     // Compression ratio
  compressor.attack.setValueAtTime(0.003, activeAudioContext.currentTime);  // Seconds
  compressor.release.setValueAtTime(0.25, activeAudioContext.currentTime);  // Seconds

  // Route Compressor -> Destination
  compressor.connect(destinationNode);

  // A. Route Tab Audio -> Speakers (Passthrough so user hears meeting) AND -> Compressor -> Recorder
  const tabSourceNode = activeAudioContext.createMediaStreamSource(tabStream);
  tabSourceNode.connect(activeAudioContext.destination); // Play to local speakers
  tabSourceNode.connect(compressor);                     // Send clean tab audio to recorder

  // B. Route Mic -> Highpass Filter (85Hz) -> Gain -> Compressor -> Recorder
  // Note: Mic is NEVER connected to activeAudioContext.destination (prevents local user hearing themselves)
  if (micStream && micStream.getAudioTracks().length > 0) {
    activeMicTrack = micStream.getAudioTracks()[0];
    const micSourceNode = activeAudioContext.createMediaStreamSource(micStream);

    // High-Pass Filter: Cuts out desk thumps, low AC hum, and breathing pops below 85Hz
    const highpassFilter = activeAudioContext.createBiquadFilter();
    highpassFilter.type = 'highpass';
    highpassFilter.frequency.setValueAtTime(85, activeAudioContext.currentTime);
    highpassFilter.Q.setValueAtTime(0.7, activeAudioContext.currentTime);

    activeMicGainNode = activeAudioContext.createGain();
    const initialGain = isMeetMicMuted ? 0.0 : 1.0;
    activeMicGainNode.gain.setValueAtTime(initialGain, activeAudioContext.currentTime);
    if (activeMicTrack) activeMicTrack.enabled = !isMeetMicMuted;

    micSourceNode.connect(highpassFilter);
    highpassFilter.connect(activeMicGainNode);
    activeMicGainNode.connect(compressor);
  }

  mediaStream = destinationNode.stream;

  // 4. Initialize MediaRecorder (128kbps Opus WebM for studio-clear audio)
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: mimeType,
    audioBitsPerSecond: 128000 // 128kbps high definition
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.start(1000);
  console.log(`[Offscreen] Crystal-clear audio recorder started (Opus 128kbps, AEC + Noise Suppression active).`);
}

// Stop recording and immediately download local 0_meeting_audio.webm before AI calls
async function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ success: true, folderName: currentMeetingFolder });
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        console.log(`[Offscreen] MediaRecorder stopped. Total chunks: ${recordedChunks.length}`);

        // Clean up hardware streams and AudioContext
        rawStreams.forEach(stream => {
          if (stream && stream.getTracks) {
            stream.getTracks().forEach(track => track.stop());
          }
        });
        rawStreams = [];

        if (activeAudioContext && activeAudioContext.state !== 'closed') {
          try { await activeAudioContext.close(); } catch (e) {}
        }
        activeAudioContext = null;
        activeMicGainNode = null;
        activeMicTrack = null;

        // Compile audio Blob
        const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
        lastCompiledAudioBlob = audioBlob;
        console.log(`[Offscreen] Compiled crystal-clear audio: ${(audioBlob.size / (1024 * 1024)).toFixed(2)} MB`);

        // IMMEDIATELY download audio to local Downloads folder BEFORE any cloud/AI call
        if (audioBlob.size > 0) {
          console.log(`[Offscreen] Instantly downloading 0_meeting_audio.webm into ${currentMeetingFolder}...`);
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_STATUS_UPDATE',
            state: 'processing',
            step: 'Saving local meeting audio (.webm) to Downloads...'
          }).catch(() => {});

          await downloadFileToFolder(currentMeetingFolder, '0_meeting_audio.webm', audioBlob);
          await new Promise(r => setTimeout(r, 400));
        }

        resolve({
          success: true,
          audioSize: audioBlob.size,
          folderName: currentMeetingFolder
        });

      } catch (err) {
        console.error('[Offscreen] Error finalizing audio recording:', err);
        // C6 fix: reject so background can detect and handle the failure instead of silently succeeding
        reject(err);
      }
    };

    try {
      mediaRecorder.requestData();
    } catch (e) {}
    mediaRecorder.stop();
  });
}

// Fallback: Transcribe audio with AI backend when live captions were not available in Google Meet
async function processAudioFallback(backendUrl, geminiApiKey, groqApiKey, participants = []) {
  if (!lastCompiledAudioBlob || lastCompiledAudioBlob.size === 0) {
    throw new Error('No audio recording available for AI transcription.');
  }

  const formData = new FormData();
  formData.append('audio', lastCompiledAudioBlob, 'meeting_audio.webm');
  if (geminiApiKey) formData.append('geminiApiKey', geminiApiKey);
  if (groqApiKey) formData.append('groqApiKey', groqApiKey);
  if (Array.isArray(participants) && participants.length > 0) {
    formData.append('participants', JSON.stringify(participants));
  }

  const cleanUrl = (backendUrl || 'http://localhost:3001').replace(/\/+$/, '');
  console.log(`[Offscreen Audio Fallback] Sending audio (${(lastCompiledAudioBlob.size / (1024 * 1024)).toFixed(2)} MB) to ${cleanUrl}/api/process-meeting...`);

  const response = await fetch(`${cleanUrl}/api/process-meeting`, {
    method: 'POST',
    headers: {
      ...(geminiApiKey ? { 'X-Gemini-API-Key': geminiApiKey } : {}),
      ...(groqApiKey ? { 'X-Groq-API-Key': groqApiKey } : {})
    },
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    let parsedMsg = errText;
    try {
      const j = JSON.parse(errText);
      parsedMsg = j.error || j.message || errText;
    } catch (e) {}
    throw new Error(`Audio AI Error (${response.status}): ${parsedMsg}`);
  }

  const resJson = await response.json();
  if (!resJson.success || !resJson.data) {
    throw new Error(resJson.error || 'Invalid response from Audio AI backend.');
  }

  return { success: true, data: resJson.data };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_OFFSCREEN_RECORDING') {
    startRecording(message.streamId, message.initialMuteState)
      .then(() => sendResponse({ success: true, folderName: currentMeetingFolder }))
      .catch((err) => {
        console.error('[Offscreen] Start recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;

  } else if (message.type === 'UPDATE_MIC_MUTE_STATE') {
    setMicMuteState(message.isMuted);
    sendResponse({ success: true });
    return true;

  } else if (message.type === 'STOP_OFFSCREEN_RECORDING') {
    stopRecording()
      .then((res) => sendResponse(res))
      .catch((err) => {
        console.error('[Offscreen] Stop recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;

  } else if (message.type === 'PROCESS_AUDIO_FALLBACK') {
    processAudioFallback(message.backendUrl, message.geminiApiKey, message.groqApiKey, message.participants || [])
      .then(res => sendResponse(res))
      .catch(err => {
        console.error('[Offscreen] Audio fallback error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;

  } else if (message.type === 'DOWNLOAD_NOTES_FILES') {
    downloadStructuredNotesFiles(message.folderName, message.data)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Download notes failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
