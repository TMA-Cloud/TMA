/**
 * HTML escaping function to prevent XSS
 * Uses escape-html package for better performance and correctness
 */
const escapeHtml = require('escape-html');

module.exports = {
  escapeHtml,
};
