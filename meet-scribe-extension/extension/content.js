/**
 * MeetScribe Urdu - Google Meet Content Script v3
 *
 * Core strategy: Track every live caption SEGMENT separately using a stable key
 * (speaker + segment-index). For each segment, always keep the LONGEST version
 * seen (Google Meet appends words in-place). Only flush a segment to history once
 * it has been replaced by a new segment from the same speaker, or a new speaker
 * starts. This guarantees zero dropped words and zero premature truncation.
 */

/* ── State ─────────────────────────────────────────────────────────────── */
let lastMuteState      = null;
let debounceTimeout    = null;
let captionsDebounce   = null;
let pollInterval       = null;
let domObserver        = null;
let captionsObserver   = null;
let isCapturingCaptions = false;
let discoveredSelfName  = '';
const discoveredParticipantsSet = new Set();
const uniqueSpeakersSet = new Set();

/**
 * captionSegments: Map<segmentKey, { speaker, text, timestamp }>
 *
 * A "segment" is one continuous block visible in the CC panel right now.
 * Google Meet shows 1-3 blocks at a time. Each block has a speaker label
 * and a growing text. We key by `speaker||index` so we can always update
 * the longest version and never discard words.
 */
let captionSegments = new Map();   // live, in-progress segments
let captionsHistory = [];          // finalized, complete utterances
let lastSnapshotKey = '';          // hash of last DOM snapshot to avoid redundant work

/* ── Context guard ──────────────────────────────────────────────────────── */
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && Boolean(chrome.runtime.id);
}

function safeSendMessage(msg) {
  if (!isContextValid()) { cleanUpScript(); return; }
  try {
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) { cleanUpScript(); }
}

/* ── Cleanup ────────────────────────────────────────────────────────────── */
function cleanUpScript() {
  if (domObserver)      { try { domObserver.disconnect();      } catch(e){} domObserver      = null; }
  if (captionsObserver) { try { captionsObserver.disconnect(); } catch(e){} captionsObserver = null; }
  if (pollInterval)     { clearInterval(pollInterval);                       pollInterval     = null; }
  if (debounceTimeout)  { clearTimeout(debounceTimeout);                     debounceTimeout  = null; }
  if (captionsDebounce) { clearTimeout(captionsDebounce);                    captionsDebounce = null; }
  removeCaptionsOverlayStyle();
}

/* ── CC overlay style (keeps video full-screen when CC is on) ───────────── */
function injectCaptionsOverlayStyle() {
  if (document.getElementById('meetscribe-captions-overlay-style')) return;
  const s = document.createElement('style');
  s.id = 'meetscribe-captions-overlay-style';
  // Hide the captions UI from the user completely while keeping the DOM alive for scraping.
  // opacity:0 + pointer-events:none makes the element invisible but still present in the DOM tree.
  s.textContent = `
    div[jsname="YSxPtf"], div[jsname="tgaKEf"], div.a4cQT, div.bh44bd,
    [role="region"][aria-label*="caption" i], [role="region"][aria-label*="subtitle" i] {
      opacity: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }`;
  document.head.appendChild(s);
}
function removeCaptionsOverlayStyle() {
  ['meetscribe-captions-overlay-style','meetscribe-hide-captions-style','meetscribe-stealth-style']
    .forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  document.body.classList.remove('meetscribe-hide-captions','meetscribe-stealth-active');
}

