// tsc only emits .ts. Each domain loads its own .graphql at runtime, so the
// SDL has to land next to the compiled resolvers. Generic on purpose: a new
// domain folder needs no change here.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SRC = 'src/domains';
const OUT = 'dist/src/domains';

for (const domain of await readdir(SRC, { withFileTypes: true })) {
  if (!domain.isDirectory()) continue;

  for (const file of await readdir(join(SRC, domain.name))) {
    if (!file.endsWith('.graphql')) continue;

    const target = join(OUT, domain.name, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(SRC, domain.name, file), target);
    console.log(`copied ${target}`);
  }
}
