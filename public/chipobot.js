// chipobot.js
//
// The Chipo student assistant, shared by every page of the site. It injects
// its own markup so the landing page and the student portal can both host
// the assistant without duplicating any code.
//
// Public API: window.chipo.open() / .close() / .ask(question)
(() => {
  'use strict';

  const CHIPO_MARKUP = `
<button class="chat-launcher" id="chatLauncher" type="button" aria-label="Ask Chipo" aria-expanded="false" aria-controls="chatWidgetPanel">
  <svg class="chipo-mascot" id="chipoMascot" viewBox="0 0 100 108" role="img" aria-labelledby="chipoTitle">
    <title id="chipoTitle">Chipo, your student assistant</title>
    <path d="M50 29v11" stroke="#c9a227" stroke-width="3" stroke-linecap="round"/>
    <circle cx="50" cy="23" r="6" fill="#c9a227"/>
    <rect x="5" y="58" width="13" height="19" rx="5" fill="#c9a227"/>
    <rect x="82" y="58" width="13" height="19" rx="5" fill="#c9a227"/>
    <path d="M34 40h32c9 0 15 7 15 16v21c0 9-6 15-15 15H56l-6 8-6-8H34c-9 0-15-6-15-15V56c0-9 6-16 15-16Z" fill="#c9a227"/>
    <ellipse cx="41" cy="59" rx="7" ry="9" fill="#fff"/>
    <ellipse cx="63" cy="59" rx="7" ry="9" fill="#fff"/>
    <ellipse class="chipo-pupil" cx="42" cy="60" rx="3.2" ry="4.7" fill="#172923"/>
    <ellipse class="chipo-pupil" cx="64" cy="60" rx="3.2" ry="4.7" fill="#172923"/>
    <path d="M43 76c4 5 10 5 14 0" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
  </svg>
  <span class="chipo-label" aria-hidden="true">Ask Chipo</span>
</button>
<section class="chat-widget-panel" id="chatWidgetPanel" aria-label="Chipo student assistant">
  <button class="widget-close" id="chatWidgetClose" type="button" aria-label="Close Chipo chat">Ã—</button>
<div class="app">

  <!-- Sidebar -->
  <button class="sidebar-scrim" id="sidebarScrim" type="button" aria-label="Close chat history"></button>
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-crest"><img src="/images/logo.jpeg" alt=""></div>
      <div class="brand-text">
        <h1>University of Lusaka</h1>
        <p>Passion for Quality Education</p>
      </div>
    </div>

    <button class="new-chat-btn" id="newChatBtn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      New conversation
    </button>

    <div class="sidebar-label">Recent</div>
    <div id="historyList">
      <div class="history-item active" data-conv-id="current">Current conversation</div>
    </div>
    <button class="new-chat-btn" id="clearHistoryBtn" style="margin-top:8px; background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.1);">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6v12a2 2 0 002 2h4a2 2 0 002-2V6M10 11v6M14 11v6"/></svg>
      Clear history
    </button>

    <div class="sidebar-footer">
      UNILUS Student Assistant<br>
      Answers are generated from official university materials.
    </div>
  </aside>

  <!-- Main chat -->
  <main class="main">
    <div class="topbar">
      <div style="display:flex; align-items:center;">
        <div class="menu-toggle" id="menuToggle">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </div>
        <h2>Student Assistant</h2>
      </div>
      <div style="display:flex; align-items:center; gap:12px;">
        <div class="access-badge locked" id="accessBadge" title="Sign in to the student portal and Chipo can read your records.">Portal access: locked</div>
        <div class="status"><span class="dot" id="statusDot"></span> <span id="statusText">Online</span></div>
      </div>
    </div>

    <div class="chat-scroll" id="chatScroll">
      <div class="chat-inner" id="chatInner">
        <div class="welcome" id="welcome">
          <h1 class="welcome-hello">Hello,</h1>
          <h1 class="welcome-help">How can I help you today?</h1>

          <div class="suggestions-container">
            <button type="button" class="suggestion-chip" onclick="handleSuggestion('What are the tuition fees for 2026?')">
              <svg class="suggestion-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="6" width="20" height="13" rx="2"/>
                <path d="M2 10h20M6 15h4"/>
              </svg>
              <span>Fees and payments</span>
            </button>
            <button type="button" class="suggestion-chip" onclick="handleSuggestion('Where can I find my timetable?')">
              <svg class="suggestion-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="17" rx="2"/>
                <path d="M3 9h18M8 2v4M16 2v4"/>
              </svg>
              <span>Timetable</span>
            </button>
            <button type="button" class="suggestion-chip" onclick="handleSuggestion('How do I check my results?')">
              <svg class="suggestion-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 3v18h18"/>
                <path d="M7 15l4-5 3 3 5-7"/>
              </svg>
              <span>Results</span>
            </button>
            <button type="button" class="suggestion-chip" onclick="handleSuggestion('I would like to talk to a person from the university.')">
              <svg class="suggestion-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 12a8 8 0 0 1 16 0"/>
                <rect x="2" y="12" width="4" height="7" rx="1.5"/>
                <rect x="18" y="12" width="4" height="7" rx="1.5"/>
                <path d="M20 19a3 3 0 0 1-3 3h-3"/>
              </svg>
              <span>Talk to a person</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="input-bar">
      <div style="width:100%; max-width:760px;">
        <div class="attach-tray" id="attachTray" hidden></div>
        <div class="input-wrap" id="inputWrap">
          <textarea id="question" rows="1" placeholder="Message the Student Assistant..."></textarea>
          <button class="icon-btn" id="attachBtn" title="Attach a file for Chipo to read">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input type="file" id="attachInput" multiple hidden accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.log,.rtf,.png,.jpg,.jpeg,.webp,.gif,.bmp">
          <button class="icon-btn" id="micBtn" title="Voice input">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
          </button>
          <button class="send-btn" id="sendBtn" title="Send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
        <div class="mic-hint" id="micHint"></div>
        <div class="disclaimer">Responses are AI-generated and may not always be accurate.</div>
      </div>
    </div>
  </main>

</div>
</section>
`;

  document.body.insertAdjacentHTML('beforeend', CHIPO_MARKUP);

  const chatInner = document.getElementById('chatInner');
  const chatScroll = document.getElementById('chatScroll');
  const questionEl = document.getElementById('question');
  const sendBtn = document.getElementById('sendBtn');
  const micBtn = document.getElementById('micBtn');
  const inputWrap = document.getElementById('inputWrap');
  const welcome = document.getElementById('welcome');
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const newChatBtn = document.getElementById('newChatBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const micHint = document.getElementById('micHint');
  const historyList = document.getElementById('historyList');
  const accessBadge = document.getElementById('accessBadge');
  const attachBtn = document.getElementById('attachBtn');
  const attachInput = document.getElementById('attachInput');
  const attachTray = document.getElementById('attachTray');

  /* ---------------- Student session (portal access) ---------------- */
  //
  // Chipo can read a student's portal records only inside the student portal,
  // where that student is signed in. The scope decides which chat endpoint
  // the widget talks to:
  //
  //   'site'   the public website — /ask, which never grants portal access.
  //   'portal' the student portal  — /portal/ask, which requires the
  //            student's session and lets Chipo read their records.
  //
  // A token is kept for the current tab only (sessionStorage), so closing the
  // tab or opening the portal in a new tab signs the student out. A token left
  // in localStorage by an older version is discarded.
  const STUDENT_TOKEN_KEY = 'chipo_student_token';
  let session = { token: null, student: null };
  let scope = 'site';

  function storedToken() {
    try { return sessionStorage.getItem(STUDENT_TOKEN_KEY); } catch (err) { return null; }
  }

  function renderAccessBadge() {
    if (!accessBadge) return;
    // Access is only ever granted inside the portal, and only with a session.
    const signedIn = scope === 'portal' && Boolean(session.token);
    accessBadge.classList.toggle('student', signedIn);
    accessBadge.classList.toggle('locked', !signedIn);
    accessBadge.textContent = signedIn
      ? 'Portal access: signed in' + (session.student && session.student.studentNumber
        ? ' (' + session.student.studentNumber + ')'
        : '')
      : 'Portal access: locked';
    accessBadge.title = signedIn
      ? 'Chipo can read this student\'s portal records.'
      : scope === 'portal'
        ? 'Sign in to the student portal and Chipo can read your records.'
        : 'Chipo can only answer general university questions here. Sign in to the student portal for account questions.';
  }

  function setSession(token, student) {
    session = { token: token || null, student: student || null };
    try {
      if (session.token) sessionStorage.setItem(STUDENT_TOKEN_KEY, session.token);
      else sessionStorage.removeItem(STUDENT_TOKEN_KEY);
      localStorage.removeItem(STUDENT_TOKEN_KEY);
    } catch (err) { /* private browsing — the session just won't persist */ }
    renderAccessBadge();
  }

  function clearSession() {
    setSession(null, null);
  }

  /**
   * Say which chat endpoint the widget should use.
   * @param {'site'|'portal'} next
   */
  function setScope(next) {
    scope = next === 'portal' ? 'portal' : 'site';
    renderAccessBadge();
  }

  // History tracking
  let conversationHistory = [];
  let currentConvId = 'current';
  let savedConversations = {};

  // Load saved conversations from localStorage
  function loadSavedConversations() {
    const saved = localStorage.getItem('conversationHistory');
    if (saved) {
      try {
        savedConversations = JSON.parse(saved);
      } catch (e) {
        savedConversations = {};
      }
    }
  }

  // Save conversations to localStorage
  function saveConversations() {
    localStorage.setItem('conversationHistory', JSON.stringify(savedConversations));
  }

  // Render the history list in the sidebar
  function renderHistoryList() {
    const items = historyList.querySelectorAll('.history-item:not([data-conv-id="current"])');
    items.forEach(item => item.remove());

    // Add saved conversations in reverse order (newest first)
    const convIds = Object.keys(savedConversations).reverse();
    for (const convId of convIds) {
      const conv = savedConversations[convId];
      const item = document.createElement('div');
      item.className = 'history-item';
      item.setAttribute('data-conv-id', convId);

      const text = document.createElement('div');
      text.className = 'history-item-text';
      text.title = conv.title;
      text.textContent = conv.title;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-item-delete';
      deleteBtn.innerHTML = 'Ã—';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(convId);
      });

      item.appendChild(text);
      item.appendChild(deleteBtn);
      item.addEventListener('click', () => loadConversation(convId));

      historyList.appendChild(item);
    }
  }

  // Save current conversation before starting new one
  function saveCurrentConversation() {
    if (conversationHistory.length > 0) {
      const title = conversationHistory[0].question.substring(0, 50) +
                    (conversationHistory[0].question.length > 50 ? '...' : '');
      const convId = Date.now().toString();

      // Get all message elements to reconstruct the conversation display
      const messages = [];
      chatInner.querySelectorAll('.msg-row').forEach(row => {
        const text = row.querySelector('.bubble')?.textContent || '';
        const isUser = row.classList.contains('user');
        messages.push({ role: isUser ? 'user' : 'bot', text });
      });

      savedConversations[convId] = {
        title,
        timestamp: new Date().toLocaleString(),
        history: conversationHistory,
        messages
      };

      saveConversations();
      renderHistoryList();
    }
  }

  // Load a saved conversation
  function loadConversation(convId) {
    const conv = savedConversations[convId];
    if (!conv) return;

    currentConvId = convId;
    conversationHistory = JSON.parse(JSON.stringify(conv.history));

    // Clear and rebuild chat display
    chatInner.innerHTML = '';
    for (const msg of conv.messages) {
      addMessage(msg.role, msg.text);
    }

    // Update active state in sidebar
    historyList.querySelectorAll('.history-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-conv-id') === convId);
    });

    toggleSidebar(false);
  }

  // Delete a saved conversation
  function deleteConversation(convId) {
    delete savedConversations[convId];
    saveConversations();
    renderHistoryList();
  }

  // Clear all history
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Delete all conversation history? This cannot be undone.')) {
      savedConversations = {};
      saveConversations();
      renderHistoryList();
    }
  });

  const sidebarScrim = document.getElementById('sidebarScrim');
  function toggleSidebar(open) {
    sidebar.classList.toggle('open', open);
    sidebarScrim.classList.toggle('visible', open);
    menuToggle.setAttribute('aria-expanded', String(open));
  }
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open chat history');
  menuToggle.addEventListener('click', () => toggleSidebar(!sidebar.classList.contains('open')));
  sidebarScrim.addEventListener('click', () => toggleSidebar(false));

  newChatBtn.addEventListener('click', () => {
    saveCurrentConversation();
    chatInner.innerHTML = '';
    chatInner.appendChild(welcome);
    questionEl.value = '';
    conversationHistory = [];
    currentConvId = 'current';
    pendingFiles = [];
    renderAttachTray();

    // Update active state in sidebar
    historyList.querySelectorAll('.history-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-conv-id') === 'current');
    });

    toggleSidebar(false);
    window.speechSynthesis && window.speechSynthesis.cancel();
  });

  // auto-grow textarea
  questionEl.addEventListener('input', () => {
    questionEl.style.height = 'auto';
    questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + 'px';
  });

  questionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  function scrollToBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  async function readJsonResponse(response) {
    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`The server returned an unexpected response (HTTP ${response.status}). Restart the app server and try again.`);
    }
  }

  /* ---------------- File attachments ---------------- */
  //
  // The user can attach a document and Chipo reads it: PDF, Word, PowerPoint,
  // Excel and plain text are turned into text on the server, images are handed
  // to the model as pixels. The file is uploaded once and kept on the server
  // for a short while; the question then refers to it by id.
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  let pendingFiles = [];

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('That file could not be read from your device.'));
      reader.readAsDataURL(file);
    });
  }

  function renderAttachTray() {
    if (!attachTray) return;
    attachTray.innerHTML = '';

    for (const item of pendingFiles) {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';

      const name = document.createElement('span');
      name.className = 'attach-chip-name';
      name.textContent = item.filename;
      name.title = item.kind === 'image' ? 'Image' : (item.characters || 0) + ' characters read';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attach-chip-remove';
      remove.setAttribute('aria-label', 'Remove ' + item.filename);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        pendingFiles = pendingFiles.filter((file) => file.id !== item.id);
        renderAttachTray();
      });

      chip.appendChild(name);
      chip.appendChild(remove);
      attachTray.appendChild(chip);
    }

    attachTray.hidden = pendingFiles.length === 0;
  }

  async function uploadFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`"${file.name}" is too large. The limit is 8 MB.`);
    }

    const data = await fileToBase64(file);
    const response = await fetch('/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mimeType: file.type, data }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok) throw new Error(body.error || 'That file could not be uploaded.');
    return body;
  }

  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());

    attachInput.addEventListener('change', async () => {
      const files = Array.from(attachInput.files || []);
      attachInput.value = '';

      for (const file of files) {
        try {
          const stored = await uploadFile(file);
          pendingFiles.push(stored);
          renderAttachTray();
        } catch (err) {
          const bubble = addMessage('bot', err.message || 'That file could not be uploaded.');
          bubble.classList.add('error');
        }
      }
    });
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Chipo's answers appear like they are being written, which reads far more
  // naturally than a wall of text popping in at once. Long answers are not
  // typed slowly - the whole reveal is capped at roughly two-thirds of a
  // second. Respects the visitor's reduced-motion setting.
  function typeOut(element, text) {
    element.textContent = '';
    if (reduceMotion.matches || !text) {
      element.textContent = text;
      return;
    }
    element.classList.add('is-typing');
    const step = Math.max(1, Math.ceil(text.length / 42));
    let index = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safety);
      element.textContent = text;
      element.classList.remove('is-typing');
    };
    // Whatever happens (a throttled background tab, for example), the answer
    // is always complete well under a second and a half.
    const safety = setTimeout(finish, 1400);
    const tick = () => {
      if (finished) return;
      index = Math.min(text.length, index + step);
      element.textContent = text.slice(0, index);
      scrollToBottom();
      if (index < text.length) {
        setTimeout(tick, 16);
      } else {
        finish();
      }
    };
    setTimeout(tick, 16);
  }

  function prettySource(name) {
    return String(name)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((word) => (/^[A-Z0-9()]{2,3}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
      .join(' ');
  }

  function addMessage(role, text, meta = {}) {
    if (welcome.parentNode) welcome.remove();

    const row = document.createElement('div');
    row.className = 'msg-row ' + role;

    const avatar = document.createElement('div');
    avatar.className = 'avatar ' + (role === 'user' ? 'user' : 'bot');
    if (role === 'user') {
      avatar.textContent = 'S';
    } else {
      avatar.innerHTML = '<img src="/images/logo.jpeg" alt="">';
    }

    const col = document.createElement('div');
    col.className = 'bubble-col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const bubbleText = document.createElement('span');
    bubbleText.className = 'bubble-text';
    bubble.appendChild(bubbleText);
    col.appendChild(bubble);

    if (role === 'user') {
      bubbleText.textContent = text;
    } else {
      typeOut(bubbleText, text);
    }

    if (role === 'bot' && meta.sources && meta.sources.length) {
      const sources = document.createElement('div');
      sources.className = 'bubble-sources';
      const label = document.createElement('span');
      label.className = 'bubble-sources-label';
      label.textContent = 'Source';
      sources.appendChild(label);
      meta.sources.forEach((name) => {
        const pill = document.createElement('span');
        pill.className = 'bubble-source';
        pill.textContent = prettySource(name);
        pill.title = name;
        sources.appendChild(pill);
      });
      col.appendChild(sources);
    }

    if (role === 'user' && meta.attachments && meta.attachments.length) {
      const files = document.createElement('div');
      files.className = 'bubble-files';
      for (const file of meta.attachments) {
        const item = document.createElement('span');
        item.className = 'bubble-file';
        item.textContent = file.filename;
        files.appendChild(item);
      }
      col.appendChild(files);
    }

    if (role === 'bot') {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'speak-btn';
      speakBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg> Listen';
      speakBtn.addEventListener('click', () => toggleSpeak(text, speakBtn));
      col.appendChild(speakBtn);

      if (meta.needsHuman) {
        if (meta.ticket) {
          // Inside the portal Chipo opened the ticket itself, using the
          // contact details already on the student's portal record.
          const sent = document.createElement('div');
          sent.className = 'escalate-confirm sent';
          sent.textContent = `Sent to ${meta.ticket.departmentName || 'the university team'}.`;
          col.appendChild(sent);
        } else if (meta.access !== 'student') {
          // A signed-in student has their contact details on the portal, so a
          // form would ask for information the university already holds. The
          // answer itself says honestly that the ticket could not be opened.
          const banner = document.createElement('div');
          banner.className = 'escalate-confirm';
          banner.textContent = "I couldn't answer confidently. Share your contact details below and I'll send your question to the right staff team.";
          col.appendChild(banner);
          if (meta.escalation) {
            const contactForm = document.createElement('form');
            contactForm.className = 'ticket-contact-form';
            contactForm.innerHTML =
              '<p>Your ticket is created only after you submit this form. Provide a name and at least one way for staff to contact you.</p>' +
              '<label>Your name<input name="name" autocomplete="name" maxlength="255" required></label>' +
              '<label>Email address<input name="email" type="email" autocomplete="email" maxlength="255"></label>' +
              '<label>Phone number<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>' +
              '<button type="submit">Send to staff</button>' +
              '<span class="ticket-contact-error" role="status" aria-live="polite"></span>';
            contactForm.addEventListener('submit', async (event) => {
              event.preventDefault();
              const formData = new FormData(contactForm);
              const contact = {
                name: String(formData.get('name') || '').trim(),
                email: String(formData.get('email') || '').trim(),
                phone: String(formData.get('phone') || '').trim(),
              };
              const error = contactForm.querySelector('.ticket-contact-error');
              const button = contactForm.querySelector('button');
              if (!contact.name) {
                error.textContent = 'Enter your name.';
                return;
              }
              if (!contact.email && !contact.phone) {
                error.textContent = 'Enter an email address or phone number.';
                return;
              }
              button.disabled = true;
              error.textContent = '';
              try {
                const response = await fetch('/tickets', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...meta.escalation, ...contact }),
                });
                const data = await readJsonResponse(response);
                if (!response.ok) throw new Error(data.error || 'Could not save your contact details.');
                const confirmation = document.createElement('p');
                confirmation.textContent = `Ticket ${data.ticket.id} was sent to ${data.ticket.departmentName || 'staff'} for follow-up.`;
                contactForm.replaceChildren(confirmation);
              }
              catch (err) {
                error.textContent = err.message || 'Could not save your contact details.';
                button.disabled = false;
              }
            });
            col.appendChild(contactForm);
          }
        }
      }
    }

    row.appendChild(avatar);
    row.appendChild(col);
    chatInner.appendChild(row);
    scrollToBottom();
    return bubble;
  }

  function addThinkingBubble() {
    if (welcome.parentNode) welcome.remove();

    const row = document.createElement('div');
    row.className = 'msg-row bot';
    row.id = 'thinkingRow';

    const avatar = document.createElement('div');
    avatar.className = 'avatar bot';
    avatar.innerHTML = '<img src="/images/logo.jpeg" alt="">';

    const col = document.createElement('div');
    col.className = 'bubble-col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble thinking';
    bubble.innerHTML = '<span></span><span></span><span></span>';
    col.appendChild(bubble);

    row.appendChild(avatar);
    row.appendChild(col);
    chatInner.appendChild(row);
    scrollToBottom();
  }

  function removeThinkingBubble() {
    const row = document.getElementById('thinkingRow');
    if (row) row.remove();
  }

  async function sendMessage() {
    const question = questionEl.value.trim();
    const attached = pendingFiles.slice();

    if (!question) {
      if (attached.length) {
        const bubble = addMessage('bot', 'Tell me what you would like to know about the file you attached.');
        bubble.classList.add('error');
      }
      return;
    }

    addMessage('user', question, { attachments: attached });
    questionEl.value = '';
    questionEl.style.height = 'auto';
    pendingFiles = [];
    renderAttachTray();
    sendBtn.disabled = true;

    addThinkingBubble();

    try {
      // Inside the portal Chipo talks to /portal/ask and carries the
      // student's session. Everywhere else it talks to /ask, which grants no
      // portal access at all — so no session is sent.
      const inPortal = scope === 'portal';
      const res = await fetch(inPortal ? '/portal/ask' : '/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(inPortal && session.token ? { Authorization: 'Bearer ' + session.token } : {}),
        },
        body: JSON.stringify({
          question,
          history: conversationHistory,
          attachmentIds: attached.map((file) => file.id),
        })
      });
      const data = await readJsonResponse(res);

      removeThinkingBubble();

      // The session expired while the student was on the portal.
      if (res.status === 401 && inPortal) {
        clearSession();
        const b = addMessage('bot', data.error || 'Your portal session has expired. Please sign in again.');
        b.classList.add('error');
        return;
      }

      if (data.error) {
        const b = addMessage('bot', data.error);
        b.classList.add('error');
      } else {
        addMessage('bot', data.answer, {
          needsHuman: data.needsHuman,
          confidence: data.confidence,
          question,
          escalation: data.escalation,
          ticket: data.ticket,
          sources: data.sources,
          access: data.access,
        });
        // Track this Q&A in history
        conversationHistory.push({ question, answer: data.answer });
      }
    } catch (err) {
      removeThinkingBubble();
      const b = addMessage('bot', 'Could not reach the server. Make sure it is still running.');
      b.classList.add('error');
    } finally {
      sendBtn.disabled = false;
      questionEl.focus();
    }
  }

  /* ---------------- Voice input (speech-to-text) ---------------- */
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;

  if (!SpeechRecognitionAPI) {
    micBtn.disabled = true;
    micBtn.title = 'Voice input is not supported in this browser. Try Chrome or Edge.';
  } else {
    recognition = new SpeechRecognitionAPI();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('listening');
      inputWrap.classList.add('listening');
      statusDot.classList.add('listening');
      statusText.textContent = 'Listening...';
      micHint.textContent = '';
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      questionEl.value = transcript;
      questionEl.style.height = 'auto';
      questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + 'px';
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'permission-denied') {
        micHint.textContent = 'Microphone access was blocked. Allow it in your browser settings to use voice input.';
      } else if (event.error === 'no-speech') {
        micHint.textContent = 'No speech detected. Try again.';
      } else {
        micHint.textContent = 'Voice input error: ' + event.error;
      }
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.classList.remove('listening');
      inputWrap.classList.remove('listening');
      statusDot.classList.remove('listening');
      statusText.textContent = 'Online';

      // auto-send if we captured something
      if (questionEl.value.trim()) {
        sendMessage();
      }
    };

    micBtn.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
      } else {
        window.speechSynthesis && window.speechSynthesis.cancel();
        questionEl.value = '';
        try {
          recognition.start();
        } catch (e) {
          // recognition already active; ignore
        }
      }
    });
  }

  /* ---------------- Read aloud (text-to-speech) ---------------- */
  let currentUtterance = null;
  let currentSpeakBtn = null;

  function toggleSpeak(text, btn) {
    if (!window.speechSynthesis) {
      micHint.textContent = 'Read-aloud is not supported in this browser.';
      return;
    }

    // If this button is already speaking, stop it
    if (currentUtterance && currentSpeakBtn === btn && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      resetSpeakBtn(btn);
      return;
    }

    // Stop any other speech in progress
    window.speechSynthesis.cancel();
    if (currentSpeakBtn) resetSpeakBtn(currentSpeakBtn);

    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1;
    utter.onend = () => resetSpeakBtn(btn);
    utter.onerror = () => resetSpeakBtn(btn);

    currentUtterance = utter;
    currentSpeakBtn = btn;
    btn.classList.add('speaking');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop';

    window.speechSynthesis.speak(utter);
  }

  function resetSpeakBtn(btn) {
    btn.classList.remove('speaking');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg> Listen';
    if (currentSpeakBtn === btn) {
      currentUtterance = null;
      currentSpeakBtn = null;
    }
  }

  function handleSuggestion(text) {
    questionEl.value = text;
    questionEl.style.height = 'auto';
    questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + 'px';
    sendMessage();
  }
  window.handleSuggestion = handleSuggestion;

  const isAssistantEmbed = new URLSearchParams(window.location.search).get('assistant') === 'embed';
  if (isAssistantEmbed) document.body.classList.add('assistant-embed');

  const chatLauncher = document.getElementById('chatLauncher');
  const chatWidgetPanel = document.getElementById('chatWidgetPanel');
  const chatWidgetClose = document.getElementById('chatWidgetClose');
  function toggleChatWidget(open) {
    chatWidgetPanel.classList.toggle('open', open);
    chatLauncher.setAttribute('aria-expanded', String(open));
    if (isAssistantEmbed) window.parent.postMessage({ type: open ? 'chipo-widget-open' : 'chipo-widget-close' }, window.location.origin);
    if (open) questionEl.focus();
  }
  const chipoMascot = document.getElementById('chipoMascot');
  function makeChipoLookAt(clientX, clientY, viewportWidth, viewportHeight) {
    const bounds = chipoMascot.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const horizontal = Math.max(-2, Math.min(2, (clientX - centerX) / Math.max(1, viewportWidth / 2) * 3));
    const vertical = Math.max(-2, Math.min(2, (clientY - centerY) / Math.max(1, viewportHeight / 2) * 3));
    chipoMascot.style.setProperty('--look-x', `${horizontal.toFixed(1)}px`);
    chipoMascot.style.setProperty('--look-y', `${vertical.toFixed(1)}px`);
  }
  document.addEventListener('pointermove', (event) => {
    makeChipoLookAt(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
  }, { passive: true });
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== 'chipo-pointer') return;
    makeChipoLookAt(event.data.x, event.data.y, event.data.width, event.data.height);
  });
  document.addEventListener('pointerleave', () => {
    chipoMascot.style.setProperty('--look-x', '0px');
    chipoMascot.style.setProperty('--look-y', '0px');
  });
  chatLauncher.addEventListener('click', () => toggleChatWidget(!chatWidgetPanel.classList.contains('open')));
  chatWidgetClose.addEventListener('click', () => toggleChatWidget(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleChatWidget(false);
  });

  // Initialize on page load
  loadSavedConversations();
  renderHistoryList();

  // Sessions are per tab; discard any token an older version saved persistently.
  try { localStorage.removeItem(STUDENT_TOKEN_KEY); } catch (err) { /* storage unavailable */ }
  const existingToken = storedToken();
  if (existingToken) session = { token: existingToken, student: null };
  renderAccessBadge();

  window.chipo = {
    open: () => toggleChatWidget(true),
    close: () => toggleChatWidget(false),
    ask: (text) => {
      toggleChatWidget(true);
      questionEl.value = text;
      questionEl.style.height = 'auto';
      questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + 'px';
      sendMessage();
    },
    setSession,
    clearSession,
    setScope,
    getSession: () => ({ ...session }),
    getScope: () => scope,
  };
})();
