import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// Create temp directory for processing
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionDir = path.join(TEMP_DIR, req.sessionId || 'default');
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    cb(null, sessionDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit per file
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Middleware to generate session ID
app.use((req, res, next) => {
  req.sessionId = req.headers['x-session-id'] || `session_${Date.now()}`;
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: true });
});

// Upload clips endpoint
app.post('/api/upload-clip', upload.single('clip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  console.log(`Uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);
  res.json({
    success: true,
    filename: req.file.filename,
    path: req.file.path
  });
});

// Upload audio endpoint
app.post('/api/upload-audio', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  console.log(`Audio uploaded: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);
  res.json({
    success: true,
    filename: req.file.filename,
    path: req.file.path
  });
});

// Main export endpoint
app.post('/api/export', async (req, res) => {
  const { segments, clipFiles, audioFile } = req.body;
  const sessionId = req.sessionId;
  const sessionDir = path.join(TEMP_DIR, sessionId);

  console.log(`\n========================================`);
  console.log(`EXPORT REQUEST: ${segments.length} segments`);
  console.log(`========================================`);

  try {
    // 1. Create individual segment clips
    const segmentFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipPath = path.join(sessionDir, clipFiles[seg.videoIndex]);
      const segmentPath = path.join(sessionDir, `seg_${i.toString().padStart(4, '0')}.mp4`);

      console.log(`Segment ${i + 1}/${segments.length}: clip=${seg.videoIndex + 1}, start=${seg.clipStartTime.toFixed(2)}s, dur=${seg.duration.toFixed(2)}s`);

      await runFFmpeg([
        '-ss', seg.clipStartTime.toFixed(3),
        '-i', clipPath,
        '-t', seg.duration.toFixed(3),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
        '-an',
        '-y',
        segmentPath
      ]);

      segmentFiles.push(segmentPath);
    }

    // 2. Create concat list
    const concatListPath = path.join(sessionDir, 'concat.txt');
    const concatContent = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // 3. Concatenate all segments
    const mergedPath = path.join(sessionDir, 'merged.mp4');
    console.log(`\nMerging ${segmentFiles.length} segments...`);

    await runFFmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-y',
      mergedPath
    ]);

    // 4. Add audio
    const audioPath = path.join(sessionDir, audioFile);
    const outputPath = path.join(sessionDir, `output_${Date.now()}.mp4`);
    console.log(`\nAdding audio...`);

    await runFFmpeg([
      '-i', mergedPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ]);

    console.log(`\nExport complete!`);

    // Send the file
    res.download(outputPath, 'syncmaster_export.mp4', (err) => {
      // Cleanup after download
      setTimeout(() => cleanupSession(sessionDir), 5000);
    });

  } catch (error) {
    console.error('Export failed:', error);
    res.status(500).json({ error: error.message });
    cleanupSession(sessionDir);
  }
});

// Cleanup endpoint
app.post('/api/cleanup', (req, res) => {
  const sessionDir = path.join(TEMP_DIR, req.sessionId);
  cleanupSession(sessionDir);
  res.json({ success: true });
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

function cleanupSession(sessionDir) {
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`Cleaned up: ${sessionDir}`);
    }
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n====================================`);
  console.log(`  SyncMaster Export Server`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`====================================\n`);
});
