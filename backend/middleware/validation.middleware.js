import { validationResult } from 'express-validator';

import { sendError } from '../utils/response.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors = [];
  // express-validator v7 names the field `path` (`param` is gone, which keyed every detail "undefined").
  errors.array().map(err => extractedErrors.push({ [err.path ?? err.param]: err.msg }));

  return sendError(res, 422, 'Validation failed', null, { details: extractedErrors });
};

export { validate };
