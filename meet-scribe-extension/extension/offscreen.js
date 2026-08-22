/**
 * MeetScribe Urdu - Offscreen Document Script
 * Captures tab audio stream, routes audio to speakers (preventing tab muting),
 * records WebM audio, directly uploads to backend, and triggers 4 file downloads.
 * 
 * Note: Offscreen documents have no direct access to chrome.storage or chrome.downloads.
 * DOM APIs (<a> download, Web Audio, fetch, MediaRecorder) and chrome.runtime messaging are used.
 */

let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let activeAudioContext = null;
let currentBackendUrl = 'http://localhost:3000';
let userGroqApiKey = '';
let userGeminiApiKey = '';
let activeParticipants = [];

// Trigger download into a specific folder in Downloads
async function downloadFileToFolder(folderName, filename, blob) {
  const fullPath = folderName ? `${folderName}/${filename}` : filename;
  const blobUrl = URL.createObjectURL(blob);

  // 1. Try sending to background service worker for native folder creation in Downloads
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

// Download the recorded audio AND the 4 distinct meeting notes files into a dedicated subfolder
async function triggerAllDownloads(data, audioBlob) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
  const folderName = `MeetScribe_Urdu/Meeting_${dateStr}_${timeStr}`;

  console.log(`[Offscreen] Initiating download of audio and notes into folder: ${folderName}...`);

  // 1. Download the original recorded .webm audio file into folder
  if (audioBlob && audioBlob.size > 0) {
    console.log(`[Offscreen] Downloading recorded audio into ${folderName}/0_meeting_audio.webm...`);
    await downloadFileToFolder(folderName, '0_meeting_audio.webm', audioBlob);
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  // 2. Download the 4 structured text files into folder
  const utf8BOM = '\uFEFF';
  const files = [
    { name: '1_transcript_urdu.txt', content: data.transcript_urdu || '' },
    { name: '2_transcript_english.txt', content: data.transcript_english || '' },
    { name: '3_action_items_urdu.txt', content: data.action_items_urdu || '' },
    { name: '4_action_items_english_improved.txt', content: data.action_items_english_improved || '' }
  ];

  for (const file of files) {
    const textBlob = new Blob([utf8BOM + (file.content || '')], { type: 'text/plain;charset=utf-8' });
    await downloadFileToFolder(folderName, file.name, textBlob);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

let rawStreams = [];

// Start tab recording with dual-channel (Tab Audio + User Microphone) mixing and audio passthrough
async function startRecording(streamId, backendUrl, groqKey, geminiKey) {
  currentBackendUrl = backendUrl || 'https://meet-scribe-five.vercel.app';
  userGroqApiKey = groqKey || '';
  userGeminiApiKey = geminiKey || '';
  recordedChunks = [];
  rawStreams = [];

  console.log(`[Offscreen] Starting mixed audio capture (Tab + Mic) with streamId: ${streamId}`);

  // 1. Capture Google Meet Tab Audio (Remote participants)
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
    console.log('[Offscreen] Google Meet tab audio stream acquired.');
  } catch (tabErr) {
    console.error('[Offscreen] Failed to acquire tab audio stream:', tabErr);
    throw new Error(`Failed to capture tab audio: ${tabErr.message}`);
  }

  // 2. Capture User's Microphone (Current user speaking)
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
    rawStreams.push(micStream);
    console.log('[Offscreen] User microphone stream acquired with high fidelity.');
  } catch (micErr) {
    console.warn('[Offscreen] Microphone not accessible, proceeding with tab audio only:', micErr);
  }

  // 3. Setup AudioContext Mixer
  activeAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (activeAudioContext.state === 'suspended') {
    await activeAudioContext.resume();
  }

  const mixerDestination = activeAudioContext.createMediaStreamDestination();

  // Connect Tab Audio to Mixer (for recording) AND to Speakers (so user hears other attendees)
  if (tabStream && tabStream.getAudioTracks().length > 0) {
    const tabSource = activeAudioContext.createMediaStreamSource(tabStream);
    tabSource.connect(mixerDestination);
    tabSource.connect(activeAudioContext.destination);
  }

  // Connect Mic Audio to Mixer ONLY with Gain Boost (do NOT connect to speakers to avoid echo)
  if (micStream && micStream.getAudioTracks().length > 0) {
    const micSource = activeAudioContext.createMediaStreamSource(micStream);
    const micGain = activeAudioContext.createGain();
    micGain.gain.value = 1.3;
    micSource.connect(micGain);
    micGain.connect(mixerDestination);
  }

  // 4. Initialize MediaRecorder on the combined mixed stream
  mediaStream = mixerDestination.stream;

  const options = {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 64000 // 64kbps Opus: broadcast-grade voice quality + ultra-efficient file size for 2+ hour meetings
  };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    mediaRecorder = new MediaRecorder(mediaStream, { audioBitsPerSecond: 64000 });
  } else {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    console.log(`[Offscreen] MediaRecorder stopped. Total chunks: ${recordedChunks.length}`);
    // Clean up audio graph only after all chunks are received
    cleanUpAudioStreams();
    await processAndUploadAudio();
  };

  // Start recording with 1-second timeslices
  mediaRecorder.start(1000);
  console.log('[Offscreen] Dual-channel recording (Tab Audio + User Mic) active.');
}

