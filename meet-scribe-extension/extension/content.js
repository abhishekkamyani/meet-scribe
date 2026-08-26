/**
 * MeetScribe Urdu - Google Meet Content Script
 * 1. Monitors Google Meet microphone mute/unmute state in real-time.
 * 2. Auto-enables Google Meet Closed Captions (CC).
 * 3. Scrapes 100% ground-truth real-time speaker-attributed captions from Google Meet DOM.
 * 4. Extracts verified meeting participants roster.
 */

let lastMuteState = null;
let debounceTimeout = null;
let pollInterval = null;
let domObserver = null;
let captionsObserver = null;
let isCapturingCaptions = false;

// Captions Storage: Array of { speaker: string, text: string, timestamp: string }
let captionsHistory = [];
let lastRecordedSpeaker = '';
let lastRecordedText = '';
const uniqueSpeakersSet = new Set();

// Helper: Safely verify if extension context is valid
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && Boolean(chrome.runtime.id);
}

// Safely send message without throwing "Extension context invalidated"
function safeSendMessage(message) {
  if (!isContextValid()) {
    cleanUpScript();
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Ignored if receiver is busy or closed
      }
    });
  } catch (err) {
    cleanUpScript();
  }
}

// Clean up listeners if extension is reloaded/uninstalled
function cleanUpScript() {
  if (domObserver) {
    try { domObserver.disconnect(); } catch (e) {}
    domObserver = null;
  }
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }
}

/**
 * Automatically ensure Google Meet Closed Captions (CC) are enabled
 */
function ensureCaptionsEnabled() {
  try {
    // 1. Search for CC toggle button in Google Meet bottom bar
    const allButtons = document.querySelectorAll('button, div[role="button"]');
    let ccBtn = null;

    for (const btn of allButtons) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      const jsname = btn.getAttribute('jsname') || '';

      const isCcBtn =
        label.includes('caption') ||
        label.includes('subtitles') ||
        label.includes('سب ٹائٹل') ||
        label.includes('کیپشن') ||
        tooltip.includes('caption') ||
        tooltip.includes('subtitles') ||
        tooltip.includes('turn on captions') ||
        tooltip.includes('turn off captions') ||
        jsname === 'r8qRAd';

      if (isCcBtn) {
        ccBtn = btn;
        const isPressed = btn.getAttribute('aria-pressed') === 'true' ||
          label.includes('turn off') ||
          tooltip.includes('turn off');

        if (!isPressed) {
          console.log('[MeetScribe] Activating Google Meet Closed Captions via button click...');
          btn.click();
        } else {
          console.log('[MeetScribe] Google Meet Closed Captions are already ON.');
        }
        return true;
      }
    }

    // 2. Keyboard shortcut fallback: dispatch 'c' key to toggle captions if button not clicked
    console.log('[MeetScribe] CC button not found directly, triggering "c" shortcut key...');
    const eventDown = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true });
    const eventUp = new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true });
    document.body.dispatchEvent(eventDown);
    document.body.dispatchEvent(eventUp);

    return true;
  } catch (err) {
    console.warn('[MeetScribe] Error ensuring captions enabled:', err);
    return false;
  }
}

/**
 * Real-time Closed Captions Scraper & Accumulator
 * Observes Google Meet's native caption container and extracts ground-truth speaker names and text.
 */
