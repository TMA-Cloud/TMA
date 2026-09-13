/** Upload limits shared by validation and the object-storage multipart planner. */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 ** 3;
const MIN_MAX_UPLOAD_BYTES = 1024 ** 2;
const MAX_MAX_UPLOAD_BYTES = 100 * 1024 ** 3;

export { DEFAULT_MAX_UPLOAD_BYTES, MIN_MAX_UPLOAD_BYTES, MAX_MAX_UPLOAD_BYTES };
