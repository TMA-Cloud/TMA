const path = require('path');
const {
  getFileByToken,
} = require('../models/share.model');

async function downloadShared(req, res) {
  try {
    const file = await getFileByToken(req.params.token);
    if (!file) return res.status(404).json({ message: 'File not found' });
    const filePath = path.join(__dirname, '..', 'uploads', file.path);
    res.download(filePath, file.name, (err) => {
      if (err) console.error(err);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { downloadShared };
