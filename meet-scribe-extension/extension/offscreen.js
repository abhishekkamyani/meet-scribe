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

// Trigger download of a text file in UTF-8 using DOM Anchor in offscreen document
async function downloadTextFile(filename, content) {
  // UTF-8 BOM ensures Windows/Notepad and all text editors recognize Urdu characters correctly
  const utf8BOM = '\uFEFF';
  const blob = new Blob([utf8BOM + (content || '')], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  // Use DOM Anchor download
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Clean up blob URL after download starts
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
}

// Trigger download of a binary or blob file (e.g. WebM audio)
async function downloadBlobFile(filename, blob) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}

// Download the recorded audio AND the 4 distinct meeting notes files
async function triggerAllDownloads(data, audioBlob) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const timeSuffix = Date.now().toString().slice(-4);
  const baseName = `${timestamp}_${timeSuffix}`;
  
  console.log('[Offscreen] Initiating download of audio recording and 4 meeting output files...');

  // 1. Download the original recorded .webm audio file
  if (audioBlob && audioBlob.size > 0) {
    console.log(`[Offscreen] Downloading recorded audio (${audioBlob.size} bytes)...`);
    await downloadBlobFile(`0_meeting_audio_${baseName}.webm`, audioBlob);
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  // 2. Download the 4 structured text files
  const files = [
    { name: `1_transcript_urdu_${baseName}.txt`, content: data.transcript_urdu || '' },
    { name: `2_transcript_english_${baseName}.txt`, content: data.transcript_english || '' },
    { name: `3_action_items_urdu_${baseName}.txt`, content: data.action_items_urdu || '' },
    { name: `4_action_items_english_improved_${baseName}.txt`, content: data.action_items_english_improved || '' }
  ];

  for (const file of files) {
    await downloadTextFile(file.name, file.content);
    // Delay between downloads to ensure browser registers each file
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}

// Start tab recording with audio passthrough
async function startRecording(streamId, backendUrl) {
  currentBackendUrl = backendUrl || 'http://localhost:3000';
  recordedChunks = [];

  console.log(`[Offscreen] Starting tab capture with streamId: ${streamId}`);

  // 1. Capture tab media stream
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // 2. Audio Passthrough (Fix for the Muted Tab Trap!)
  // Route the captured stream to local speakers so user can still hear the meeting
  activeAudioContext = new AudioContext();
  const source = activeAudioContext.createMediaStreamSource(mediaStream);
  source.connect(activeAudioContext.destination);

  // 3. Initialize MediaRecorder with Opus codec in WebM container
  const options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    mediaRecorder = new MediaRecorder(mediaStream);
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
    await processAndUploadAudio();
  };

  // Start recording with 1-second timeslices
  mediaRecorder.start(1000);
  console.log('[Offscreen] MediaRecorder started successfully.');
}

// Stop recording and close streams
async function stopRecording() {
  console.log('[Offscreen] Stopping recording...');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  // Stop all audio tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }

  // Close audio context
  if (activeAudioContext && activeAudioContext.state !== 'closed') {
    await activeAudioContext.close();
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

    console.log(`[Offscreen] Sending POST request to: ${currentBackendUrl}/api/process-meeting`);
    
    // Direct fetch from offscreen document (bypasses service worker timeout!)
    const response = await fetch(`${currentBackendUrl}/api/process-meeting`, {
      method: 'POST',
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
        const timestamp = new Date().toISOString().slice(0, 10);
        await downloadBlobFile(`0_meeting_audio_${timestamp}_backup.webm`, fallbackAudio);
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
    startRecording(message.streamId, message.backendUrl)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Start recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep response channel open
  } else if (message.type === 'STOP_OFFSCREEN_RECORDING') {
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Stop recording failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
