const https = require('https');
const http = require('http');
const { PassThrough } = require('stream');
const { getAgentSettings } = require('../models/user.model');

/**
 * Make an authenticated request to the agent
 */
async function makeAgentRequest(method, endpoint, options = {}) {
  const settings = await getAgentSettings();

  if (!settings.url) {
    throw new Error('Agent URL not configured');
  }

  const url = new URL(settings.url);
  const agentUrl = `${url.origin}${endpoint}`;
  const requestModule = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const requestOptions = {
      method,
      headers: {
        'Content-Type': options.contentType || 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || 30000, // 30 seconds for file operations
    };

    // Add token if configured
    if (settings.token) {
      requestOptions.headers['Authorization'] = `Bearer ${settings.token}`;
    }

    const req = requestModule.request(agentUrl, requestOptions, res => {
      // For binary data (buffers), accumulate as Buffer chunks
      // For text data (JSON, strings), accumulate as string
      const isBinary = options.responseType === 'buffer';
      let data = isBinary ? [] : '';

      res.on('data', chunk => {
        if (isBinary) {
          data.push(chunk);
        } else {
          data += chunk;
        }
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (options.responseType === 'buffer') {
            // Concatenate all buffer chunks into a single buffer
            resolve(Buffer.concat(data));
          } else if (options.responseType === 'json' || res.headers['content-type']?.includes('application/json')) {
            try {
              resolve(JSON.parse(data));
            } catch (_err) {
              reject(new Error('Invalid JSON response from agent'));
            }
          } else {
            resolve(data);
          }
        } else {
          let errorMessage = `Agent API returned status ${res.statusCode}`;
          try {
            // For error responses, try to parse as JSON (always text)
            const errorData = JSON.parse(isBinary ? Buffer.concat(data).toString() : data);
            errorMessage = errorData.error || errorMessage;
          } catch {
            // Use default error message
          }
          reject(new Error(errorMessage));
        }
      });
    });

    req.on('error', err => {
      reject(new Error(`Failed to connect to agent: ${err.message}`));
    });

    req.setTimeout(requestOptions.timeout, () => {
      req.destroy();
      reject(new Error('Agent request timeout'));
    });

    // Write body if provided
    if (options.body) {
      if (Buffer.isBuffer(options.body)) {
        req.write(options.body);
      } else if (typeof options.body === 'string') {
        req.write(options.body);
      } else {
        req.write(JSON.stringify(options.body));
      }
    }

    req.end();
  });
}

/**
 * List directory contents via agent
 */
async function agentListDirectory(dirPath) {
  const encodedPath = encodeURIComponent(dirPath);
  const response = await makeAgentRequest('GET', `/api/list?path=${encodedPath}`, {
    responseType: 'json',
  });
  return response.files || [];
}

/**
 * Read file via agent
 */
async function agentReadFile(filePath) {
  const encodedPath = encodeURIComponent(filePath);
  return makeAgentRequest('GET', `/api/read?path=${encodedPath}`, {
    responseType: 'buffer',
  });
}

/**
 * Write file via agent
 */
async function agentWriteFile(filePath, fileContent) {
  const encodedPath = encodeURIComponent(filePath);
  return makeAgentRequest('POST', `/api/write?path=${encodedPath}`, {
    contentType: 'application/octet-stream',
    body: fileContent,
  });
}

/**
 * Delete file/directory via agent
 */
async function agentDeletePath(pathToDelete) {
  const encodedPath = encodeURIComponent(pathToDelete);
  return makeAgentRequest('DELETE', `/api/delete?path=${encodedPath}`);
}

/**
 * Get file/directory stat via agent
 */
async function agentStatPath(pathToStat) {
  const encodedPath = encodeURIComponent(pathToStat);
  return makeAgentRequest('GET', `/api/stat?path=${encodedPath}`, {
    responseType: 'json',
  });
}

/**
 * Create directory via agent
 */
async function agentMkdir(dirPath) {
  const encodedPath = encodeURIComponent(dirPath);
  return makeAgentRequest('POST', `/api/mkdir?path=${encodedPath}`);
}

/**
 * Check if path exists via agent
 */
