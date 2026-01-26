const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { UPLOAD_DIR } = require('../config/paths');
const { agentWriteFileStream, agentMkdir, agentPathExists, agentDeletePath } = require('../utils/agentFileOperations');
const { getUserCustomDrive } = require('../models/file/file.cache.model');
const { getFolderPath, getUniqueFilename } = require('../models/file/file.utils.model');
const { fileTypeFromBuffer } = require('file-type');

/**
 * Custom storage engine that streams directly to custom drive final location
 * No temp directories, no memory buffers - pure streaming to final destination
 */
class DirectCustomDriveStorage {
  async _handleFile(req, file, cb) {
    // Check if custom drive is enabled
    if (!req.customDrivePath) {
      // Fall back to disk storage for non-custom-drive uploads
      return this._handleFileDisk(req, file, cb);
    }

    const userId = req.userId;

    // Get parentId from request body (multer parses form fields)
    let parentId = null;
    if (req.body && req.body.parentId) {
      parentId = req.body.parentId === 'null' || req.body.parentId === '' ? null : req.body.parentId;
    }

    // Get custom drive settings
    const customDrive = await getUserCustomDrive(userId);
    if (!customDrive.enabled || !customDrive.path) {
      return this._handleFileDisk(req, file, cb);
    }

    // STRICT: If custom drive is enabled, we MUST stream to custom drive
    // Never fall back to UPLOAD_DIR - fail the upload instead
    // This prevents custom drive files from ending up in container disk

    // Get target folder path
    let targetDir;
    try {
      const folderPath = await getFolderPath(parentId, userId);
      targetDir = folderPath || customDrive.path;

      // Ensure target directory exists
      const dirExists = await agentPathExists(targetDir);
      if (!dirExists) {
        await agentMkdir(targetDir);
      }
    } catch (error) {
      return cb(new Error(`Failed to prepare custom drive directory: ${error.message}`));
    }

    // Build initial destination path (will be adjusted if duplicate)
    const initialDestPath = path.join(targetDir, file.originalname);

    // Check for duplicates and get final path (check both filesystem and database)
    let finalPath;
    try {
      finalPath = await getUniqueFilename(initialDestPath, targetDir, true, userId);
    } catch (error) {
      return cb(new Error(`Failed to get unique filename: ${error.message}`));
    }

    // Buffer for MIME detection (first 4100 bytes)
    const mimeBuffer = [];
    let mimeBufferSize = 0;
    const MAX_MIME_BUFFER = 4100;
    let detectedMimeType = null;

    // Create stream for agent upload
    const agentStream = new PassThrough();
    let fileSize = 0;
    let uploadError = null;

    // Handle file stream
    file.stream.on('data', chunk => {
      // Buffer first bytes for MIME detection
      if (mimeBufferSize < MAX_MIME_BUFFER) {
        const remaining = MAX_MIME_BUFFER - mimeBufferSize;
        const toBuffer = chunk.slice(0, Math.min(remaining, chunk.length));
        mimeBuffer.push(toBuffer);
        mimeBufferSize += toBuffer.length;
      }

      // Forward all data to agent stream
      fileSize += chunk.length;
      if (!agentStream.write(chunk)) {
        // Backpressure - wait for drain
        file.stream.pause();
      }
    });

    file.stream.on('end', () => {
      agentStream.end();
    });

    file.stream.on('error', err => {
      agentStream.destroy(err);
      uploadError = err;
    });

    agentStream.on('drain', () => {
      file.stream.resume();
    });

    agentStream.on('error', err => {
      uploadError = err;
    });

    // Detect MIME type from buffer
    if (mimeBufferSize > 0) {
      try {
        const buffer = Buffer.concat(mimeBuffer);
        const fileType = await fileTypeFromBuffer(buffer);
        detectedMimeType = fileType ? fileType.mime : null;
      } catch (_e) {
        // MIME detection failed, will use declared type
      }
    }

    // Stream to agent - write directly to final location
    agentWriteFileStream(finalPath, agentStream)
      .then(() => {
        if (uploadError) {
          // Clean up partial file
          agentDeletePath(finalPath).catch(() => {});
          return cb(uploadError);
        }

        // Store file info in req.file format
        cb(null, {
          fieldname: file.fieldname,
          originalname: file.originalname,
          encoding: file.encoding,
          mimetype: detectedMimeType || file.mimetype || 'application/octet-stream',
          size: fileSize,
          path: finalPath,
          customDriveFinalPath: finalPath,
          destination: null,
          filename: path.basename(finalPath),
        });
      })
      .catch(err => {
        // Clean up partial file on error
        agentDeletePath(finalPath).catch(() => {});
        cb(err);
      });
  }

  // Fallback to disk storage for non-custom-drive uploads
  _handleFileDisk(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
    const filepath = path.join(UPLOAD_DIR, filename);

    const outStream = fs.createWriteStream(filepath);
    file.stream.pipe(outStream);

    outStream.on('error', cb);
    outStream.on('finish', () => {
      cb(null, {
        fieldname: file.fieldname,
        originalname: file.originalname,
        encoding: file.encoding,
        mimetype: file.mimetype,
        destination: UPLOAD_DIR,
        filename,
        path: filepath,
        size: outStream.bytesWritten,
      });
    });
  }

  _removeFile(req, file, cb) {
    // For custom drive files, deletion is handled by agent if needed
    // For disk files, remove from disk
    if (file.destination && file.path && !file.customDriveFinalPath) {
      fs.unlink(file.path, cb);
    } else {
      cb(null);
    }
  }
}

const storage = new DirectCustomDriveStorage();

/**
 * FileFilter - simplified since middleware already handles storage limit checks
 * This is kept as a safety net but middleware should catch issues first
 */
function fileFilter(req, file, cb) {
  // If response was already sent by middleware (storage limit exceeded), reject
  if (req.res && (req.res.headersSent || req.res.finished)) {
    return cb(new Error('Upload rejected - storage limit exceeded'), false);
  }
  // Allow file through - middleware and controller will handle validation
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max file size (safety limit)
  },
});

module.exports = upload;
