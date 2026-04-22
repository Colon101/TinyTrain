import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const deploymentId = process.env.TINYTRAIN_DEPLOYMENT_ID ?? randomUUID();
const deploymentManifestPath = resolve('static/deployment.json');

mkdirSync(dirname(deploymentManifestPath), { recursive: true });
writeFileSync(deploymentManifestPath, `${JSON.stringify({ id: deploymentId }, null, 2)}\n`);
