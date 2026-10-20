import { z } from 'zod';

export interface ConfigIssue {
  /** Environment variable name, e.g. "WORKER_NAME". */
  variable: string;
  /** "missing" when the variable is unset or empty, otherwise "invalid". */
  kind: 'missing' | 'invalid';
  message: string;
}

/** Thrown by {@link loadConfig}. Lists every missing or invalid variable, never their values. */
export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';

  constructor(readonly issues: ConfigIssue[]) {
    super(
      `Invalid configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues
          .map((i) => `  - ${i.variable}: ${i.kind}${i.kind === 'invalid' ? `, ${i.message}` : ''}`)
          .join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables against a zod object schema and returns the typed result.
 * Empty strings count as unset, so `FOO=` in an .env file behaves like a missing variable and
 * schema defaults apply. Use `z.coerce.number()` / `z.stringbool()` for non-string values.
 *
 * @throws ConfigError listing every missing or invalid variable at once.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const input: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== '') input[key] = value;
  }

  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue): ConfigIssue => {
    const variable = issue.path.map(String).join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && input[variable] === undefined;
    return { variable, kind: missing ? 'missing' : 'invalid', message: issue.message };
  });
  throw new ConfigError(issues);
}

/**
 * {@link loadConfig} for app entry points: on invalid config, prints the problems to stderr and
 * exits with status 1 before anything else starts.
 */
export function loadConfigOrExit<S extends z.ZodObject>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  try {
    return loadConfig(schema, env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return process.exit(1);
  }
}

/**
 * Variables every Node app reads. Spread into an app schema:
 * `z.object({ ...commonEnv, PORT: z.coerce.number().default(3000) })`.
 */
export const commonEnv = {
  /** "development" switches logs to pretty output. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

/** A TCP port number, e.g. `PORT: port.default(3000)`. */
export const port = z.coerce.number().int().min(1).max(65535);
