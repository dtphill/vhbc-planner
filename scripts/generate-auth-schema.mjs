import {DatabaseSync} from 'node:sqlite';
import {getMigrations} from 'better-auth/db/migration';
import {writeFile} from 'node:fs/promises';
import {authOptions} from '../src/auth.mjs';

const database = new DatabaseSync(':memory:');
const options = authOptions({DB:database, APP_URL:'http://localhost:8787', BETTER_AUTH_SECRET:'schema-generation-placeholder-never-deploy'}, null);
const migrations = await getMigrations(options);
await writeFile(new URL('../migrations/0001_auth.sql', import.meta.url), `-- Generated from Better Auth 1.7.15; regenerate with npm run schema.\n${await migrations.compileMigrations()}\n`);
database.close();
