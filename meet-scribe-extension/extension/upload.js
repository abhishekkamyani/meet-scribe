/**
 * MeetScribe Urdu - Upload & Reprocess Controller
 * Runs inside dedicated extension tab (upload.html) for 100% reliable file selection without popup auto-close.
 */

const CANDIDATE_BACKEND_URLS = [
  'http://localhost:3001',
  'http://localhost:3000',
  'https://meet-scribe-ck55.onrender.com'
];

// DOM Elements
const elements = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  dropzone: document.getElementById('dropzone'),
  dropzoneTitle: document.getElementById('dropzone-title'),
  fileDetails: document.getElementById('file-details'),
  audioFileInput: document.getElementById('audio-file-input'),
  geminiKeyInput: document.getElementById('gemini-key-input'),
  processAudioBtn: document.getElementById('process-audio-btn'),
  statusBox: document.getElementById('status-box'),
  statusIcon: document.getElementById('status-icon'),
  statusTitle: document.getElementById('status-title'),
  statusDesc: document.getElementById('status-desc'),
  viewComplete: document.getElementById('view-complete'),
  downloadAllBtn: document.getElementById('download-all-btn'),
  copyTabContentBtn: document.getElementById('copy-tab-content-btn'),
  copyBtnText: document.getElementById('copy-btn-text'),

  // Tabs
  tabBtnUrTrans: document.getElementById('tab-btn-ur-trans'),
  tabBtnEnTrans: document.getElementById('tab-btn-en-trans'),
  tabBtnUrAct: document.getElementById('tab-btn-ur-act'),
  tabBtnEnAct: document.getElementById('tab-btn-en-act'),

  tabContentUrTrans: document.getElementById('tab-content-ur-trans'),
  tabContentEnTrans: document.getElementById('tab-content-en-trans'),
  tabContentUrAct: document.getElementById('tab-content-ur-act'),
  tabContentEnAct: document.getElementById('tab-content-en-act')
};

let selectedFile = null;
let activeBackendUrl = 'http://localhost:3001';
let currentResults = null;
let activeTabType = 'ur-trans';

// Auto-discover backend URL (Local servers prioritized over cloud)
async function autoDiscoverBackend() {
  const saved = await chrome.storage.local.get('backendUrl');
  const candidates = Array.from(new Set([
    ...CANDIDATE_BACKEND_URLS,
    saved.backendUrl
  ])).filter(Boolean);

  for (const url of candidates) {
    const cleanUrl = url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        activeBackendUrl = cleanUrl;
        await chrome.storage.local.set({ backendUrl: cleanUrl });
        elements.statusDot.className = 'status-dot online';
        elements.statusText.textContent = cleanUrl.includes('localhost') ? 'Local Server Online' : 'Cloud Server Online';
        return cleanUrl;
      }
    } catch (e) {}
  }

  elements.statusDot.className = 'status-dot warning';
  elements.statusText.textContent = 'Server Offline';
  return activeBackendUrl;
}

// Download Helper with Folder support
async function triggerDownload(folderName, filename, content) {
  const fullPath = folderName ? `${folderName}/${filename}` : filename;
  const utf8BOM = '\uFEFF';
  const blob = new Blob([utf8BOM + (content || '')], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  const revokeAfterDelay = () => setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);

  if (chrome.downloads && chrome.downloads.download) {
    try {
      await chrome.downloads.download({
        url: blobUrl,
        filename: fullPath,
        saveAs: false
      });
      revokeAfterDelay();
      return;
    } catch (e) {
      console.warn('chrome.downloads failed, using anchor tag fallback:', e);
    }
  }

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fullPath;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  revokeAfterDelay();
}

// Initialize Page
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved API key
  const savedData = await chrome.storage.local.get(['geminiApiKey', 'groqApiKey']);
  if (savedData.geminiApiKey) {
    elements.geminiKeyInput.value = savedData.geminiApiKey;
  }

  // Discover backend
  await autoDiscoverBackend();

  // Setup Event Listeners
  setupEventListeners();
});

function handleFileSelection(file) {
  if (!file) return;
  selectedFile = file;
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  elements.dropzoneTitle.textContent = 'Audio File Selected ✓';
  elements.fileDetails.textContent = `📁 ${file.name} (${sizeMB} MB)`;
  elements.fileDetails.classList.remove('hidden');
  elements.processAudioBtn.disabled = false;
}

