import { validationResult } from 'express-validator';

import { sendError } from '../utils/response.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors = [];
  errors.array().map(err => extractedErrors.push({ [err.param]: err.msg }));

  return sendError(res, 422, 'Validation failed', null, { details: extractedErrors });
};

export { validate };
