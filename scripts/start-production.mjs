import { spawn } from 'node:child_process';

const migration = spawn(process.execPath, ['apps/api/dist/migrate.js'], { stdio: 'inherit', env: process.env });
const migrationCode = await new Promise((resolve) => migration.on('exit', resolve));
if (migrationCode !== 0) {
  console.error(`Database migration failed (${migrationCode})`);
  process.exit(Number(migrationCode) || 1);
}

const children = [
  spawn(process.execPath, ['apps/api/dist/index.js'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['apps/bff/dist/index.js'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;

const stop = (signal = 'SIGTERM') => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
};

for (const child of children) {
  child.on('error', (error) => { console.error(error); stop(); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Application process exited unexpectedly (${signal || code})`);
      process.exitCode = code || 1;
      stop();
    }
  });
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