function processCaptionsDOM() {
  try {
    // Google Meet caption container selectors across various Meet UI versions
    const captionBlockSelectors = [
      'div[jsname="YSxPtf"] > div',
      'div.bh44bd > div',
      'div.T4LgNb > div',
      'div.iTTPOb',
      'div.nMx0df',
      'div[jscontroller="D1tHje"] div[jsname="YSxPtf"] div',
      'div[role="region"][aria-label*="caption" i] div'
    ];

    let captionBlocks = document.querySelectorAll(captionBlockSelectors.join(', '));

    // Fallback: search for any container with caption text classes
    if (captionBlocks.length === 0) {
      captionBlocks = document.querySelectorAll('div[jsname="YSxPtf"], div.bh44bd, div.a4cQT');
    }

    if (captionBlocks.length === 0) return;

    captionBlocks.forEach(block => {
      // 1. Extract Speaker Name
      let speakerName = '';

      // Strategy A: Dedicated speaker name container (.zs75Ib, .NW0r5c, .jxFHg)
      const speakerEl = block.querySelector('.zs75Ib, .NW0r5c, .jxFHg, span.notranslate, div.notranslate, [data-self-name]');
      if (speakerEl) {
        speakerName = (speakerEl.innerText || speakerEl.getAttribute('data-self-name') || '').trim();
      }

      // Strategy B: Speaker avatar image alt attribute (e.g. <img alt="Abhishek Kamyani">)
      if (!speakerName) {
        const imgEl = block.querySelector('img[alt]');
        if (imgEl && imgEl.getAttribute('alt')) {
          const alt = imgEl.getAttribute('alt').trim();
          if (alt && !['avatar', 'profile', 'photo'].includes(alt.toLowerCase())) {
            speakerName = alt;
          }
        }
      }

      // Strategy C: Check previous sibling header or parent container
      if (!speakerName) {
        const parent = block.closest('div[jsname="YSxPtf"], div.bh44bd, div.T4LgNb');
        if (parent) {
          const prevHeader = parent.querySelector('.zs75Ib, .NW0r5c, .jxFHg');
          if (prevHeader) speakerName = prevHeader.innerText.trim();
        }
      }

      // Clean up speaker name
      speakerName = speakerName
        .replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest)\)/ig, '')
        .split('\n')[0]
        .trim();

      if (!speakerName && discoveredSelfName) {
        speakerName = discoveredSelfName;
      } else if (!speakerName && lastRecordedSpeaker) {
        speakerName = lastRecordedSpeaker;
      } else if (!speakerName) {
        speakerName = 'Participant';
      }

      // 2. Extract Spoken Text
      const textEls = block.querySelectorAll('span.VbkSUe, span.iTTPOb, div.T4LgNb, .yg3Swb, span[jsname="VbkSUe"]');
      let textContent = '';

      if (textEls.length > 0) {
        textContent = Array.from(textEls).map(el => el.innerText || '').join(' ').trim();
      } else {
        // If specific text class not found, clone block and remove speaker element
        const clone = block.cloneNode(true);
        const rmSpeaker = clone.querySelector('.zs75Ib, .NW0r5c, .jxFHg, img');
        if (rmSpeaker) rmSpeaker.remove();
        textContent = (clone.innerText || '').trim();
      }

      if (!textContent || textContent.length < 1) return;

      uniqueSpeakersSet.add(speakerName);

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

      // 3. Deduplicate and merge streaming text
      if (captionsHistory.length > 0) {
        const lastEntry = captionsHistory[captionsHistory.length - 1];

        if (lastEntry.speaker === speakerName) {
          // If the new text starts with the old text or extends it, update the entry
          if (textContent.startsWith(lastEntry.text) || lastEntry.text.startsWith(textContent)) {
            if (textContent.length > lastEntry.text.length) {
              lastEntry.text = textContent;
              lastEntry.timestamp = timeStr;
            }
            return;
          }

          // If new text is an addition / continuation of the sentence
          if (!lastEntry.text.endsWith(textContent) && !textContent.includes(lastEntry.text)) {
            // Append if short gap
            lastEntry.text = `${lastEntry.text} ${textContent}`.replace(/\s+/g, ' ').trim();
            lastEntry.timestamp = timeStr;
            return;
          }
        }
      }

      // New distinct utterance block
      if (lastRecordedText !== textContent || lastRecordedSpeaker !== speakerName) {
        lastRecordedSpeaker = speakerName;
        lastRecordedText = textContent;

        captionsHistory.push({
          speaker: speakerName,
          text: textContent,
          timestamp: timeStr
        });

        console.log(`[MeetScribe Captions] [${timeStr}] [${speakerName}]: ${textContent}`);
      }
    });

  } catch (err) {
    console.warn('[MeetScribe] Error processing captions DOM:', err);
  }
}

/**
 * Start observing the captions container in Google Meet DOM
 */
function startCaptionsObserver() {
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }

  isCapturingCaptions = true;
  ensureCaptionsEnabled();

  captionsObserver = new MutationObserver(() => {
    if (isCapturingCaptions) {
      processCaptionsDOM();
    }
  });

  captionsObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  console.log('[MeetScribe Content] Real-time Captions Observer initialized.');
}

/**
 * Stop observing captions and return accumulated transcript
 */
function stopCaptionsObserver() {
  isCapturingCaptions = false;
  if (captionsObserver) {
    try { captionsObserver.disconnect(); } catch (e) {}
    captionsObserver = null;
  }

  // Final scrape pass to capture any remaining text
  processCaptionsDOM();

  return getFormattedCaptions();
}

/**
 * Format accumulated captions into a clean dialogue transcript
 */
