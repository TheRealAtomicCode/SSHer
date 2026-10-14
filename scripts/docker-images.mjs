// Builds ssher/api and ssher/web for a Linux server and saves them as ssher-api.tar /
// ssher-web.tar, ready to drag onto SSHer's Docker page.
//
//   npm run docker:images                          amd64, Alpine base (the default)
//   npm run docker:images -- --base debian         amd64, Debian 12 (bookworm) base
//   npm run docker:images -- --arch arm64          for an ARM server (Graviton, Ampere, Pi)
//   npm run docker:images -- --only api            just one of the two images
//
// --arch must match the SERVER's CPU (`uname -m`: x86_64 = amd64, aarch64 = arm64), not
// this machine's — an Apple Silicon Mac builds arm64 unless told otherwise, and an
// image for the wrong CPU dies on start with "exec format error".
import { spawnSync } from 'node:child_process';

const BASES = {
  alpine: { NODE_IMAGE: 'node:22-alpine', NGINX_IMAGE: 'nginx:1.27-alpine' },
  debian: { NODE_IMAGE: 'node:22-bookworm-slim', NGINX_IMAGE: 'nginx:1.27' },
};
const ARCHS = ['amd64', 'arm64'];
const IMAGES = {
  api: { tag: 'ssher/api:latest', tar: 'ssher-api.tar', context: '.', dockerfile: 'server/Dockerfile', args: ['NODE_IMAGE'] },
  web: { tag: 'ssher/web:latest', tar: 'ssher-web.tar', context: 'client', dockerfile: 'client/Dockerfile', args: ['NODE_IMAGE', 'NGINX_IMAGE'] },
};

function option(name, fallback, allowed) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? fallback : process.argv[i + 1];
  if (!allowed.includes(value)) {
    console.error(`--${name} must be one of: ${allowed.join(', ')} (got ${value ?? 'nothing'})`);
    process.exit(1);
  }
  return value;
}

const base = option('base', 'alpine', Object.keys(BASES));
const arch = option('arch', 'amd64', ARCHS);
const only = option('only', 'both', ['both', ...Object.keys(IMAGES)]);

function docker(args) {
  console.log(`\n$ docker ${args.join(' ')}`);
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Building for linux/${arch} on a ${base} base`);
for (const [name, image] of Object.entries(IMAGES)) {
  if (only !== 'both' && only !== name) continue;
  const buildArgs = image.args.flatMap((a) => ['--build-arg', `${a}=${BASES[base][a]}`]);
  docker(['build', '--platform', `linux/${arch}`, ...buildArgs, '-f', image.dockerfile, '-t', image.tag, image.context]);
  docker(['save', '-o', image.tar, image.tag]);
}
console.log(`\nDone — linux/${arch}, ${base}. Drag the .tar file(s) onto SSHer's Docker page.`);