// Clean up audio streams and context
function cleanUpAudioStreams() {
  console.log('[Offscreen] Cleaning up audio tracks and audio context...');
  if (rawStreams && rawStreams.length > 0) {
    rawStreams.forEach(stream => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    });
    rawStreams = [];
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (activeAudioContext && activeAudioContext.state !== 'closed') {
    activeAudioContext.close().catch(() => {});
    activeAudioContext = null;
  }
}

// Stop recording safely
async function stopRecording() {
  console.log('[Offscreen] Stopping recording...');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.requestData();
    } catch (e) {}
    mediaRecorder.stop();
  } else {
    cleanUpAudioStreams();
  }
}

// Upload recorded WebM to Express backend directly
async function processAndUploadAudio() {
  try {
    const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
    console.log(`[Offscreen] Prepared audio blob of size: ${audioBlob.size} bytes`);

    if (audioBlob.size === 0) {
      throw new Error('No audio data was recorded. Please ensure the Google Meet tab was playing audio.');
    }

    // Notify background/popup of processing step
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STATUS_UPDATE',
      state: 'processing',
      step: 'Uploading audio to MeetScribe backend...'
    }).catch(() => {});

    const formData = new FormData();
    formData.append('audio', audioBlob, 'meeting-audio.webm');
    if (userGroqApiKey) formData.append('groqApiKey', userGroqApiKey);
    if (userGeminiApiKey) formData.append('geminiApiKey', userGeminiApiKey);
    if (activeParticipants && activeParticipants.length > 0) {
      formData.append('participants', JSON.stringify(activeParticipants));
    }

    const headers = {};
    if (userGroqApiKey) headers['X-Groq-API-Key'] = userGroqApiKey;
    if (userGeminiApiKey) headers['X-Gemini-API-Key'] = userGeminiApiKey;

    console.log(`[Offscreen] Sending POST request to: ${currentBackendUrl}/api/process-meeting (with participants: ${activeParticipants.join(', ') || 'inferred'})`);
    
    // Direct fetch from offscreen document (bypasses service worker timeout!)
    const response = await fetch(`${currentBackendUrl}/api/process-meeting`, {
      method: 'POST',
      headers: headers,
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      let parsedErr = errText;
      try {
        const jsonErr = JSON.parse(errText);
        parsedErr = jsonErr.error || errText;
      } catch (e) {}
      throw new Error(`Server error (${response.status}): ${parsedErr}`);
    }

    const result = await response.json();
    console.log('[Offscreen] Processing response received from backend:', result);

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Backend failed to process meeting notes.');
    }

    // Trigger automatic download of the recorded audio and the 4 text files
    await triggerAllDownloads(result.data, audioBlob);

    // Notify service worker to save results in chrome.storage.local
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STATUS_UPDATE',
      state: 'complete',
      data: result.data
    }).catch(() => {});

  } catch (err) {
    console.error('[Offscreen] Error during audio processing/upload:', err);

    // Fallback: Ensure recorded audio is still saved to user's disk even if backend processing failed
    try {
      const fallbackAudio = new Blob(recordedChunks, { type: 'audio/webm' });
      if (fallbackAudio && fallbackAudio.size > 0) {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const folderName = `MeetScribe_Urdu/Backup_${dateStr}`;
        await downloadFileToFolder(folderName, '0_meeting_audio_backup.webm', fallbackAudio);
      }
    } catch (saveErr) {
      console.warn('[Offscreen] Could not save fallback audio:', saveErr);
    }

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STATUS_UPDATE',
      state: 'error',
      error: err.message || 'An error occurred during audio processing.'
    }).catch(() => {});
  }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_OFFSCREEN_RECORDING') {
    startRecording(message.streamId, message.backendUrl, message.groqApiKey, message.geminiApiKey)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Start recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep response channel open
  } else if (message.type === 'STOP_OFFSCREEN_RECORDING') {
    activeParticipants = message.participants || [];
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Stop recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
