/* Quiz Room — app logic
   Everything is driven off a single Firebase Realtime Database room object:
   rooms/{CODE} = {
     hostId, hostName, status: 'lobby'|'active'|'ended',
     currentIndex, revealed,
     questions: [{type:'objective'|'subjective', text, options?, correctIndex?}],
     players: { playerId: { name, score, joinedAt } },
     responses: { [qIndex]: { [playerId]: { answer, isCorrect? } } }
   }
*/

// ---------- setup ----------

const CONFIGURED = firebaseConfig.apiKey !== "YOUR_API_KEY";
let db = null;
if (CONFIGURED) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
}

const AI_CONFIGURED = typeof aiConfig !== 'undefined' &&
  !!aiConfig.apiKey && aiConfig.apiKey !== "YOUR_ANTHROPIC_API_KEY";

const MY_ID = getOrCreateMyId();
let session = loadSession();      // { code, role: 'host'|'player', name }
let currentRoomData = null;
let roomRef = null;
let roomListener = null;

let draftQuestions = [];          // host-only, local until "Start game"
let builderType = 'objective';
let builderOptions = ['', ''];
let builderTextDraft = '';
let builderTimerDraft = '';
let builderCorrectIndex = 0;
let editingDraftIndex = null;     // set while editing an existing draft question
let selectedAnswerThisRender = null; // guards double-submit on objective click

let aiTopicDraft = '';            // host-only, remembers AI panel input across re-renders
let aiCountDraft = 5;
let aiGenState = 'idle';          // 'idle' | 'loading' | 'error'
let aiGenError = '';

let liveAddOpen = false;          // host-only, mid-game "add question" panel
let liveBuilderType = 'objective';
let liveBuilderOptions = ['', ''];
let liveBuilderTimer = '';
let liveAddBusy = false;

let serverOffset = 0;             // ms offset between local clock and Firebase server clock
let lastAutoRevealIndex = null;   // guards against re-triggering auto-reveal for the same question
let lastPlayerTimerRenderIndex = null;
let timerTickHandle = null;

let theme = localStorage.getItem('qr_theme') || 'light';

// ---------- storage helpers ----------

function getOrCreateMyId() {
  let id = localStorage.getItem('qr_myid');
  if (!id) {
    id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('qr_myid', id);
  }
  return id;
}

function saveSession(code, role, name) {
  session = { code, role, name };
  localStorage.setItem('qr_session', JSON.stringify(session));
}

function clearSession() {
  session = null;
  localStorage.removeItem('qr_session');
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('qr_session'));
  } catch (e) {
    return null;
  }
}

// ---------- utils ----------

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function sortedPlayers(data) {
  const players = data.players || {};
  return Object.entries(players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function joinLinkForCode(code) {
  return location.origin + location.pathname + '?join=' + encodeURIComponent(code);
}

// ---------- toasts ----------

function showToast(message, kind) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

// ---------- confetti ----------

function launchConfetti() {
  const layer = document.getElementById('confettiLayer');
  if (!layer) return;
  const colors = ['#8FB39B', '#E3A7A0', '#E8B75E', '#6B9880', '#CB817A'];
  for (let i = 0; i < 46; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    piece.style.animationDelay = (Math.random() * 0.5) + 's';
    piece.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), 4600);
  }
}

// ---------- theme ----------

function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('qr_theme', theme);
  applyTheme();
}

// ---------- per-question timer ----------
// Ticks independently of the Firebase-driven re-renders so a countdown can move
// smoothly without redrawing (and losing focus on) the whole room panel.

function tickActiveTimer() {
  const data = currentRoomData;
  if (!data || data.status !== 'active' || !session) return;
  const q = data.questions && data.questions[data.currentIndex];
  if (!q || !q.timerSeconds) return;

  const fill = document.getElementById('timerFill');
  const text = document.getElementById('timerText');
  if (!fill && !text) return; // not currently rendered

  const now = Date.now() + serverOffset;
  const startedAt = data.questionStartedAt || now;
  const totalMs = q.timerSeconds * 1000;
  const remainingMs = Math.max(0, startedAt + totalMs - now);
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  if (fill) {
    fill.style.width = pct + '%';
    fill.classList.toggle('low', remainingMs <= 5000);
  }
  if (text) text.textContent = Math.ceil(remainingMs / 1000) + 's';

  if (remainingMs <= 0) {
    if (session.role === 'host' && !data.revealed && lastAutoRevealIndex !== data.currentIndex) {
      lastAutoRevealIndex = data.currentIndex;
      roomRef.update({ revealed: true });
    }
    if (session.role === 'player' && lastPlayerTimerRenderIndex !== data.currentIndex) {
      lastPlayerTimerRenderIndex = data.currentIndex;
      renderPlayer(data); // re-render once to lock the answer UI
    }
  }
}

