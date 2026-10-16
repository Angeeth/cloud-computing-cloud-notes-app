/**
 * Cloud Notes App - Client-Side JavaScript
 * Communicates with Microservice 1 (Web Application Backend)
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const noteForm = document.getElementById('noteForm');
  const noteTitleInput = document.getElementById('noteTitle');
  const noteContentInput = document.getElementById('noteContent');
  const titleCountSpan = document.getElementById('titleCount');
  const contentCountSpan = document.getElementById('contentCount');
  const submitBtn = document.getElementById('submitBtn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnSpinner = submitBtn.querySelector('.btn-spinner');
  const refreshBtn = document.getElementById('refreshBtn');

  const notesGrid = document.getElementById('notesGrid');
  const loadingState = document.getElementById('loadingState');
  const emptyState = document.getElementById('emptyState');

  const statusAlert = document.getElementById('statusAlert');
  const alertIcon = document.getElementById('alertIcon');
  const alertMessage = document.getElementById('alertMessage');
  const alertCloseBtn = document.getElementById('alertCloseBtn');

  let alertTimeout = null;

  // Live character counters
  noteTitleInput.addEventListener('input', () => {
    titleCountSpan.textContent = `${noteTitleInput.value.length} / 150`;
  });

  noteContentInput.addEventListener('input', () => {
    contentCountSpan.textContent = `${noteContentInput.value.length} / 10000`;
  });

  // Alert management
  function showAlert(message, type = 'success', duration = 6000) {
    clearTimeout(alertTimeout);
    statusAlert.className = `alert ${type}`;
    alertMessage.textContent = message;

    if (type === 'success') {
      alertIcon.textContent = '✓';
    } else {
      alertIcon.textContent = '⚠';
    }

    statusAlert.classList.remove('hidden');

    if (duration > 0) {
      alertTimeout = setTimeout(() => {
        hideAlert();
      }, duration);
    }
  }

  function hideAlert() {
    statusAlert.classList.add('hidden');
    clearTimeout(alertTimeout);
  }

  alertCloseBtn.addEventListener('click', hideAlert);

  // Security: HTML sanitization to avoid XSS
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Format timestamp nicely
  function formatDate(isoString) {
    if (!isoString) return 'Unknown date';
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return isoString;

      // Format as "Oct 16, 2026, 10:45 AM"
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date);
    } catch {
      return isoString;
    }
  }

  // Fetch all saved notes from Microservice 1 (which reads from GCS using Service Account 1)
  async function fetchNotes() {
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    notesGrid.innerHTML = '';

    try {
      const response = await fetch('/api/notes');

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP error ${response.status}`);
      }

      const notes = await response.json();

      loadingState.classList.add('hidden');

      if (!Array.isArray(notes) || notes.length === 0) {
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      renderNotes(notes);

    } catch (err) {
      loadingState.classList.add('hidden');
      emptyState.classList.add('hidden');
      console.error('Error fetching notes:', err);
      showAlert(`Could not load notes: ${err.message}`, 'error', 8000);
    }
  }

  // Render note cards into the grid
  function renderNotes(notes) {
    notesGrid.innerHTML = '';

    notes.forEach(note => {
      const card = document.createElement('article');
      card.className = 'note-card';

      const shortId = note.id ? note.id.substring(0, 8) : 'note';
      const formattedDate = formatDate(note.created_at);

      card.innerHTML = `
        <div class="note-header">
          <h3 class="note-title">${escapeHtml(note.title)}</h3>
        </div>
        <div class="note-body">${escapeHtml(note.content)}</div>
        <div class="note-footer">
          <span class="note-time">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            ${formattedDate}
          </span>
          <span class="note-badge" title="GCS Object ID: ${escapeHtml(note.id)}">#${escapeHtml(shortId)}</span>
        </div>
      `;

      notesGrid.appendChild(card);
    });
  }

  // Handle note submission
  noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = noteTitleInput.value.trim();
    const content = noteContentInput.value.trim();

    if (!title) {
      showAlert('Please enter a note title.', 'error');
      noteTitleInput.focus();
      return;
    }

    if (!content) {
      showAlert('Please enter note content.', 'error');
      noteContentInput.focus();
      return;
    }

    // Set UI to loading state
    submitBtn.disabled = true;
    btnText.textContent = 'Uploading...';
    btnSpinner.classList.remove('hidden');
    hideAlert();

    try {
      // POST to Microservice 1 (which will forward to Microservice 2)
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title, content })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || data.error || `Failed with status ${response.status}`);
      }

      // Success! Reset form and counter
      noteForm.reset();
      titleCountSpan.textContent = '0 / 150';
      contentCountSpan.textContent = '0 / 10000';

      showAlert('Note successfully created and stored in Google Cloud Storage!', 'success', 5000);

      // Auto refresh notes list
      await fetchNotes();

    } catch (err) {
      console.error('Submission failed:', err);
      showAlert(`Upload failed: ${err.message}`, 'error', 8000);
    } finally {
      // Restore submit button
      submitBtn.disabled = false;
      btnText.textContent = 'Save Note';
      btnSpinner.classList.add('hidden');
    }
  });

  // Manual refresh button
  refreshBtn.addEventListener('click', () => {
    fetchNotes();
  });

  // Initial load
  fetchNotes();
});