/* ── CC Button Auto-Enable ──────────────────────────────────────────────── */
function findCcToggleButton() {
  const allBtns = document.querySelectorAll('button, div[role="button"]');

  // 1. Exact jsname (most reliable — survives Meet UI rebuilds)
  for (const btn of allBtns) {
    if (btn.closest('[role="dialog"]')) continue;
    if (btn.getAttribute('jsname') === 'r8qRAd') {
      const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      if (!lbl.includes('setting') && !tip.includes('setting') &&
          !lbl.includes('language') && !tip.includes('language') &&
          !lbl.includes('option') && !tip.includes('option')) {
        return btn;
      }
    }
  }

  // 2. Aria-label / tooltip keyword match
  for (const btn of allBtns) {
    if (btn.closest('[role="dialog"]')) continue;
    const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
    if (lbl.includes('setting') || tip.includes('setting') ||
        lbl.includes('language') || tip.includes('language') ||
        lbl.includes('more option') || tip.includes('more option') ||
        lbl.includes('choose') || tip.includes('choose') ||
        lbl.includes('menu') || tip.includes('menu')) continue;

    const isCc =
      lbl.includes('turn on caption') || lbl.includes('turn off caption') ||
      lbl.includes('turn on subtitle') || lbl.includes('turn off subtitle') ||
      tip.includes('turn on caption') || tip.includes('turn off caption') ||
      tip.includes('turn on subtitle') || tip.includes('turn off subtitle') ||
      lbl.includes('کیپشن') || lbl.includes('سب ٹائٹل') ||
      ((lbl.includes('caption') || tip.includes('caption')) &&
       (lbl.includes('(c)') || tip.includes('(c)')));
    if (isCc) return btn;
  }
  return null;
}

function ensureCaptionsEnabled() {
  try {
    const btn = findCcToggleButton();
    if (!btn) return;
    const isOn = btn.getAttribute('aria-pressed') === 'true' ||
      (btn.getAttribute('aria-label') || '').toLowerCase().includes('turn off') ||
      (btn.getAttribute('data-tooltip') || '').toLowerCase().includes('turn off');
    if (!isOn) {
      console.log('[MeetScribe] Auto-enabling Google Meet CC…');
      btn.click();
    }
  } catch(e) { console.warn('[MeetScribe] Could not auto-enable CC:', e); }
}

/* ── Caption Container Detection ────────────────────────────────────────── */
function findCaptionContainer() {
  // Layer 1: stable jsname / class selectors
  for (const sel of [
    'div[jsname="YSxPtf"]', 'div[jsname="tgaKEf"]',
    'div.bh44bd', 'div.a4cQT'
  ]) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // Layer 2: ARIA semantics — stable across Meet redesigns
  for (const sel of [
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitle" i]',
    '[role="region"][aria-label*="کیپشن" i]',
    '[aria-live="polite"][aria-atomic="false"]'
  ]) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || '').trim().length > 1) return el;
  }

  // Layer 3: Any aria-live in lower portion of screen
  for (const el of document.querySelectorAll('[aria-live]')) {
    const txt = (el.innerText || '').trim();
    if (txt.length < 2) continue;
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.35) return el;
  }
  return null;
}

/* ── Speaker Name Extraction ────────────────────────────────────────────── */
function extractSpeakerFromBlock(block) {
  // Try known Google Meet speaker label class names (most reliable)
  const SPEAKER_SELECTORS = [
    '.zs75Ib', '.NW0r5c', '.jxFHg', '.KcIKyf', '.VbkSUe > span:first-child'
  ];
  for (const sel of SPEAKER_SELECTORS) {
    const el = block.querySelector(sel);
    if (el) {
      const name = (el.innerText || '').trim();
      if (name && name.length >= 2 && name.length <= 60) {
        return name.replace(/\s*\((?:You|آپ|Host|Meeting host|Guest|Presentation)\)/ig, '').trim();
      }
    }
  }

  // Avatar img alt text as fallback
  const img = block.querySelector('img[alt]');
  if (img) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt && alt.length >= 2 && !['avatar','profile','photo','person'].includes(alt.toLowerCase())) {
      return alt;
    }
  }

  // data-self-name attribute
  const selfEl = block.querySelector('[data-self-name]');
  if (selfEl) {
    const n = (selfEl.getAttribute('data-self-name') || '').trim();
    if (n && n.length >= 2) return n;
  }

  return '';
}

/* ── Text Extraction from caption block ─────────────────────────────────── */

/**
 * Strip noise from a cloned DOM node before reading text:
 * - aria-hidden elements (Material Icons, decorative spans)
 * - Speaker name elements
 * - img tags
 * - Elements with font-family: 'Material Icons' or 'Material Symbols'
 */