async function agentPathExists(pathToCheck) {
  try {
    await agentStatPath(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a path with agent for file watching
 */
async function agentWatchPath(watchPath, webhookUrl = null, webhookToken = null) {
  const payload = { path: watchPath };
  if (webhookUrl) {
    payload.webhookUrl = webhookUrl;
    if (webhookToken) {
      payload.webhookToken = webhookToken;
    }
  }
  return makeAgentRequest('POST', '/api/watch', {
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

/**
 * Unregister a path from agent file watching
 */
async function agentUnwatchPath(watchPath) {
  return makeAgentRequest('POST', '/api/unwatch', {
    contentType: 'application/json',
    body: JSON.stringify({ path: watchPath }),
  });
}

/**
 * Get disk usage for a path via agent
 * Returns {total, free, used} in bytes
 */
async function agentGetDiskUsage(diskPath) {
  const encodedPath = encodeURIComponent(diskPath);
  return makeAgentRequest('GET', `/api/usage?path=${encodedPath}`, {
    responseType: 'json',
  });
}

/**
 * Rename a file or directory via agent (OS-level rename, instant even for large files)
 */
async function agentRenamePath(oldPath, newPath) {
  return makeAgentRequest('POST', '/api/rename', {
    contentType: 'application/json',
    body: JSON.stringify({ oldPath, newPath }),
    responseType: 'json',
  });
}

/**
 * Create a streaming read stream from agent
 * Returns a Readable stream that pipes data from the agent
 */
function agentReadFileStream(filePath) {
  const stream = new PassThrough();

  (async () => {
    try {
      const settings = await getAgentSettings();

      if (!settings.url) {
        stream.destroy(new Error('Agent URL not configured'));
        return;
      }

      const url = new URL(settings.url);
      const encodedPath = encodeURIComponent(filePath);
      const agentUrl = `${url.origin}/api/read?path=${encodedPath}`;
      const requestModule = url.protocol === 'https:' ? https : http;

      const requestOptions = {
        method: 'GET',
        headers: {},
        timeout: 300000, // 5 minutes for large files
      };

      // Add token if configured
      if (settings.token) {
        requestOptions.headers['Authorization'] = `Bearer ${settings.token}`;
      }

      const req = requestModule.request(agentUrl, requestOptions, res => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Pipe response directly to stream
          res.pipe(stream);

          res.on('error', err => {
            stream.destroy(err);
          });
        } else {
          let errorMessage = `Agent API returned status ${res.statusCode}`;
          const chunks = [];

          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            try {
              const errorData = JSON.parse(Buffer.concat(chunks).toString());
              errorMessage = errorData.error || errorMessage;
            } catch {
              // Use default error message
            }
            stream.destroy(new Error(errorMessage));
          });
        }
      });

      req.on('error', err => {
        stream.destroy(new Error(`Failed to connect to agent: ${err.message}`));
      });

      req.setTimeout(requestOptions.timeout, () => {
        req.destroy();
        stream.destroy(new Error('Agent request timeout'));
      });

      req.end();
    } catch (error) {
      stream.destroy(error);
    }
  })();

  return stream;
}

/**
 * Write a file to agent via streaming
 * Accepts a Readable stream and pipes it to the agent
 */
function agentWriteFileStream(filePath, inputStream) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const settings = await getAgentSettings();

        if (!settings.url) {
          reject(new Error('Agent URL not configured'));
          return;
        }

        const url = new URL(settings.url);
        const encodedPath = encodeURIComponent(filePath);
        const agentUrl = `${url.origin}/api/write?path=${encodedPath}`;
        const requestModule = url.protocol === 'https:' ? https : http;

        const requestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          timeout: 300000, // 5 minutes for large files
        };

        // Add token if configured
        if (settings.token) {
          requestOptions.headers['Authorization'] = `Bearer ${settings.token}`;
        }

        const req = requestModule.request(agentUrl, requestOptions, res => {
          const chunks = [];

          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const data = Buffer.concat(chunks).toString();
                const response = JSON.parse(data);
                resolve(response);
              } catch (_err) {
                resolve({ status: 'written', path: filePath });
              }
            } else {
              let errorMessage = `Agent API returned status ${res.statusCode}`;
              try {
                const errorData = JSON.parse(Buffer.concat(chunks).toString());
                errorMessage = errorData.error || errorMessage;
              } catch {
                // Use default error message
              }
              reject(new Error(errorMessage));
            }
          });
        });

        req.on('error', err => {
          reject(new Error(`Failed to connect to agent: ${err.message}`));
        });

        req.setTimeout(requestOptions.timeout, () => {
          req.destroy();
          reject(new Error('Agent request timeout'));
        });

        // Pipe input stream to request
        inputStream.pipe(req);

        inputStream.on('error', err => {
          req.destroy();
          reject(new Error(`Input stream error: ${err.message}`));
        });
      } catch (error) {
        reject(error);
      }
    })();
  });
}

module.exports = {
  agentListDirectory,
  agentReadFile,
  agentWriteFile,
  agentReadFileStream,
  agentWriteFileStream,
  agentDeletePath,
  agentStatPath,
  agentMkdir,
  agentPathExists,
  agentRenamePath,
  agentWatchPath,
  agentUnwatchPath,
  agentGetDiskUsage,
};
