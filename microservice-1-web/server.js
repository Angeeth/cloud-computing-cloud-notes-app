require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');

const app = express();
const PORT = process.env.PORT || 3000;
const BUCKET_NAME = process.env.BUCKET_NAME;
const UPLOAD_SERVICE_URL = process.env.UPLOAD_SERVICE_URL || 'http://localhost:8080';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[Web Service] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Initialize Google Cloud Storage client
// Uses Application Default Credentials (ADC) attached to Compute Engine VM 1 (Service Account 1)
const storage = new Storage();

/**
 * GET /health
 * Reports health status of Microservice 1.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'cloud-notes-web-service',
    timestamp: new Date().toISOString(),
    bucketConfigured: Boolean(BUCKET_NAME),
    uploadServiceConfigured: Boolean(UPLOAD_SERVICE_URL)
  });
});

/**
 * GET /api/notes
 * Retrieves and returns all saved notes from Google Cloud Storage.
 *
 * MANDATORY REQUIREMENT:
 * - Uses Service Account 1 (Notes Reader).
 * - Has read-only permissions: storage.objects.list, storage.objects.get.
 * - Parses note JSON files stored under the 'notes/' prefix.
 */
app.get('/api/notes', async (req, res) => {
  try {
    // Local mock mode for offline testing without GCP credentials
    if (process.env.MOCK_STORAGE === 'true') {
      const fs = require('fs');
      const mockDir = path.join(__dirname, '..', 'microservice-2-upload', 'mock-storage', 'notes');
      if (!fs.existsSync(mockDir)) {
        return res.status(200).json([]);
      }
      const files = fs.readdirSync(mockDir).filter(f => f.endsWith('.json'));
      const notes = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(mockDir, file), 'utf-8');
          notes.push(JSON.parse(raw));
        } catch (e) {
          console.warn(`[Web Service] [MOCK_STORAGE] Failed to parse ${file}:`, e.message);
        }
      }
      notes.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return res.status(200).json(notes);
    }

    if (!BUCKET_NAME) {
      console.error('[Web Service] BUCKET_NAME environment variable is not defined.');
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Google Cloud Storage bucket name is not configured on the web service.'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);

    // List objects stored under the notes/ directory prefix
    const [files] = await bucket.getFiles({ prefix: 'notes/' });

    // Filter out directory placeholders or non-json files
    const jsonFiles = files.filter(file => file.name.endsWith('.json'));

    // Read and parse each note object in parallel
    const notePromises = jsonFiles.map(async (file) => {
      try {
        const [contentBuffer] = await file.download();
        const note = JSON.parse(contentBuffer.toString('utf-8'));
        return note;
      } catch (err) {
        console.warn(`[Web Service] Failed to read or parse note file ${file.name}:`, err.message);
        return null;
      }
    });

    const notesResults = await Promise.all(notePromises);

    // Filter out any failed reads and sort notes descending by creation date (newest first)
    const validNotes = notesResults.filter(Boolean);
    validNotes.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.status(200).json(validNotes);

  } catch (error) {
    console.error('[Web Service] Error fetching notes from Google Cloud Storage:', error);

    if (error.code === 403) {
      return res.status(403).json({
        error: 'Permission Denied',
        message: 'Service Account 1 lacks permission to list or read objects from the bucket.'
      });
    }

    return res.status(500).json({
      error: 'Storage Error',
      message: 'Failed to retrieve notes from Google Cloud Storage.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/notes
 * Receives user input from the web client, validates it, and FORWARDS it to Microservice 2.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINT:
 * - Microservice 1 must NEVER upload directly to Google Cloud Storage.
 * - Microservice 1 acts strictly as an HTTP client proxy to Microservice 2 (Upload Service).
 * - Service Account 1 does NOT possess storage.objects.create permission.
 */
app.post('/api/notes', async (req, res) => {
  const { title, content } = req.body;

  // Validate incoming request body before forwarding
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Note title is required and cannot be blank.'
    });
  }

  if (title.trim().length > 150) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Note title cannot exceed 150 characters.'
    });
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Note content is required and cannot be blank.'
    });
  }

  if (content.trim().length > 10000) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Note content cannot exceed 10,000 characters.'
    });
  }

  const targetUrl = `${UPLOAD_SERVICE_URL.replace(/\/$/, '')}/api/notes`;
  console.log(`[Web Service] Forwarding note submission to Microservice 2 at ${targetUrl}`);

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (INTERNAL_API_KEY) {
      headers['x-api-key'] = INTERNAL_API_KEY;
    }

    // Forward request to Microservice 2 with a 10-second timeout
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: title.trim(),
        content: content.trim()
      }),
      signal: AbortSignal.timeout(10000)
    });

    const responseData = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[Web Service] Microservice 2 returned error status ${response.status}:`, responseData);
      return res.status(response.status).json({
        error: responseData.error || 'Upload Service Error',
        message: responseData.message || 'Microservice 2 rejected the note submission.'
      });
    }

    console.log(`[Web Service] Microservice 2 successfully created note: ${responseData.note?.id}`);
    return res.status(response.status).json(responseData);

  } catch (error) {
    console.error('[Web Service] Failed to connect to Microservice 2 (Upload Service):', error.message);

    if (error.name === 'TimeoutError') {
      return res.status(504).json({
        error: 'Gateway Timeout',
        message: 'Microservice 2 (Upload Service) timed out while processing the note upload.'
      });
    }

    return res.status(502).json({
      error: 'Bad Gateway',
      message: `Unable to communicate with Microservice 2 at ${UPLOAD_SERVICE_URL}. Please verify VM 2 is running and network firewall rules allow connection.`
    });
  }
});

// Fallback route for SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  Cloud Notes Web Application (Microservice 1) Running`);
  console.log(`  Listening on:       http://0.0.0.0:${PORT}`);
  console.log(`  Cloud Bucket:       ${BUCKET_NAME || '(Not Configured)'}`);
  console.log(`  Upload Service URL: ${UPLOAD_SERVICE_URL}`);
  console.log(`=======================================================`);
});