function cleanCloneForText(clone) {
  // Remove aria-hidden nodes (icon fonts always mark themselves aria-hidden)
  clone.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());
  // Remove Material Icon text explicitly (they leak as text like "arrow_downward", "close", etc.)
  clone.querySelectorAll('.material-icons, .material-symbols-outlined, .material-symbols-rounded, [class*="material-icon"], [class*="google-material"]').forEach(el => el.remove());
  // Remove speaker name elements
  clone.querySelectorAll('.zs75Ib, .NW0r5c, .jxFHg, .KcIKyf, img').forEach(el => el.remove());
  // Remove any element that looks like an icon keyword (short all-lowercase word that's a known icon name)
  const ICON_PATTERN = /^(arrow_downward|arrow_upward|jump_to|expand_more|expand_less|close|check|info|warning|error|more_vert|more_horiz|chevron|keyboard_arrow)$/i;
  clone.querySelectorAll('span, i').forEach(el => {
    if (ICON_PATTERN.test((el.textContent || '').trim())) el.remove();
  });
}

function extractTextFromBlock(block) {
  let finalTxt = '';

  // Try known spoken-text span selectors first (most precise)
  const TEXT_SELECTORS = [
    'span.VbkSUe', 'span[jsname="VbkSUe"]', 'span.iTTPOb',
    'span.yg3Swb', '.a4cQT span', 'span[data-message-text]'
  ];
  for (const sel of TEXT_SELECTORS) {
    const spans = block.querySelectorAll(sel);
    if (spans.length > 0) {
      // Build text from each span's clone to strip icons inside spans too
      const parts = Array.from(spans).map(s => {
        const c = s.cloneNode(true);
        cleanCloneForText(c);
        return (c.innerText || c.textContent || '').trim();
      }).filter(Boolean);
      finalTxt = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (finalTxt.length > 0) break;
    }
  }

  // Fallback: clone the block, remove noise, read remaining text
  if (!finalTxt) {
    const clone = block.cloneNode(true);
    cleanCloneForText(clone);
    finalTxt = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Last resort: raw innerText
  if (!finalTxt) {
    finalTxt = (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Globally strip known Google Meet UI strings that leak into the DOM as text
  return finalTxt
    .replace(/arrow_downward|arrow_upward|Jump to bottom|Jump to top|expand_more|expand_less|close|more_vert/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Main Captions Scraper ───────────────────────────────────────────────── */
function processCaptionsDOM() {
  if (!isCapturingCaptions) return;

  try {
    const container = findCaptionContainer();
    if (!container) return;

    // Build a quick snapshot hash to skip redundant processing
    const snapshot = container.innerText || '';
    if (snapshot === lastSnapshotKey) return;
    lastSnapshotKey = snapshot;

    // Find all caption blocks inside the container
    // Each block corresponds to one speaker's current utterance
    const BLOCK_SELECTORS = [
      'div[jsname="YSxPtf"] > div',
      'div[jsname="tgaKEf"] > div',
      'div.bh44bd > div',
      'div.iTTPOb',
      'div.nMx0df',
      '[role="region"][aria-label*="caption" i] > div',
      '[aria-live][aria-atomic="false"] > div'
    ];

    let blocks = Array.from(document.querySelectorAll(BLOCK_SELECTORS.join(', ')));

    // De-duplicate: remove any block that is an ancestor/descendant of another
    blocks = blocks.filter((b, i) =>
      !blocks.some((other, j) => i !== j && other !== b && other.contains(b))
    );

    // If no child blocks found, treat the container itself as one block
    if (blocks.length === 0) blocks = [container];

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    // Build current live segments from DOM
    const liveKeys = new Set();

    blocks.forEach((block, idx) => {
      const speaker = extractSpeakerFromBlock(block) || discoveredSelfName || 'Participant';
      const text    = extractTextFromBlock(block);

      if (!text || text.length < 2) return;

      // Deduplicate text that is clearly just a speaker label repeated as text
      if (text.toLowerCase() === speaker.toLowerCase()) return;

      uniqueSpeakersSet.add(speaker);

      // Segment key: speaker + block position index
      // Using index because Meet shows max ~3 blocks simultaneously
      const segKey = `${speaker}||${idx}`;
      liveKeys.add(segKey);

      const existing = captionSegments.get(segKey);
      if (existing) {
        // Always keep the LONGEST version (Google Meet builds up text left-to-right)
        if (text.length > existing.text.length) {
          existing.text = text;
          existing.timestamp = timeStr;
        }
      } else {
        captionSegments.set(segKey, { speaker, text, timestamp: timeStr });
      }
    });

    // Any segment that was live before but is gone now → it's complete, flush to history
    for (const [key, seg] of captionSegments) {
      if (!liveKeys.has(key)) {
        flushSegmentToHistory(seg);
        captionSegments.delete(key);
      }
    }

  } catch(e) {
    console.warn('[MeetScribe] processCaptionsDOM error:', e);
  }
}

/* ── Flush a completed segment into captionsHistory ─────────────────────── */
function flushSegmentToHistory(seg) {
  const { speaker, text, timestamp } = seg;
  if (!text || text.trim().length < 2) return;

  // Merge into last history entry if same speaker and text is a continuation
  if (captionsHistory.length > 0) {
    const prev = captionsHistory[captionsHistory.length - 1];
    if (prev.speaker === speaker) {
      // Check if new text starts where old text ended (stream continuation)
      if (text.startsWith(prev.text) || prev.text.endsWith(text.slice(-20))) {
        if (text.length > prev.text.length) {
          prev.text = text;
          prev.timestamp = timestamp;
        }
        return;
      }
      // Append as continuation of same speaker turn
      if (!prev.text.includes(text)) {
        prev.text = `${prev.text} ${text}`.replace(/\s+/g, ' ').trim();
        prev.timestamp = timestamp;
        return;
      }
      return; // exact duplicate, skip
    }
  }

  captionsHistory.push({ speaker, text: text.trim(), timestamp });
  console.log(`[MeetScribe ✓] [${timestamp}] [${speaker}]: ${text}`);
}

/* ── Observer lifecycle ──────────────────────────────────────────────────── */
function startCaptionsObserver() {
  // Tear down any existing observer
  if (captionsObserver) { try { captionsObserver.disconnect(); } catch(e){} captionsObserver = null; }

  captionSegments.clear();
  lastSnapshotKey = '';
  isCapturingCaptions = true;

  injectCaptionsOverlayStyle();

  // Try enabling CC immediately and again after a short delay (Meet may not be ready)
  ensureCaptionsEnabled();
  setTimeout(ensureCaptionsEnabled, 2000);
  setTimeout(ensureCaptionsEnabled, 5000);

  // Debounced MutationObserver — captures every live text change
  captionsObserver = new MutationObserver(() => {
    if (!isCapturingCaptions) return;
    if (captionsDebounce) clearTimeout(captionsDebounce);
    captionsDebounce = setTimeout(processCaptionsDOM, 80); // 80ms debounce balances responsiveness vs redundancy
  });

  captionsObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false
  });

  // Periodic safety poll — catches captions that slipped through observer
  const captionsPollInterval = setInterval(() => {
    if (!isCapturingCaptions) { clearInterval(captionsPollInterval); return; }
    processCaptionsDOM();
  }, 500);

  console.log('[MeetScribe] Real-time captions observer started ✓');
}

function stopCaptionsObserver() {
  isCapturingCaptions = false;
  if (captionsObserver) { try { captionsObserver.disconnect(); } catch(e){} captionsObserver = null; }
  if (captionsDebounce) { clearTimeout(captionsDebounce); captionsDebounce = null; }
  removeCaptionsOverlayStyle();

  // Flush any still-live segments that were on screen when Stop was clicked
  for (const [, seg] of captionSegments) {
    flushSegmentToHistory(seg);
  }
  captionSegments.clear();

  // Final scan
  processCaptionsDOM();
  return getFormattedCaptions();
}

/* ── Format final transcript ─────────────────────────────────────────────── */
function getFormattedCaptions() {
  // Merge consecutive same-speaker entries into single turns
  const merged = [];
  for (const entry of captionsHistory) {
    if (!entry.text || entry.text.trim().length === 0) continue;
    if (merged.length > 0 && merged[merged.length - 1].speaker === entry.speaker) {
      const prev = merged[merged.length - 1];
      if (!prev.text.includes(entry.text)) {
        prev.text = `${prev.text} ${entry.text}`.replace(/\s+/g, ' ').trim();
        prev.timestamp = entry.timestamp;
      }
    } else {
      merged.push({ speaker: entry.speaker, text: entry.text.trim(), timestamp: entry.timestamp });
    }
  }

  const rawTranscript = merged.map(u => `[${u.speaker}]: ${u.text}`).join('\n');
  const participants  = Array.from(new Set([
    ...Array.from(uniqueSpeakersSet),
    ...extractParticipantNames().allParticipants
  ])).filter(Boolean);

  console.log(`[MeetScribe] Final transcript: ${merged.length} utterances, ${rawTranscript.length} chars`);
  return { rawTranscript, utterances: merged, participants };
}

/* ── Mic State ───────────────────────────────────────────────────────────── */
function getMeetMicStatus() {
  for (const btn of document.querySelectorAll('button, div[role="button"]')) {
    const muted = btn.getAttribute('data-is-muted');
    const lbl   = (btn.getAttribute('aria-label') || '').toLowerCase();
    const tip   = (btn.getAttribute('data-tooltip') || '').toLowerCase();

    const isMic = lbl.includes('microphone') || lbl.includes('mic') ||
      lbl.includes('مائیک') || tip.includes('microphone') || tip.includes('mic') ||
      tip.includes('ctrl + d') || tip.includes('ctrl+d') ||
      lbl.includes('ctrl + d') || lbl.includes('ctrl+d');

    if (!isMic) continue;
    if (muted === 'true')  return true;
    if (muted === 'false') return false;
    if (lbl.includes('turn on') || lbl.includes('unmute') || lbl.includes('is off') || lbl.includes('is muted') || tip.includes('turn on')) return true;
    if (lbl.includes('turn off') || lbl.includes('is on') || tip.includes('turn off')) return false;
  }

  if (document.querySelector('[data-self-name] [data-is-muted="true"], [aria-label*="(You)"] [data-is-muted="true"]')) return true;
  const anyMuted = document.querySelector('button[data-is-muted="true"], div[data-is-muted="true"]');
  if (anyMuted && (anyMuted.closest('div[role="region"], nav, footer') || anyMuted.tagName === 'BUTTON')) return true;
  return false;
}

function notifyMicStateChange() {
  if (!isContextValid()) { cleanUpScript(); return; }
  const cur = getMeetMicStatus();
  if (cur !== lastMuteState) {
    lastMuteState = cur;
    safeSendMessage({ type: 'MEET_MIC_STATUS_CHANGED', isMuted: cur });
  }
}

function triggerStateCheck() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(notifyMicStateChange, 30);
}

/* ── Participant Discovery ────────────────────────────────────────────────── */
function extractParticipantNames() {
  let selfName = '';
  const roomParticipants = new Set();

  const selfEl = document.querySelector('[data-self-name]');
  if (selfEl) {
    const n = (selfEl.getAttribute('data-self-name') || '').trim();
    if (n && n.length >= 2 && n.length <= 40 && !['You','آپ'].includes(n)) {
      selfName = n; discoveredSelfName = n;
    }
  }

  if (!selfName) {
    for (const el of document.querySelectorAll('[aria-label*="(You)"], [aria-label*="(آپ)"], [title*="(You)"]')) {
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const m = raw.match(/^(.*?)\s*\((?:You|آپ|Presentation|Your presentation)\)/i);
      if (m && m[1] && m[1].trim().length >= 2) {
        selfName = m[1].trim(); discoveredSelfName = selfName; break;
      }
    }
  }

  const IGNORED = new Set([
    'you','آپ','chat','people','host controls','activities','meeting details',
    'turn on microphone','turn off microphone','turn on camera','turn off camera',
    'raise hand','more options','leave call','info','participants','send a message to everyone',
    'call details','pin','mute','unmute','grid view','speaker view','presentation',
    'your presentation','gemini','meet','google meet'
  ]);

  const candidates = document.querySelectorAll([
    'div[data-requested-participant-id] [title]',
    'div[data-participant-id] [title]',
    'div[data-participant-id]',
    'div[data-self-name]',
    'div[data-participant-name]',
    'div[role="listitem"] span[title]',
    'span[jsname="WQtWae"]',
    'div[jsname="xySENc"]'
  ].join(', '));

  candidates.forEach(el => {
    let t = (el.getAttribute('title') || el.getAttribute('data-participant-name') || el.innerText || '').split('\n')[0].trim();
    t = t.replace(/\s*\((?:You|آپ|Presentation|Host|Meeting host|Guest|External)\)/ig, '').trim();
    if (t && t.length >= 2 && t.length <= 40 && !t.includes('http') && !t.includes(':') && !IGNORED.has(t.toLowerCase())) {
      roomParticipants.add(t);
      discoveredParticipantsSet.add(t);
    }
  });

  const all = Array.from(new Set([...Array.from(discoveredParticipantsSet), ...Array.from(roomParticipants)]));
  const remote = all.filter(n => n !== selfName);
  return {
    selfName: selfName || '',
    remoteParticipants: remote,
    allParticipants: Array.from(new Set([selfName, ...all])).filter(Boolean)
  };
}

/* ── DOM Observer (mic + participants) ───────────────────────────────────── */
function initObserver() {
  if (!isContextValid()) return;
  removeCaptionsOverlayStyle();

  domObserver = new MutationObserver(() => {
    triggerStateCheck();
    extractParticipantNames();
  });
  domObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-is-muted','aria-label','data-tooltip','class','title','data-participant-id'],
    subtree: true,
    childList: true
  });

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) setTimeout(triggerStateCheck, 20);
  });
  window.addEventListener('click', () => setTimeout(triggerStateCheck, 20));

  pollInterval = setInterval(() => {
    if (!isContextValid()) { cleanUpScript(); return; }
    triggerStateCheck();
    extractParticipantNames();
  }, 300);

  notifyMicStateChange();
  extractParticipantNames();
}