function getFormattedCaptions() {
  // Merge consecutive entries from the same speaker
  const mergedUtterances = [];

  for (const entry of captionsHistory) {
    if (!entry.text || entry.text.trim().length === 0) continue;

    if (mergedUtterances.length > 0) {
      const prev = mergedUtterances[mergedUtterances.length - 1];
      if (prev.speaker === entry.speaker) {
        prev.text = `${prev.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
        prev.timestamp = entry.timestamp;
        continue;
      }
    }

    mergedUtterances.push({
      speaker: entry.speaker,
      text: entry.text.trim(),
      timestamp: entry.timestamp
    });
  }

  const rawTranscript = mergedUtterances
    .map(u => `[${u.speaker}]: ${u.text}`)
    .join('\n');

  const participants = Array.from(new Set([
    ...Array.from(uniqueSpeakersSet),
    ...extractParticipantNames().allParticipants
  ])).filter(Boolean);

  return {
    rawTranscript: rawTranscript,
    utterances: mergedUtterances,
    participants: participants
  };
}

/**
 * Determine if the local user is currently muted in Google Meet.
 */
function getMeetMicStatus() {
  const allButtons = document.querySelectorAll('button, div[role="button"]');
  for (const btn of allButtons) {
    const isMutedAttr = btn.getAttribute('data-is-muted');
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();

    const isMicButton =
      label.includes('microphone') ||
      label.includes('mic') ||
      label.includes('مائیک') ||
      label.includes('مائیکروفون') ||
      tooltip.includes('microphone') ||
      tooltip.includes('mic') ||
      tooltip.includes('ctrl + d') ||
      tooltip.includes('ctrl+d') ||
      tooltip.includes('cmd + d') ||
      tooltip.includes('cmd+d') ||
      label.includes('ctrl + d') ||
      label.includes('ctrl+d');

    if (isMicButton) {
      if (isMutedAttr === 'true') return true;
      if (isMutedAttr === 'false') return false;

      if (
        label.includes('turn on') ||
        label.includes('unmute') ||
        label.includes('is off') ||
        label.includes('is muted') ||
        label.includes('مائیک آن') ||
        tooltip.includes('turn on') ||
        tooltip.includes('unmute')
      ) {
        return true;
      }

      if (
        label.includes('turn off') ||
        label.includes('is on') ||
        label.includes('mute') ||
        label.includes('مائیک بند') ||
        tooltip.includes('turn off') ||
        tooltip.includes('is on')
      ) {
        return false;
      }

      try {
        const bg = window.getComputedStyle(btn).backgroundColor;
        if (bg.includes('234, 67, 53') || bg.includes('217, 48, 37') || bg.includes('239, 68, 68') || bg.includes('220, 38, 38')) {
          return true;
        }
      } catch (e) {}
    }
  }

  const selfTileMuted = document.querySelectorAll(
    '[data-self-name] [data-is-muted="true"], [aria-label*="(You)"] [data-is-muted="true"], [aria-label*="(آپ)"] [data-is-muted="true"]'
  );
  if (selfTileMuted.length > 0) return true;

  const anyMuted = document.querySelector('button[data-is-muted="true"], div[data-is-muted="true"]');
  if (anyMuted) {
    const isControl = anyMuted.closest('div[role="region"], nav, footer, div[jscontroller], div[data-meeting-title]');
    if (isControl || anyMuted.tagName.toLowerCase() === 'button') {
      return true;
    }
  }

  return false;
}

// Broadcast current mute state if changed
function notifyMicStateChange() {
  if (!isContextValid()) {
    cleanUpScript();
    return;
  }

  const currentMuteState = getMeetMicStatus();
  if (currentMuteState !== lastMuteState) {
    lastMuteState = currentMuteState;
    console.log(`[MeetScribe Content] Local mic state: ${currentMuteState ? 'MUTED' : 'UNMUTED'}`);
    
    safeSendMessage({
      type: 'MEET_MIC_STATUS_CHANGED',
      isMuted: currentMuteState
    });
  }
}

function triggerStateCheck() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    notifyMicStateChange();
  }, 30);
}

// Persistent participant discovery state
let discoveredSelfName = '';
const discoveredRemoteParticipants = new Set();

// Extract active participant names from Google Meet DOM
function extractParticipantNames() {
  let selfName = '';
  const roomParticipants = new Set();

  const selfElement = document.querySelector('[data-self-name]');
  if (selfElement) {
    const name = (selfElement.getAttribute('data-self-name') || '').trim();
    if (name && name.length >= 2 && name.length <= 40 && !['You', 'آپ'].includes(name)) {
      selfName = name;
      discoveredSelfName = name;
    }
  }

  if (!selfName) {
    const youElements = document.querySelectorAll(
      '[aria-label*="(You)"], [aria-label*="(آپ)"], [title*="(You)"], [title*="(آپ)"], [aria-label*="Your presentation"]'
    );
    for (const el of youElements) {
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '';
      const match = raw.match(/^(.*?)\s*\((?:You|آپ|Presentation|Your presentation)\)/i);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name && name.length >= 2 && name.length <= 40 && !['You', 'آپ'].includes(name)) {
          selfName = name;
          discoveredSelfName = name;
          break;
        }
      }
    }
  }

  const ignoredLabels = new Set([
    'you', 'آپ', 'chat', 'people', 'host controls', 'activities', 'meeting details',
    'turn on microphone', 'turn off microphone', 'turn on camera', 'turn off camera',
    'raise hand', 'more options', 'leave call', 'info', 'show everyone', 'participants',
    'send a message to everyone', 'call details', 'pin', 'mute', 'unmute', 'grid view',
    'speaker view', 'presentation', 'your presentation', 'gemini', 'meet', 'google meet'
  ]);

  const participantSelectors = [
    'div[data-requested-participant-id] [title]',
    'div[data-participant-id] [title]',
    'div[data-participant-id]',
    'div[data-self-name]',
    'div[data-participant-name]',
    'div[role="listitem"] span[title]',
    'div[role="listitem"] [data-participant-id]',
    'span[jsname="WQtWae"]',
    'div[jsname="xySENc"]'
  ];

  const candidateElements = document.querySelectorAll(participantSelectors.join(', '));
  candidateElements.forEach(el => {
    let title = (el.getAttribute('title') || el.getAttribute('data-participant-name') || el.innerText || '').split('\n')[0].trim();
    title = title.replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest|External)\)/ig, '').trim();

    if (
      title &&
      title.length >= 2 &&
      title.length <= 40 &&
      !title.includes('http') &&
      !title.includes(':') &&
      !ignoredLabels.has(title.toLowerCase())
    ) {
      roomParticipants.add(title);
      discoveredRemoteParticipants.add(title);
    }
  });

  const allFoundNames = Array.from(roomParticipants);
  let remoteArray = allFoundNames.filter(n => n !== selfName);

  if (!selfName && allFoundNames.length >= 2) {
    selfName = allFoundNames[0];
    remoteArray = allFoundNames.slice(1);
    discoveredSelfName = selfName;
  } else if (!selfName && discoveredSelfName) {
    selfName = discoveredSelfName;
    remoteArray = allFoundNames.filter(n => n !== selfName);
  }

  return {
    selfName: selfName || '',
    remoteParticipants: remoteArray,
    allParticipants: Array.from(new Set([selfName, ...allFoundNames])).filter(Boolean)
  };
}

// Initialize MutationObserver
function initObserver() {
  if (!isContextValid()) return;

  domObserver = new MutationObserver(() => {
    triggerStateCheck();
    extractParticipantNames();
  });

  domObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-is-muted', 'aria-label', 'data-tooltip', 'class', 'title', 'data-participant-id', 'style'],
    subtree: true,
    childList: true
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      setTimeout(triggerStateCheck, 20);
    }
  });

  window.addEventListener('click', () => {
    setTimeout(triggerStateCheck, 20);
  });

  pollInterval = setInterval(() => {
    if (!isContextValid()) {
      cleanUpScript();
      return;
    }
    triggerStateCheck();
    extractParticipantNames();
  }, 200);

  notifyMicStateChange();
  extractParticipantNames();
}

// Listen for messages from background / popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isContextValid()) return false;

  if (message.type === 'START_CAPTIONS_CAPTURE') {
    captionsHistory = [];
    uniqueSpeakersSet.clear();
    lastRecordedSpeaker = '';
    lastRecordedText = '';
    startCaptionsObserver();
    sendResponse({ success: true });
    return true;

  } else if (message.type === 'STOP_CAPTIONS_CAPTURE' || message.type === 'GET_CAPTIONS_TRANSCRIPT') {
    const data = stopCaptionsObserver();
    sendResponse({ success: true, ...data });
    return true;

  } else if (message.type === 'GET_MEET_MIC_STATUS') {
    const isMuted = getMeetMicStatus();
    lastMuteState = isMuted;
    sendResponse({ isMuted });
    return true;

  } else if (message.type === 'GET_MEET_PARTICIPANTS') {
    const participantsData = extractParticipantNames();
    sendResponse({ participants: participantsData });
    return true;
  }
});

// Start monitoring when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initObserver);
} else {
  initObserver();
}
