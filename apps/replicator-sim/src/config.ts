import { commonEnv, loadConfigOrExit, port, z } from '@atlas/node-common';

/** Every environment variable replicator-sim reads. Keep .env.example in sync. */
export const configSchema = z.object({
  ...commonEnv,
  /** HTTP port (health and control endpoints). */
  PORT: port.default(3100),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfigOrExit(configSchema, env);
}
