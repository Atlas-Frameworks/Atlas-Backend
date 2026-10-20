import { commonEnv, loadConfigOrExit, port, z } from '@atlas/node-common';

/** Every environment variable view-service reads. Keep .env.example in sync. */
export const configSchema = z.object({
  ...commonEnv,
  /** Stable worker name. In OpenShift it comes from the StatefulSet pod name (metadata.name). */
  WORKER_NAME: z.string().min(1),
  /** HTTP + WebSocket port for clients. */
  PORT: port.default(3000),
  /** Worker-to-worker gRPC port. */
  GRPC_PORT: port.default(50051),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return loadConfigOrExit(configSchema, env);
}
