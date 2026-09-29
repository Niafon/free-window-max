import { writeFile } from 'node:fs/promises';
import { readConfig } from '../apps/api/src/config.js';
import { createDatabase } from '../apps/api/src/db/index.js';
import { buildApp } from '../apps/api/src/app.js';
const config = readConfig(); const database = createDatabase(config.DATABASE_URL);
const { app } = await buildApp(config, database, true); await app.ready();
await writeFile('openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close(); await database.pool.end(); console.log('openapi.json exported');
