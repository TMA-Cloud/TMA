/** Isolated object-store double for DB integration tests. Real S3 has its own suite. */
import fs from 'fs/promises';
import { Readable } from 'stream';

const objects = new Map();
export function resetStorageMock() {
  objects.clear();
}
export function readStoredBuffer(key) {
  return Buffer.from(objects.get(key).body);
}
export async function exists(key) {
  return objects.has(key);
}
export async function putBuffer(key, body) {
  objects.set(key, { body: Buffer.from(body), lastModified: new Date() });
}
export async function putStream(key, stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  await putBuffer(key, Buffer.concat(chunks));
}
export async function putFromPath(key, path) {
  await putBuffer(key, await fs.readFile(path));
}
export async function getReadStream(key, range) {
  if (!objects.has(key)) throw Object.assign(new Error('No such object'), { name: 'NoSuchKey' });
  const body = readStoredBuffer(key);
  return Readable.from(range ? body.subarray(range.start, range.end + 1) : body);
}
export async function deleteObject(key) {
  objects.delete(key);
}
export async function copyObject(source, dest) {
  await putBuffer(dest, readStoredBuffer(source));
}
export async function listKeys() {
  return [...objects.keys()];
}
export async function* listKeysPaginated(pageSize = 1000) {
  const keys = await listKeys();
  for (let i = 0; i < keys.length; i += pageSize) yield keys.slice(i, i + pageSize);
}
export async function statObject(key) {
  const object = objects.get(key);
  return object ? { size: object.body.length, lastModified: object.lastModified } : null;
}
export async function* listObjectsPaginated(pageSize = 1000) {
  for await (const keys of listKeysPaginated(pageSize)) {
    yield await Promise.all(keys.map(async key => ({ key, ...(await statObject(key)) })));
  }
}
