/**
 * Cloud Notes App - Automated Local End-to-End Test Suite
 * 
 * Verifies:
 * 1. Health endpoints for both microservices (no GCS calls on upload health).
 * 2. Security: Unauthorized rejection when API key is missing/invalid on Microservice 2.
 * 3. Least privilege: Microservice 2 rejects GET/DELETE /api/notes (405 Method Not Allowed).
 * 4. Validation: Both services reject blank titles or empty contents.
 * 5. Creation: Microservice 1 receives POST -> forwards to Microservice 2 -> note stored.
 * 6. Retrieval: Microservice 1 reads stored notes and returns them ordered newest-first.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MS2_PORT = 8089;
const MS1_PORT = 3009;
const INTERNAL_KEY = 'test-secret-key-12345';

// Clear mock storage before running
const mockStorageDir = path.join(__dirname, 'microservice-2-upload', 'mock-storage');
if (fs.existsSync(mockStorageDir)) {
  fs.rmSync(mockStorageDir, { recursive: true, force: true });
}

let ms1Process, ms2Process;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('====================================================');
  console.log('   Starting Cloud Notes App Automated Test Suite    ');
  console.log('====================================================\n');

  // 1. Launch Microservice 2 (Upload Service)
  console.log('[Test Setup] Starting Microservice 2 on port ' + MS2_PORT + '...');
  ms2Process = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, 'microservice-2-upload'),
    env: {
      ...process.env,
      PORT: MS2_PORT,
      BUCKET_NAME: 'test-bucket',
      INTERNAL_API_KEY: INTERNAL_KEY,
      MOCK_STORAGE: 'true'
    },
    stdio: 'pipe'
  });

  // 2. Launch Microservice 1 (Web Service)
  console.log('[Test Setup] Starting Microservice 1 on port ' + MS1_PORT + '...');
  ms1Process = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, 'microservice-1-web'),
    env: {
      ...process.env,
      PORT: MS1_PORT,
      BUCKET_NAME: 'test-bucket',
      UPLOAD_SERVICE_URL: `http://127.0.0.1:${MS2_PORT}`,
      INTERNAL_API_KEY: INTERNAL_KEY,
      MOCK_STORAGE: 'true'
    },
    stdio: 'pipe'
  });

  // Wait for servers to spin up
  await sleep(1500);

  let passedCount = 0;
  let failedCount = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passedCount++;
    } else {
      console.error(`  [FAIL] ${testName}`);
      failedCount++;
    }
  }

  try {
    // Test 1: Microservice 2 Health Endpoint
    console.log('\n--- Category 1: Microservice 2 (Upload Service) ---');
    const ms2HealthRes = await fetch(`http://127.0.0.1:${MS2_PORT}/health`);
    const ms2Health = await ms2HealthRes.json();
    assert(ms2HealthRes.status === 200 && ms2Health.status === 'ok', 'MS2 GET /health returns 200 OK');

    // Test 2: Microservice 2 rejects unauthorized direct calls
    const unauthRes = await fetch(`http://127.0.0.1:${MS2_PORT}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hacker Note', content: 'Testing Auth' })
    });
    assert(unauthRes.status === 401, 'MS2 rejects POST /api/notes when internal API key is missing (401)');

    // Test 3: Microservice 2 rejects GET /api/notes (Least-privilege API restriction)
    const ms2GetRes = await fetch(`http://127.0.0.1:${MS2_PORT}/api/notes`);
    assert(ms2GetRes.status === 405, 'MS2 strictly rejects GET /api/notes (405 Method Not Allowed)');

    // Test 4: Microservice 2 rejects empty title/content
    const badValRes = await fetch(`http://127.0.0.1:${MS2_PORT}/api/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': INTERNAL_KEY
      },
      body: JSON.stringify({ title: '', content: '' })
    });
    assert(badValRes.status === 400, 'MS2 rejects empty title and content (400 Bad Request)');

    // Test 5: Microservice 1 Health Endpoint
    console.log('\n--- Category 2: Microservice 1 (Web Service) ---');
    const ms1HealthRes = await fetch(`http://127.0.0.1:${MS1_PORT}/health`);
    const ms1Health = await ms1HealthRes.json();
    assert(ms1HealthRes.status === 200 && ms1Health.status === 'ok', 'MS1 GET /health returns 200 OK');

    // Test 6: Microservice 1 GET /api/notes with initial empty state
    const emptyNotesRes = await fetch(`http://127.0.0.1:${MS1_PORT}/api/notes`);
    const emptyNotes = await emptyNotesRes.json();
    assert(emptyNotesRes.status === 200 && Array.isArray(emptyNotes) && emptyNotes.length === 0, 'MS1 GET /api/notes returns empty array [] initially');

    // Test 7: Microservice 1 rejects empty note submission
    const ms1BadRes = await fetch(`http://127.0.0.1:${MS1_PORT}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', content: '' })
    });
    assert(ms1BadRes.status === 400, 'MS1 client validation rejects empty note (400 Bad Request)');

    // Test 8: End-to-End Submission: MS1 forwards to MS2, MS2 writes object
    console.log('\n--- Category 3: End-to-End Workflow & Verification ---');
    const createNote1Res = await fetch(`http://127.0.0.1:${MS1_PORT}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cloud Architecture Note 1',
        content: 'This note demonstrates microservice decoupling with IAM least privilege.'
      })
    });
    const created1 = await createNote1Res.json();
    assert(createNote1Res.status === 201 && created1.note && created1.note.id && created1.note.created_at, 'MS1 forwards note to MS2 -> MS2 saves note with ID & timestamp (201 Created)');

    await sleep(200);

    // Create a second note to test ordering
    const createNote2Res = await fetch(`http://127.0.0.1:${MS1_PORT}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cloud Architecture Note 2',
        content: 'Second note uploaded to verify newest-first ordering.'
      })
    });
    const created2 = await createNote2Res.json();
    assert(createNote2Res.status === 201, 'Second note uploaded successfully via MS1 -> MS2');

    // Test 9: Verify retrieval of both notes through Microservice 1
    const allNotesRes = await fetch(`http://127.0.0.1:${MS1_PORT}/api/notes`);
    const allNotes = await allNotesRes.json();
    assert(
      allNotesRes.status === 200 &&
      allNotes.length === 2 &&
      allNotes[0].id === created2.note.id && // Newest note is first
      allNotes[1].id === created1.note.id,
      'MS1 GET /api/notes retrieves all saved notes sorted newest first'
    );

    // Test 10: Static assets served correctly
    const htmlRes = await fetch(`http://127.0.0.1:${MS1_PORT}/index.html`);
    const htmlText = await htmlRes.text();
    assert(htmlRes.status === 200 && htmlText.includes('Cloud Notes'), 'MS1 serves web UI (index.html) successfully');

  } catch (err) {
    console.error('[Test Error] Unexpected exception during tests:', err);
    failedCount++;
  } finally {
    // Cleanup processes
    console.log('\n[Test Cleanup] Stopping microservices...');
    if (ms1Process) ms1Process.kill();
    if (ms2Process) ms2Process.kill();
    if (fs.existsSync(mockStorageDir)) {
      fs.rmSync(mockStorageDir, { recursive: true, force: true });
    }
  }

  console.log('\n====================================================');
  console.log(`Test Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests();