function timerBlockHtml(q) {
  if (!q.timerSeconds) return '';
  return `
    <div class="timer-block">
      <div class="timer-bar-track"><div class="timer-bar-fill" id="timerFill"></div></div>
      <div class="timer-text" id="timerText">${q.timerSeconds}s</div>
    </div>
  `;
}

// ---------- AI quiz generation ----------
// Calls the Anthropic API directly from the browser (uses the key in ai-config.js)
// and turns the response into an array of objective (multiple-choice) questions
// in the same shape the manual question builder produces.

async function generateQuizWithAI(topic, count) {
  const prompt = `Write ${count} original multiple-choice quiz questions on this topic: "${topic}".

Respond with ONLY a raw JSON array — no markdown code fences, no commentary before or after it.
Each array item must look exactly like this:
{"text": "question text", "options": ["option A", "option B", "option C", "option D"], "correctIndex": 0}

Rules:
- Exactly 4 answer options per question.
- "correctIndex" is the 0-based index into "options" of the single correct answer.
- Questions must be original wording (a quiz ABOUT the topic), not copied passages of any source text.
- Vary which option index is correct across questions — don't always make it 0.
- Keep each question under 160 characters and each option under 60 characters.
- Return exactly ${count} items, no more, no fewer.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": aiConfig.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    if (res.status === 401) throw new Error('That API key was rejected. Check ai-config.js.');
    throw new Error('AI request failed' + (detail ? ': ' + detail : ` (status ${res.status}).`));
  }

  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('The AI returned an empty response.');

  let raw = textBlock.text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Could not read the AI\'s response as a question list. Try again.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('The AI response wasn\'t in the expected format. Try again.');
  }

  const questions = parsed.map(q => {
    const text = String(q && q.text || '').trim();
    const options = Array.isArray(q && q.options) ? q.options.map(o => String(o).trim()).filter(Boolean) : [];
    let correctIndex = Number.isInteger(q && q.correctIndex) ? q.correctIndex : 0;
    if (correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
    return { type: 'objective', text, options, correctIndex };
  }).filter(q => q.text && q.options.length >= 2);

  if (questions.length === 0) throw new Error('The AI didn\'t return any usable questions. Try rephrasing the topic.');
  return questions;
}

// ---------- boot ----------

document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);

  if (!CONFIGURED) {
    document.getElementById('configWarning').style.display = 'block';
    document.getElementById('hostNameBtn').disabled = true;
    document.getElementById('joinBtn').disabled = true;
  }

  wireHomeEvents();
  document.getElementById('leaveBtn').addEventListener('click', leaveRoom);
  document.getElementById('copyCodeBtn').addEventListener('click', copyCode);

  // Prefill the join code from a shared invite link (?join=CODE)
  const params = new URLSearchParams(location.search);
  const joinParam = params.get('join');
  if (joinParam && !session) {
    document.getElementById('joinCodeInput').value = joinParam.toUpperCase();
    document.getElementById('joinNameInput').focus();
  }

  if (session && CONFIGURED) {
    attachToRoom(session.code);
    showView('view-room');
  }

  if (CONFIGURED) {
    db.ref('.info/serverTimeOffset').on('value', snap => { serverOffset = snap.val() || 0; });
    db.ref('.info/connected').on('value', snap => {
      if (snap.val() === false && session) showToast('Connection lost — reconnecting…', 'warn');
    });
  }

  timerTickHandle = setInterval(tickActiveTimer, 400);
});

// ---------- home screen ----------

function wireHomeEvents() {
  document.getElementById('hostNameBtn').addEventListener('click', createRoom);
  document.getElementById('joinBtn').addEventListener('click', joinRoom);
}

function createRoom() {
  const nameInput = document.getElementById('hostNameInput');
  const name = nameInput.value.trim();
  const errEl = document.getElementById('hostError');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Enter your name first.'; return; }

  const btn = document.getElementById('hostNameBtn');
  btn.disabled = true;
  btn.textContent = 'Creating room…';

  tryCreateWithFreshCode(name, 0, btn);
}

function tryCreateWithFreshCode(name, attempt, btn) {
  const code = genCode();
  db.ref('rooms/' + code).once('value').then(snap => {
    if (snap.exists() && attempt < 5) {
      tryCreateWithFreshCode(name, attempt + 1, btn);
      return;
    }
    const room = {
      hostId: MY_ID,
      hostName: name,
      status: 'lobby',
      currentIndex: -1,
      revealed: false,
      createdAt: Date.now(),
      questions: [],
      players: {},
      responses: {}
    };
    db.ref('rooms/' + code).set(room).then(() => {
      draftQuestions = [];
      saveSession(code, 'host', name);
      attachToRoom(code);
      showView('view-room');
      btn.disabled = false;
      btn.textContent = 'Create room';
    }).catch(err => {
      btn.disabled = false;
      btn.textContent = 'Create room';
      document.getElementById('hostError').textContent = 'Could not create room: ' + err.message;
    });
  });
}

function joinRoom() {
  const nameInput = document.getElementById('joinNameInput');
  const codeInput = document.getElementById('joinCodeInput');
  const errEl = document.getElementById('joinError');
  errEl.textContent = '';

  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();

  if (!name) { errEl.textContent = 'Enter your name first.'; return; }
  if (!code) { errEl.textContent = 'Enter the room code.'; return; }

  const btn = document.getElementById('joinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining…';

  db.ref('rooms/' + code).once('value').then(snap => {
    btn.disabled = false;
    btn.textContent = 'Join room';
    if (!snap.exists()) {
      errEl.textContent = "That room code doesn't exist. Double-check it with the host.";
      return;
    }
    const data = snap.val();
    if (data.status === 'ended') {
      errEl.textContent = 'This game has already ended.';
      return;
    }
    return db.ref('rooms/' + code + '/players/' + MY_ID).set({
      name, score: 0, joinedAt: Date.now()
    }).then(() => {
      saveSession(code, 'player', name);
      attachToRoom(code);
      showView('view-room');
    });
  }).catch(err => {
    btn.disabled = false;
    btn.textContent = 'Join room';
    errEl.textContent = 'Something went wrong: ' + err.message;
  });
}

function copyCode() {
  if (!session) return;
  const text = session.code;
  const done = () => {
    const btn = document.getElementById('copyCodeBtn');
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1400);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    done();
  }
}

function leaveRoom() {
  if (roomRef && roomListener) roomRef.off('value', roomListener);
  roomRef = null;
  roomListener = null;
  currentRoomData = null;
  clearSession();
  draftQuestions = [];
  editingDraftIndex = null;
  liveAddOpen = false;
  lastAutoRevealIndex = null;
  lastPlayerTimerRenderIndex = null;
  document.getElementById('hostNameInput').value = '';
  document.getElementById('joinNameInput').value = '';
  document.getElementById('joinCodeInput').value = '';
  showView('view-home');
}

// ---------- room subscription ----------

function attachToRoom(code) {
  if (roomRef && roomListener) roomRef.off('value', roomListener);
  roomRef = db.ref('rooms/' + code);
  roomListener = roomRef.on('value', snap => {
    const data = snap.val();
    if (!data) {
      showToast('This room no longer exists.', 'warn');
      leaveRoom();
      return;
    }
    if (session && session.role === 'player' && data.kicked && data.kicked[MY_ID]) {
      showToast('The host removed you from this room.', 'warn');
      leaveRoom();
      return;
    }
    currentRoomData = data;
    renderRoom(data);
  });
}

// ---------- top-level room render ----------

function renderRoom(data) {
  document.getElementById('topbarCode').textContent = session.code;
  const pill = document.getElementById('statusPill');
  const labels = { lobby: 'Lobby', active: 'Live', ended: 'Ended' };
  pill.textContent = labels[data.status] || data.status;
  pill.classList.toggle('live', data.status === 'active');

  if (session.role === 'host') {
    renderHost(data);
  } else {
    renderPlayer(data);
  }
}

// =====================================================================
// HOST VIEWS
// =====================================================================

function renderHost(data) {
  const el = document.getElementById('roomContent');
  if (data.status === 'lobby') {
    el.innerHTML = hostLobbyHtml(data);
    wireHostLobbyEvents(data);
  } else if (data.status === 'active') {
    el.innerHTML = hostActiveHtml(data);
    wireHostActiveEvents(data);
  } else {
    el.innerHTML = hostEndedHtml(data);
    wireHostEndedEvents();
  }
}

function hostLobbyHtml(data) {
  const players = sortedPlayers(data);
  const playersHtml = players.length
    ? `<div class="player-chip-list">${players.map(p => `
        <span class="player-chip kickable">
          <span class="avatar-dot"></span>${escapeHtml(p.name)}
          <button class="kick-btn" data-kick="${p.id}" title="Remove ${escapeHtml(p.name)}" type="button">✕</button>
        </span>
      `).join('')}</div>`
    : `<p class="empty-note">Nobody has joined yet. Share the code or QR below.</p>`;

  const qListHtml = draftQuestions.length
    ? draftQuestions.map((q, i) => `
        <div class="q-list-item">
          <div>
            <div class="qtxt">${i + 1}. ${escapeHtml(q.text)}</div>
            <div class="qmeta">
              <span class="tag ${q.type}">${q.type === 'objective' ? 'Objective' : 'Subjective'}</span>
              ${q.type === 'objective' ? ` &middot; ${q.options.length} options` : ''}
              ${q.timerSeconds ? ` &middot; ${q.timerSeconds}s timer` : ''}
            </div>
          </div>
          <div class="q-actions">
            <button class="icon-link" data-move-up="${i}" title="Move up" type="button" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-link" data-move-down="${i}" title="Move down" type="button" ${i === draftQuestions.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-link" data-duplicate="${i}" title="Duplicate" type="button">⧉</button>
            <button class="remove-link" data-edit="${i}">Edit</button>
            <button class="remove-link" data-remove="${i}">Remove</button>
          </div>
        </div>
      `).join('')
    : `<p class="empty-note">No questions added yet.</p>`;

  const joinLink = joinLinkForCode(session.code);

  return `
    <div class="invite-block">
      <div class="invite-qr" id="qrCode"></div>
      <div class="invite-info">
        <div class="section-title" style="margin-bottom:4px;">Invite players</div>
        <p class="hint" style="margin-bottom:0;">Share the code, scan the QR, or send the link — works across devices.</p>
        <div class="invite-link-row">
          <input type="text" readonly value="${joinLink}" id="inviteLinkInput" onclick="this.select()">
          <button class="btn btn-ghost" id="copyLinkBtn" type="button">Copy link</button>
        </div>
      </div>
    </div>

    <div class="two-col">
      <div>
        ${aiPanelHtml()}

        <div class="section-title">Build your questions</div>
        <div class="q-builder">
          ${editingDraftIndex !== null ? `<div class="editing-tag">Editing question ${editingDraftIndex + 1} — saving will update it in place</div>` : ''}
          <div class="type-toggle">
            <button type="button" data-type="objective" class="${builderType === 'objective' ? 'active' : ''}">Objective (multiple choice)</button>
            <button type="button" data-type="subjective" class="${builderType === 'subjective' ? 'active' : ''}">Subjective (open answer)</button>
          </div>
          <div class="field">
            <label for="qText">Question</label>
            <textarea id="qText" placeholder="${builderType === 'objective' ? 'e.g. What year did the first moon landing happen?' : 'e.g. What is your favourite childhood memory?'}">${escapeHtml(builderTextDraft)}</textarea>
          </div>
          ${builderType === 'objective' ? optionsBuilderHtml() : ''}
          <div class="timer-field-row">
            <div class="field">
              <label for="qTimer">Time limit (optional)</label>
              <input type="number" id="qTimer" min="5" max="300" placeholder="No limit" value="${escapeHtml(builderTimerDraft)}">
            </div>
            <small>Seconds per question — leave blank for untimed.</small>
          </div>
          <div class="controls-bar" style="margin-top:14px;">
            <button class="btn btn-primary" id="addQBtn" type="button">${editingDraftIndex !== null ? 'Save question' : 'Add question'}</button>
            ${editingDraftIndex !== null ? `<button class="btn btn-ghost" id="cancelEditBtn" type="button">Cancel edit</button>` : ''}
          </div>
          <div class="error-msg" id="builderError"></div>
        </div>

        <div class="section-title">Questions in this game (${draftQuestions.length})</div>
        <div id="qList">${qListHtml}</div>

        <div class="controls-bar">
          <button class="btn btn-secondary" id="startBtn" type="button" ${draftQuestions.length === 0 ? 'disabled' : ''}>Start game</button>
        </div>
        <p class="footnote">Questions are drafted in your browser and go live once you hit "Start game" — you can still add more once the game is running.</p>
      </div>

      <div>
        <div class="section-title">Players (${sortedPlayers(data).length})</div>
        ${playersHtml}
      </div>
    </div>
  `;
}

function aiPanelHtml() {
  if (!AI_CONFIGURED) {
    return `
      <div class="ai-not-configured">
        <strong>Want AI-generated questions?</strong> Open <code>ai-config.js</code> and paste in an
        Anthropic API key from <code>console.anthropic.com</code>. Once it's set, a "Generate with AI"
        panel appears here — type a topic like <em>"Photosynthesis, Class 10 Science"</em> or
        <em>"Chapter 5 of the Book of Mark"</em> and it'll draft multiple-choice questions for you.
      </div>
    `;
  }

  return `
    <div class="ai-panel">
      <div class="ai-panel-title"><span class="sparkle">✨</span> Generate with AI</div>
      <p class="hint">Describe a topic — a subject and grade, a book chapter, anything — and get a ready-made multiple-choice quiz you can review and edit before starting.</p>
      <div class="ai-gen-row">
        <div class="field">
          <label for="aiTopicInput">Topic</label>
          <input type="text" id="aiTopicInput" placeholder="e.g. Photosynthesis, Class 10 Science" value="${escapeHtml(aiTopicDraft)}" maxlength="200">
        </div>
        <div class="field">
          <label for="aiCountInput"># Questions</label>
          <input type="number" id="aiCountInput" min="1" max="20" value="${aiCountDraft}">
        </div>
        <button class="btn btn-gold" id="aiGenerateBtn" type="button" ${aiGenState === 'loading' ? 'disabled' : ''}>
          ${aiGenState === 'loading' ? 'Generating…' : 'Generate quiz'}
        </button>
      </div>
      <div class="error-msg">${aiGenState === 'error' ? escapeHtml(aiGenError) : ''}</div>
    </div>
  `;
}

function optionsBuilderHtml() {
  return `
    <div class="field">
      <label>Answer options — pick the correct one</label>
      <div id="optionRows">
        ${builderOptions.map((val, i) => `
          <div class="option-row">
            <input type="radio" name="correctOpt" value="${i}" id="opt-radio-${i}" ${i === builderCorrectIndex ? 'checked' : ''}>
            <input type="text" data-opt-index="${i}" placeholder="Option ${i + 1}" value="${escapeHtml(val)}">
          </div>
        `).join('')}
      </div>
      <button type="button" class="subtle-link" id="addOptionBtn" ${builderOptions.length >= 6 ? 'disabled' : ''}>+ Add another option</button>
    </div>
  `;
}

function wireHostLobbyEvents(data) {
  const aiTopicInput = document.getElementById('aiTopicInput');
  const aiCountInput = document.getElementById('aiCountInput');
  if (aiTopicInput) aiTopicInput.addEventListener('input', () => { aiTopicDraft = aiTopicInput.value; });
  if (aiCountInput) aiCountInput.addEventListener('input', () => { aiCountDraft = aiCountInput.value; });

  const aiGenerateBtn = document.getElementById('aiGenerateBtn');
  if (aiGenerateBtn) {
    aiGenerateBtn.addEventListener('click', () => {
      const topic = (aiTopicInput ? aiTopicInput.value : aiTopicDraft).trim();
      let count = parseInt(aiCountInput ? aiCountInput.value : aiCountDraft, 10);
      if (!topic) {
        aiGenState = 'error';
        aiGenError = 'Enter a topic first — e.g. "Photosynthesis, Class 10" or "Chapter Mark from the Holy Bible".';
        renderHost(data);
        return;
      }
      if (!Number.isFinite(count) || count < 1) count = 5;
      if (count > 20) count = 20;
      aiTopicDraft = topic;
      aiCountDraft = count;
      aiGenState = 'loading';
      aiGenError = '';
      renderHost(data);

      generateQuizWithAI(topic, count).then(questions => {
        draftQuestions = draftQuestions.concat(questions);
        aiGenState = 'idle';
        aiTopicDraft = '';
        renderHost(data);
      }).catch(err => {
        aiGenState = 'error';
        aiGenError = err.message || 'Something went wrong generating the quiz.';
        renderHost(data);
      });
    });
  }

  document.querySelectorAll('[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      builderType = btn.dataset.type;
      renderHost(data);
    });
  });

  const addOptBtn = document.getElementById('addOptionBtn');
  if (addOptBtn) {
    addOptBtn.addEventListener('click', () => {
      syncOptionInputsToState();
      if (builderOptions.length < 6) builderOptions.push('');
      renderHost(data);
    });
  }

  const addQBtn = document.getElementById('addQBtn');
  addQBtn.addEventListener('click', () => {
    const text = document.getElementById('qText').value.trim();
    const errEl = document.getElementById('builderError');
    errEl.textContent = '';

    if (!text) { errEl.textContent = 'Write the question text first.'; return; }

    if (builderType === 'objective') {
      syncOptionInputsToState();
      const opts = builderOptions.map(o => o.trim()).filter(o => o.length > 0);
      if (opts.length < 2) { errEl.textContent = 'Add at least 2 answer options.'; return; }
      const radios = document.getElementsByName('correctOpt');
      let correctIndex = 0;
      radios.forEach(r => { if (r.checked) correctIndex = parseInt(r.value, 10); });
      if (correctIndex >= opts.length) correctIndex = 0;
      draftQuestions.push({ type: 'objective', text, options: opts, correctIndex });
    } else {
      draftQuestions.push({ type: 'subjective', text });
    }

    builderOptions = ['', ''];
    renderHost(data);
  });

  document.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      draftQuestions.splice(parseInt(btn.dataset.remove, 10), 1);
      renderHost(data);
    });
  });

  const startBtn = document.getElementById('startBtn');
  startBtn.addEventListener('click', () => {
    if (draftQuestions.length === 0) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    roomRef.update({
      questions: draftQuestions,
      status: 'active',
      currentIndex: 0,
      revealed: false,
      responses: {}
    });
  });
}

function syncOptionInputsToState() {
  document.querySelectorAll('#optionRows input[type="text"]').forEach(inp => {
    builderOptions[parseInt(inp.dataset.optIndex, 10)] = inp.value;
  });
}

function hostActiveHtml(data) {
  const q = data.questions[data.currentIndex];
  const total = data.questions.length;
  const responses = (data.responses && data.responses[data.currentIndex]) || {};
  const respCount = Object.keys(responses).length;
  const playerCount = sortedPlayers(data).length;

  let body = '';
  if (q.type === 'objective') {
    const counts = q.options.map((_, i) => Object.values(responses).filter(r => r.answer === i).length);
    const max = Math.max(1, ...counts);
    body = `
      <div class="answer-options">
        ${q.options.map((opt, i) => `
          <div class="tally-row">
            <div style="min-width: 34%;">${escapeHtml(opt)}</div>
            <div class="tally-bar-track"><div class="tally-bar-fill" style="width:${(counts[i] / max) * 100}%"></div></div>
            <div class="tally-count">${counts[i]}</div>
          </div>
        `).join('')}
      </div>
      ${data.revealed ? `<p style="margin-top:14px; color: var(--sage-deep); font-weight:600;">Correct answer: ${escapeHtml(q.options[q.correctIndex])}</p>` : ''}
    `;
  } else {
    const entries = Object.entries(responses);
    body = entries.length
      ? `<div class="response-list">${entries.map(([pid, r]) => `
          <div class="response-card">
            <div class="who">${escapeHtml((data.players[pid] || {}).name || 'Someone')}</div>
            <div class="what">${escapeHtml(r.answer)}</div>
          </div>`).join('')}</div>`
      : `<p class="empty-note">No answers yet.</p>`;
  }

  const isLast = data.currentIndex >= total - 1;

  return `
    <div class="active-question-card">
      <div class="q-index-label">Question ${data.currentIndex + 1} of ${total} &middot; ${respCount}/${playerCount} answered</div>
      <h3>${escapeHtml(q.text)}</h3>
      ${body}
    </div>
    <div class="controls-bar">
      ${!data.revealed ? `<button class="btn btn-gold" id="revealBtn" type="button">${q.type === 'objective' ? 'Reveal correct answer' : 'Share answers with everyone'}</button>` : ''}
      <button class="btn btn-primary" id="nextBtn" type="button">${isLast ? 'Finish game' : 'Next question'}</button>
    </div>
  `;
}

function wireHostActiveEvents(data) {
  const revealBtn = document.getElementById('revealBtn');
  if (revealBtn) {
    revealBtn.addEventListener('click', () => {
      roomRef.update({ revealed: true });
    });
  }
  document.getElementById('nextBtn').addEventListener('click', () => {
    const total = data.questions.length;
    if (data.currentIndex >= total - 1) {
      roomRef.update({ status: 'ended' });
    } else {
      roomRef.update({ currentIndex: data.currentIndex + 1, revealed: false });
    }
  });
}

function hostEndedHtml(data) {
  const players = sortedPlayers(data);
  const rows = players.length
    ? players.map((p, i) => `
        <div class="leaderboard-row ${i === 0 ? 'first' : ''}">
          <div class="leaderboard-rank">${i + 1}</div>
          <div class="leaderboard-name">${escapeHtml(p.name)}</div>
          <div class="leaderboard-score">${p.score || 0} pt${(p.score || 0) === 1 ? '' : 's'}</div>
        </div>
      `).join('')
    : `<p class="empty-note">No players joined this game.</p>`;

  return `
    <h2 style="margin-bottom:16px;">Final results</h2>
    ${rows}
    <div class="controls-bar">
      <button class="btn btn-secondary" id="closeRoomBtn" type="button">Close room &amp; start a new one</button>
    </div>
  `;
}

function wireHostEndedEvents() {
  document.getElementById('closeRoomBtn').addEventListener('click', () => {
    if (roomRef) roomRef.remove();
    leaveRoom();
  });
}

// =====================================================================
// PLAYER VIEWS
// =====================================================================

function renderPlayer(data) {
  const el = document.getElementById('roomContent');
  if (data.status === 'lobby') {
    el.innerHTML = playerLobbyHtml(data);
  } else if (data.status === 'active') {
    el.innerHTML = playerActiveHtml(data);
    wirePlayerActiveEvents(data);
  } else {
    el.innerHTML = playerEndedHtml(data);
  }
}

function playerLobbyHtml(data) {
  const players = sortedPlayers(data);
  return `
    <div class="waiting-block">
      <div class="big-dot-loader"><span></span><span></span><span></span></div>
      <h3 style="margin-bottom:8px;">Waiting for ${escapeHtml(data.hostName)} to start the game…</h3>
      <p>You're in! Sit tight while everyone else joins.</p>
    </div>
    <div class="section-title">Players here (${players.length})</div>
    <div class="player-chip-list">
      ${players.map(p => `<span class="player-chip"><span class="avatar-dot"></span>${escapeHtml(p.name)}${p.id === MY_ID ? ' <span class="badge-you">(you)</span>' : ''}</span>`).join('')}
    </div>
  `;
}

function playerActiveHtml(data) {
  const q = data.questions[data.currentIndex];
  const total = data.questions.length;
  const myResponse = (data.responses && data.responses[data.currentIndex] && data.responses[data.currentIndex][MY_ID]) || null;

  let body = '';

  if (!myResponse) {
    if (q.type === 'objective') {
      body = `
        <div class="answer-options">
          ${q.options.map((opt, i) => `<button class="answer-option" data-answer="${i}" type="button">${escapeHtml(opt)}</button>`).join('')}
        </div>
      `;
    } else {
      body = `
        <div class="field">
          <textarea id="subjectiveInput" placeholder="Type your answer…" rows="4"></textarea>
        </div>
        <button class="btn btn-primary" id="submitSubjectiveBtn" type="button">Submit answer</button>
      `;
    }
  } else if (!data.revealed) {
    if (q.type === 'objective') {
      body = `
        <div class="answer-options">
          ${q.options.map((opt, i) => `<button class="answer-option ${i === myResponse.answer ? 'selected' : ''}" disabled>${escapeHtml(opt)}</button>`).join('')}
        </div>
        <div class="waiting-block"><div class="big-dot-loader"><span></span><span></span><span></span></div><p>Answer locked in. Waiting for everyone else…</p></div>
      `;
    } else {
      body = `
        <div class="response-card"><div class="who">Your answer</div><div class="what">${escapeHtml(myResponse.answer)}</div></div>
        <div class="waiting-block"><div class="big-dot-loader"><span></span><span></span><span></span></div><p>Waiting for the host…</p></div>
      `;
    }
  } else {
    if (q.type === 'objective') {
      body = `
        <div class="answer-options">
          ${q.options.map((opt, i) => {
            let cls = 'answer-option';
            if (i === q.correctIndex) cls += ' correct-reveal';
            else if (i === myResponse.answer) cls += ' wrong-reveal';
            return `<button class="${cls}" disabled>${escapeHtml(opt)}</button>`;
          }).join('')}
        </div>
        <p style="margin-top:14px; font-weight:600; color:${myResponse.isCorrect ? 'var(--sage-deep)' : 'var(--danger)'};">
          ${myResponse.isCorrect ? 'Correct! +1 point' : 'Not quite this time.'}
        </p>
      `;
    } else {
      const responses = (data.responses && data.responses[data.currentIndex]) || {};
      body = `
        <div class="response-list">
          ${Object.entries(responses).map(([pid, r]) => `
            <div class="response-card">
              <div class="who">${escapeHtml((data.players[pid] || {}).name || 'Someone')}${pid === MY_ID ? ' <span class="badge-you">(you)</span>' : ''}</div>
              <div class="what">${escapeHtml(r.answer)}</div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  return `
    <div class="active-question-card">
      <div class="q-index-label">Question ${data.currentIndex + 1} of ${total}</div>
      <h3>${escapeHtml(q.text)}</h3>
      ${body}
    </div>
  `;
}

function wirePlayerActiveEvents(data) {
  document.querySelectorAll('[data-answer]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (selectedAnswerThisRender) return;
      selectedAnswerThisRender = true;
      const i = parseInt(btn.dataset.answer, 10);
      const q = data.questions[data.currentIndex];
      const isCorrect = i === q.correctIndex;
      roomRef.child('responses/' + data.currentIndex + '/' + MY_ID).set({ answer: i, isCorrect }).then(() => {
        if (isCorrect) {
          roomRef.child('players/' + MY_ID + '/score').transaction(v => (v || 0) + 1);
        }
        selectedAnswerThisRender = false;
      });
    });
  });

  const submitBtn = document.getElementById('submitSubjectiveBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const val = document.getElementById('subjectiveInput').value.trim();
      if (!val) return;
      submitBtn.disabled = true;
      roomRef.child('responses/' + data.currentIndex + '/' + MY_ID).set({ answer: val });
    });
  }
}

function playerEndedHtml(data) {
  const players = sortedPlayers(data);
  const myRank = players.findIndex(p => p.id === MY_ID) + 1;
  const rows = players.map((p, i) => `
    <div class="leaderboard-row ${i === 0 ? 'first' : ''}">
      <div class="leaderboard-rank">${i + 1}</div>
      <div class="leaderboard-name">${escapeHtml(p.name)}${p.id === MY_ID ? ' <span class="badge-you">(you)</span>' : ''}</div>
      <div class="leaderboard-score">${p.score || 0} pt${(p.score || 0) === 1 ? '' : 's'}</div>
    </div>
  `).join('');

  return `
    <h2 style="margin-bottom:16px;">Final results</h2>
    ${myRank ? `<p style="margin-bottom:16px; color: var(--ink-soft);">You finished #${myRank} of ${players.length}.</p>` : ''}
    ${rows}
    <div class="controls-bar">
      <button class="btn btn-ghost" id="leaveEndedBtn" type="button">Back to home</button>
    </div>
  `;
}

document.addEventListener('click', e => {
  if (e.target && e.target.id === 'leaveEndedBtn') leaveRoom();
});
