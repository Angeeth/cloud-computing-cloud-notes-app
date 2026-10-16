require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const { Storage } = require('@google-cloud/storage');

const app = express();
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = process.env.BUCKET_NAME;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[Upload Service] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Initialize Google Cloud Storage client
// Uses Application Default Credentials (ADC) attached to Compute Engine VM 2
const storage = new Storage();

// Internal security check: Verify caller authenticity if INTERNAL_API_KEY is configured
const verifyInternalAuth = (req, res, next) => {
  if (!INTERNAL_API_KEY) {
    // If no key configured in environment, proceed with warning
    return next();
  }
  const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!providedKey || providedKey !== INTERNAL_API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Access denied: Invalid or missing internal API key'
    });
  }
  next();
};

/**
 * GET /health
 * Reports the service health status.
 * MANDATORY REQUIREMENT: Does NOT interact with or read from the Cloud Storage bucket.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'cloud-notes-upload-service',
    timestamp: new Date().toISOString(),
    bucketConfigured: Boolean(BUCKET_NAME)
  });
});

/**
 * POST /api/notes
 * Receives note payload from Microservice 1, validates fields,
 * generates a unique object name, and writes the JSON note to Google Cloud Storage.
 *
 * MANDATORY REQUIREMENT:
 * - Uses Service Account 2 (has storage.objects.create ONLY).
 * - Enforces ifGenerationMatch: 0 to ensure ONLY new object creation without update/overwrite permissions.
 * - No read, list, update, or delete capabilities exist in this service.
 */
app.post('/api/notes', verifyInternalAuth, async (req, res) => {
  try {
    const { title, content } = req.body;

    // 1. Validation
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The "title" field is required and must not be empty.'
      });
    }

    if (title.trim().length > 150) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The "title" field must not exceed 150 characters.'
      });
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The "content" field is required and must not be empty.'
      });
    }

    if (content.trim().length > 10000) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The "content" field must not exceed 10,000 characters.'
      });
    }

    if (!BUCKET_NAME) {
      console.error('[Upload Service] BUCKET_NAME environment variable is not defined.');
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Google Cloud Storage bucket name is not configured on the upload service.'
      });
    }

    // 2. Generate unique note metadata
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    const noteData = {
      id: id,
      title: title.trim(),
      content: content.trim(),
      created_at: createdAt
    };

    const objectName = `notes/${id}.json`;

    // Local mock mode for offline testing without GCP credentials
    if (process.env.MOCK_STORAGE === 'true') {
      const fs = require('fs');
      const path = require('path');
      const mockDir = path.join(__dirname, 'mock-storage', 'notes');
      fs.mkdirSync(mockDir, { recursive: true });
      fs.writeFileSync(path.join(mockDir, `${id}.json`), JSON.stringify(noteData, null, 2));
      console.log(`[Upload Service] [MOCK_STORAGE] Saved note to local mock file: ${objectName}`);

      return res.status(201).json({
        success: true,
        message: 'Note created successfully (local mock)',
        note: noteData
      });
    }

    // 3. Upload to Google Cloud Storage
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(objectName);

    // Save with ifGenerationMatch: 0 ensures object creation ONLY if it does not already exist.
    // This strictly adheres to the storage.objects.create permission without requiring update/overwrite.
    await file.save(JSON.stringify(noteData, null, 2), {
      contentType: 'application/json',
      metadata: {
        contentType: 'application/json'
      },
      preconditionOpts: {
        ifGenerationMatch: 0
      }
    });

    console.log(`[Upload Service] Successfully uploaded note to gs://${BUCKET_NAME}/${objectName}`);

    return res.status(201).json({
      success: true,
      message: 'Note successfully stored in Google Cloud Storage',
      note: noteData
    });

  } catch (error) {
    console.error('[Upload Service] Error saving note to Cloud Storage:', error);

    // Handle Google Cloud precondition failed (generation match conflict)
    if (error.code === 412) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'An object with this generated ID already exists in the bucket.'
      });
    }

    // Handle permission denied from IAM
    if (error.code === 403) {
      return res.status(403).json({
        error: 'Permission Denied',
        message: 'Service Account 2 lacks permission to create objects in the specified bucket.'
      });
    }

    return res.status(500).json({
      error: 'Storage Error',
      message: 'Failed to write note to Google Cloud Storage.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Explicitly reject any unsupported HTTP methods on /api/notes
app.all('/api/notes', (req, res) => {
  res.status(405).json({
    error: 'Method Not Allowed',
    message: 'The Upload Service only accepts POST requests for creating notes.'
  });
});

// 404 handler for any other route
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found on Upload Service.`
  });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  Cloud Notes Upload Service (Microservice 2) Running`);
  console.log(`  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Target Bucket: ${BUCKET_NAME || '(Not Configured)'}`);
  console.log(`  Auth Enabled:  ${Boolean(INTERNAL_API_KEY)}`);
  console.log(`=======================================================`);
});