/* ── Re-injection guard ──────────────────────────────────────────────────── */
if (window.__meetScribeContentLoaded) {
  console.log('[MeetScribe] Re-injected — cleaning up previous instance…');
  cleanUpScript();
  isCapturingCaptions = false;
  captionSegments.clear();
  captionsHistory = [];
  lastSnapshotKey = '';
}
window.__meetScribeContentLoaded = true;

/* ── Message Listener ────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isContextValid()) return false;

  if (message.type === 'START_CAPTIONS_CAPTURE') {
    captionSegments.clear();
    captionsHistory = [];
    uniqueSpeakersSet.clear();
    lastSnapshotKey = '';
    startCaptionsObserver();
    sendResponse({ success: true });
    return true;

  } else if (message.type === 'STOP_CAPTIONS_CAPTURE' || message.type === 'GET_CAPTIONS_TRANSCRIPT') {
    const data = stopCaptionsObserver();
    sendResponse({ success: true, ...data });
    return true;

  } else if (message.type === 'GET_MEET_MIC_STATUS') {
    lastMuteState = getMeetMicStatus();
    sendResponse({ isMuted: lastMuteState });
    return true;

  } else if (message.type === 'GET_MEET_PARTICIPANTS') {
    sendResponse({ participants: extractParticipantNames() });
    return true;
  }
});

/* ── Bootstrap ───────────────────────────────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initObserver);
} else {
  initObserver();
}
