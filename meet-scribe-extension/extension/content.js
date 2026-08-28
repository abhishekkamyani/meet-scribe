/**
 * MeetScribe Urdu - Google Meet Content Script
 * 1. Monitors Google Meet microphone mute/unmute state in real-time.
 * 2. Scrapes 100% ground-truth real-time speaker-attributed captions from Google Meet DOM (passive).
 * 3. Extracts verified meeting participants roster.
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
  removeCaptionsOverlayStyle();
}

/**
 * Prevents Google Meet from shrinking the presentation/video grid when captions are active.
 */
function injectCaptionsOverlayStyle() {
  if (document.getElementById('meetscribe-captions-overlay-style')) return;
  const style = document.createElement('style');
  style.id = 'meetscribe-captions-overlay-style';
  style.textContent = `
    /* MeetScribe: Keep video grid / presentation 100% full-size by floating captions over the bottom */
    div[jsname="YSxPtf"],
    div[jsname="tgaKEf"],
    div.a4cQT,
    [role="region"][aria-label*="caption" i],
    [role="region"][aria-label*="subtitle" i] {
      position: absolute !important;
      bottom: 80px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      max-width: 85% !important;
      height: auto !important;
      max-height: 120px !important;
      z-index: 10 !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

function removeCaptionsOverlayStyle() {
  const style = document.getElementById('meetscribe-captions-overlay-style');
  if (style) style.remove();
  const hideStyle = document.getElementById('meetscribe-hide-captions-style');
  if (hideStyle) hideStyle.remove();
  document.body.classList.remove('meetscribe-hide-captions');
  const legacyStyle = document.getElementById('meetscribe-stealth-style');
  if (legacyStyle) legacyStyle.remove();
  document.body.classList.remove('meetscribe-stealth-active');
}

/**
 * Check if Google Meet Closed Captions are currently active in DOM
 */
function isMeetCaptionsActive() {
  const captionDom = document.querySelector([
    'div[jsname="YSxPtf"]',
    'div[jsname="tgaKEf"]',
    'div.iTTPOb',
    'div.nMx0df',
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitle" i]'
  ].join(', '));

  return Boolean(captionDom && (captionDom.children.length > 0 || (captionDom.innerText || '').trim().length > 0));
}

/**
 * Real-time Closed Captions Scraper & Accumulator
 * Uses a multi-layer detection strategy to survive Google Meet DOM changes:
 * Layer 1: Known jsname/class selectors for caption containers
 * Layer 2: Semantic ARIA attributes (stable across Meet versions)
 * Layer 3: Broad aria-live sweep in lower screen
 */
function findCaptionContainer() {
  // Layer 1: Known selectors for captions container
  const knownSelectors = [
    'div[jsname="YSxPtf"]',
    'div[jsname="tgaKEf"]',
    'div.bh44bd',
    'div.a4cQT',
  ];
  for (const sel of knownSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // Layer 2: Semantic ARIA — stable across Meet UI updates
  const ariaSelectors = [
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitle" i]',
    '[role="region"][aria-label*="کیپشن" i]',
    '[aria-live="polite"][aria-atomic="false"]',
  ];
  for (const sel of ariaSelectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || '').trim().length > 1) return el;
  }

  // Layer 3: Any aria-live region in the lower half of the screen with text
  const liveRegions = document.querySelectorAll('[aria-live]');
  for (const el of liveRegions) {
    const text = (el.innerText || '').trim();
    if (text.length < 2) continue;
    const rect = el.getBoundingClientRect();
    // Captions appear in lower 50% of screen
    if (rect.top > window.innerHeight * 0.4 || rect.bottom > window.innerHeight * 0.5) {
      return el;
    }
  }

  return null;
}

function processCaptionsDOM() {
  try {
    const container = findCaptionContainer();
    if (!container) return;

    // Get individual caption blocks (speaker + text pairs)
    // Try specific child selectors first, fall back to container itself
    const childSelectors = [
      'div[jsname="YSxPtf"] > div',
      'div[jsname="tgaKEf"] > div',
      'div.bh44bd > div',
      'div.iTTPOb',
      'div.nMx0df',
      '[role="region"][aria-label*="caption" i] > div',
      '[aria-live][aria-atomic="false"] > div',
    ];

    let captionBlocks = document.querySelectorAll(childSelectors.join(', '));

    // If no child blocks, treat the container itself as the single block
    if (captionBlocks.length === 0) {
      captionBlocks = [container];
    }

    captionBlocks.forEach(block => {
      // 1. Extract Speaker Name
      let speakerName = '';

      const speakerEl = block.querySelector('.zs75Ib, .NW0r5c, .jxFHg, span.notranslate, div.notranslate, [data-self-name]');
      if (speakerEl) {
        speakerName = (speakerEl.innerText || speakerEl.getAttribute('data-self-name') || '').trim();
      }

      if (!speakerName) {
        const imgEl = block.querySelector('img[alt]');
        if (imgEl && imgEl.getAttribute('alt')) {
          const alt = imgEl.getAttribute('alt').trim();
          if (alt && !['avatar', 'profile', 'photo'].includes(alt.toLowerCase())) {
            speakerName = alt;
          }
        }
      }

      if (!speakerName) {
        const parent = block.closest('div[jsname="YSxPtf"], div[jsname="tgaKEf"], div.bh44bd, [role="region"]');
        if (parent) {
          const prevHeader = parent.querySelector('.zs75Ib, .NW0r5c, .jxFHg');
          if (prevHeader) speakerName = prevHeader.innerText.trim();
        }
      }

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
      const textEls = block.querySelectorAll('span.VbkSUe, span.iTTPOb, .yg3Swb, span[jsname="VbkSUe"]');
      let textContent = '';

      if (textEls.length > 0) {
        textContent = Array.from(textEls).map(el => el.innerText || '').join(' ').trim();
      }

      // Fallback: clone block, strip speaker element, get all innerText
      if (!textContent) {
        const clone = block.cloneNode(true);
        const rmSpeaker = clone.querySelector('.zs75Ib, .NW0r5c, .jxFHg, img');
        if (rmSpeaker) rmSpeaker.remove();
        textContent = (clone.innerText || '').trim();
      }

      // Last resort: use the raw innerText from the block as-is
      if (!textContent) {
        textContent = (block.innerText || '').trim();
      }

      if (!textContent || textContent.length < 1) return;

      uniqueSpeakersSet.add(speakerName);

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

      // 3. Deduplicate and merge streaming text
      if (captionsHistory.length > 0) {
        const lastEntry = captionsHistory[captionsHistory.length - 1];

        if (lastEntry.speaker === speakerName) {
          if (textContent.startsWith(lastEntry.text) || lastEntry.text.startsWith(textContent)) {
            if (textContent.length > lastEntry.text.length) {
              lastEntry.text = textContent;
              lastEntry.timestamp = timeStr;
            }
            return;
          }

          if (!lastEntry.text.endsWith(textContent) && !textContent.includes(lastEntry.text)) {
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
  injectCaptionsOverlayStyle();

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

  console.log('[MeetScribe Content] Real-time Captions Observer active.');
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
  removeCaptionsOverlayStyle();

  processCaptionsDOM();
  return getFormattedCaptions();
}

/**
 * Format accumulated captions into a clean dialogue transcript
 */
function getFormattedCaptions() {
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

  window.addEventListener('click', (e) => {
    setTimeout(triggerStateCheck, 20);
    // Note: we intentionally do NOT call maintainCaptionsKeepAlive on every click,
    // as that caused the settings modal to reopen whenever the user closed it.
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


// Re-injection guard: background.js may inject this script programmatically to ensure the
// latest version is running on existing Meet tabs (tabs opened before the extension was loaded/reloaded).
// This block prevents double message listeners, double observers, and double poll intervals.
if (window.__meetScribeContentLoaded) {
  console.log('[MeetScribe] Re-injected into already-active tab \u2014 cleaning up previous instance and reinitializing...');
  cleanUpScript();
  isCapturingCaptions = false;
  captionsHistory = [];
  lastRecordedSpeaker = '';
  lastRecordedText = '';
}
window.__meetScribeContentLoaded = true;

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

