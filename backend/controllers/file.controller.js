const path = require('path');
const fs = require('fs');
const { getFiles, createFolder, createFile, moveFiles, getFile } = require('../models/file.model');

async function listFiles(req, res) {
  const parentId = req.query.parentId || null;
  try {
    const files = await getFiles(req.userId, parentId);
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function addFolder(req, res) {
  const { name, parentId = null } = req.body;
  if (!name) return res.status(400).json({ message: 'Name required' });
  try {
    const folder = await createFolder(name, parentId, req.userId);
    res.json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function uploadFile(req, res) {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const parentId = req.body.parentId || null;
  try {
    const file = await createFile(
      req.file.originalname,
      req.file.size,
      req.file.mimetype,
      req.file.path,
      parentId,
      req.userId
    );
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function moveFilesController(req, res) {
  const { ids, parentId = null } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids required' });
  }
  try {
    await moveFiles(ids, parentId, req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function downloadFile(req, res) {
  try {
    const file = await getFile(req.params.id, req.userId);
    if (!file) return res.status(404).json({ message: 'File not found' });
    const filePath = path.join(__dirname, '..', 'uploads', file.path);
    res.type(file.mimeType);
    res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { listFiles, addFolder, uploadFile, moveFiles: moveFilesController, downloadFile };
