#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

/**
 * One command to get from a fresh clone to a running app.
 *
 * Every step is idempotent, so this is also the command to run on any later
 * morning: it installs only what is missing, brings Postgres up, applies
 * migrations, seeds only an empty database, and then starts both services.
 *
 * Each step announces itself, because a setup script that fails silently is
 * worse than no setup script.
 */

const step = (message) => console.log(`\x1b[36m▸\x1b[0m ${message}`);
const done = (message) => console.log(`  \x1b[32m✓\x1b[0m ${message}`);

function run(command, options = {}) {
  return execSync(command, { stdio: 'inherit', ...options });
}

function quiet(command, options = {}) {
  return execSync(command, { stdio: 'pipe', encoding: 'utf8', ...options });
}

function fail(message, hint) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

// --- 1. Environment files ---------------------------------------------------
step('Environment files');
for (const [example, target] of [
  ['api/.env.example', 'api/.env'],
  ['web/.env.example', 'web/.env.local'],
]) {
  if (existsSync(target)) {
    done(`${target} already present`);
  } else {
    copyFileSync(example, target);
    done(`created ${target} from ${example}`);
  }
}

// --- 2. Dependencies --------------------------------------------------------
step('Dependencies');
for (const dir of ['.', 'api', 'web']) {
  const label = dir === '.' ? 'root' : dir;
  if (existsSync(`${dir}/node_modules`)) {
    done(`${label} already installed`);
    continue;
  }
  console.log(`  installing ${label}…`);
  run('npm install --no-audit --no-fund', { cwd: dir });
  done(`${label} installed`);
}

// --- 3. Postgres ------------------------------------------------------------
step('Postgres');
try {
  quiet('docker info');
} catch {
  fail('Docker is not running.', 'Start Docker Desktop and run `npm start` again.');
}
// `--wait` blocks until the container passes the healthcheck in the compose
// file, so the migration below cannot race the database coming up.
run('docker compose up -d --wait');
done('container healthy');

// --- 4. Schema --------------------------------------------------------------
step('Database schema');
run('npx prisma generate', { cwd: 'api', stdio: 'ignore' });
done('Prisma client generated');
run('npx prisma migrate deploy', { cwd: 'api', stdio: 'ignore' });
done('migrations applied');

// --- 5. Seed, only when empty ----------------------------------------------
step('Seed data');
let userCount = 0;
try {
  userCount = Number(
    quiet(
      'docker compose exec -T postgres psql -U daas -d daas -tAc "SELECT count(*) FROM users"',
    ).trim(),
  );
} catch {
  // Table missing or unreadable: treat as empty and let the seed decide.
}

if (userCount > 0) {
  // Seeding truncates, so re-running it would discard whatever you were
  // looking at. Reseed deliberately with `npm --prefix api run seed`.
  done(
    `${userCount} users already present — skipping (run \`npm --prefix api run seed\` to reset)`,
  );
} else {
  run('npm run seed', { cwd: 'api' });
}

// --- 6. Run -----------------------------------------------------------------
console.log('\n\x1b[36m▸\x1b[0m Starting API and web\n');
const dev = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: false });
dev.on('exit', (code) => process.exit(code ?? 0));
