/** A process's environment, as the code that reads it takes it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The value of the variable `name`, which the process cannot run without: unset or empty is an error. */
export function requiredOf(env: Env, name: string): string {
  const value = env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}
