import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env (one level above backend/)
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

export { envPath };