function setupEventListeners() {
  // Dropzone click & drag drop
  elements.dropzone.addEventListener('click', () => {
    elements.audioFileInput.value = '';
    elements.audioFileInput.click();
  });

  elements.audioFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  elements.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropzone.classList.add('dragover');
  });

  elements.dropzone.addEventListener('dragleave', () => {
    elements.dropzone.classList.remove('dragover');
  });

  elements.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  // Save key as user types
  elements.geminiKeyInput.addEventListener('input', () => {
    const val = elements.geminiKeyInput.value.trim();
    if (val) {
      chrome.storage.local.set({ geminiApiKey: val });
    }
  });

  // Process button click
  elements.processAudioBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    elements.processAudioBtn.disabled = true;
    elements.statusBox.className = 'alert-banner';
    elements.statusBox.classList.remove('hidden');
    elements.statusIcon.textContent = '⏳';
    elements.statusTitle.textContent = 'Uploading & Transcribing Audio...';
    elements.statusDesc.textContent = `Sending ${selectedFile.name} (${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB) to AI backend...`;
    elements.viewComplete.classList.add('hidden');

    try {
      const geminiKey = elements.geminiKeyInput.value.trim();
      const candidates = Array.from(new Set([
        'http://localhost:3001',
        'http://localhost:3000',
        activeBackendUrl,
        ...CANDIDATE_BACKEND_URLS
      ].filter(Boolean).map(u => u.replace(/\/+$/, ''))));

      let lastError = null;
      let resJson = null;

      for (const cleanUrl of candidates) {
        try {
          console.log(`[UploadTab] Uploading ${selectedFile.name} to ${cleanUrl}/api/process-meeting...`);
          const formData = new FormData();
          formData.append('audio', selectedFile, selectedFile.name);
          if (geminiKey) formData.append('geminiApiKey', geminiKey);

          const response = await fetch(`${cleanUrl}/api/process-meeting`, {
            method: 'POST',
            headers: geminiKey ? { 'X-Gemini-API-Key': geminiKey } : {},
            body: formData
          });

          if (!response.ok) {
            const errText = await response.text();
            let parsedMsg = errText;
            try {
              const j = JSON.parse(errText);
              parsedMsg = j.error || j.message || errText;
            } catch (e) {}
            throw new Error(`Server ${cleanUrl} (${response.status}): ${parsedMsg}`);
          }

          const data = await response.json();
          if (!data.success) {
            throw new Error(data.error || 'Audio processing returned no data.');
          }

          if (data.jobId) {
            while (true) {
              await new Promise(r => setTimeout(r, 4000));
              const statusRes = await fetch(`${cleanUrl}/api/job-status/${data.jobId}`, {
                headers: geminiKey ? { 'X-Gemini-API-Key': geminiKey } : {}
              });
              const statusJson = await statusRes.json();
              if (!statusRes.ok || !statusJson.success) {
                throw new Error(statusJson.error || 'Lost track of the audio processing job.');
              }
              if (statusJson.status === 'done') { data.data = statusJson.data; break; }
              if (statusJson.status === 'error') throw new Error(statusJson.error || 'Audio processing failed.');
            }
          }
          if (!data.data) {
            throw new Error('Audio processing returned no data.');
          }

          resJson = data;
          activeBackendUrl = cleanUrl;
          await chrome.storage.local.set({ backendUrl: cleanUrl });
          break;
        } catch (err) {
          console.warn(`[UploadTab] Backend ${cleanUrl} failed:`, err.message);
          lastError = err;
        }
      }

      if (!resJson) {
        throw lastError || new Error('Could not process audio with available backend servers. Please check if npm start is running in backend.');
      }

      elements.statusIcon.textContent = '🎉';
      elements.statusTitle.textContent = 'Processing Complete!';
      elements.statusDesc.textContent = 'Auto-saving 4 organized text files to your Downloads folder...';

      // Download files into Downloads folder
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
      const folderName = `MeetScribe_Urdu/Reprocessed_${dateStr}_${timeStr}`;

      await triggerDownload(folderName, '1_transcript_urdu.txt', resJson.data.transcript_urdu || '');
      await new Promise(r => setTimeout(r, 200));
      await triggerDownload(folderName, '2_transcript_english.txt', resJson.data.transcript_english || '');
      await new Promise(r => setTimeout(r, 200));
      await triggerDownload(folderName, '3_action_items_urdu.txt', resJson.data.action_items_urdu || '');
      await new Promise(r => setTimeout(r, 200));
      await triggerDownload(folderName, '4_action_items_english_improved.txt', resJson.data.action_items_english_improved || '');

      // Populate Complete view
      currentResults = resJson.data;
      populateResults(resJson.data);
      elements.viewComplete.classList.remove('hidden');

    } catch (err) {
      console.error('[UploadTab] Processing error:', err);
      elements.statusBox.className = 'alert-banner alert-banner-mic';
      elements.statusIcon.textContent = '✕';
      elements.statusTitle.textContent = 'Processing Failed';
      elements.statusDesc.textContent = err.message || 'An error occurred during audio processing.';
    } finally {
      elements.processAudioBtn.disabled = false;
    }
  });

  // Tabs
  elements.tabBtnUrTrans.addEventListener('click', () => switchTab('ur-trans'));
  elements.tabBtnEnTrans.addEventListener('click', () => switchTab('en-trans'));
  elements.tabBtnUrAct.addEventListener('click', () => switchTab('ur-act'));
  elements.tabBtnEnAct.addEventListener('click', () => switchTab('en-act'));

  // Copy to Clipboard
  elements.copyTabContentBtn.addEventListener('click', async () => {
    if (!currentResults) return;
    let textToCopy = '';
    if (activeTabType === 'ur-trans') textToCopy = currentResults.transcript_urdu || '';
    if (activeTabType === 'en-trans') textToCopy = currentResults.transcript_english || '';
    if (activeTabType === 'ur-act') textToCopy = currentResults.action_items_urdu || '';
    if (activeTabType === 'en-act') textToCopy = currentResults.action_items_english_improved || '';

    try {
      await navigator.clipboard.writeText(textToCopy);
      elements.copyBtnText.textContent = 'Copied!';
      setTimeout(() => { elements.copyBtnText.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  });

  // Re-download All
  elements.downloadAllBtn.addEventListener('click', async () => {
    if (!currentResults) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
    const folderName = `MeetScribe_Urdu/Reprocessed_${dateStr}_${timeStr}`;

    await triggerDownload(folderName, '1_transcript_urdu.txt', currentResults.transcript_urdu || '');
    await new Promise(r => setTimeout(r, 200));
    await triggerDownload(folderName, '2_transcript_english.txt', currentResults.transcript_english || '');
    await new Promise(r => setTimeout(r, 200));
    await triggerDownload(folderName, '3_action_items_urdu.txt', currentResults.action_items_urdu || '');
    await new Promise(r => setTimeout(r, 200));
    await triggerDownload(folderName, '4_action_items_english_improved.txt', currentResults.action_items_english_improved || '');
  });
}

function populateResults(data) {
  elements.tabContentUrTrans.textContent = data.transcript_urdu || 'کوئی ٹرانسکرپٹ دستیاب نہیں ہے۔';
  elements.tabContentEnTrans.textContent = data.transcript_english || 'No English transcript available.';
  elements.tabContentUrAct.textContent = data.action_items_urdu || 'کوئی ایکشن آئٹم دستیاب نہیں ہے۔';
  elements.tabContentEnAct.textContent = data.action_items_english_improved || 'No action items available.';
  switchTab('ur-trans');
}

function switchTab(tab) {
  activeTabType = tab;
  const allBtns = [elements.tabBtnUrTrans, elements.tabBtnEnTrans, elements.tabBtnUrAct, elements.tabBtnEnAct];
  allBtns.forEach(btn => { btn.className = 'tab-btn'; });

  elements.tabContentUrTrans.classList.add('hidden');
  elements.tabContentEnTrans.classList.add('hidden');
  elements.tabContentUrAct.classList.add('hidden');
  elements.tabContentEnAct.classList.add('hidden');

  if (tab === 'ur-trans') {
    elements.tabBtnUrTrans.className = 'tab-btn active';
    elements.tabContentUrTrans.classList.remove('hidden');
  } else if (tab === 'en-trans') {
    elements.tabBtnEnTrans.className = 'tab-btn active';
    elements.tabContentEnTrans.classList.remove('hidden');
  } else if (tab === 'ur-act') {
    elements.tabBtnUrAct.className = 'tab-btn active';
    elements.tabContentUrAct.classList.remove('hidden');
  } else if (tab === 'en-act') {
    elements.tabBtnEnAct.className = 'tab-btn active';
    elements.tabContentEnAct.classList.remove('hidden');
  }
}
