export function completionContinuationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CAIRN_FORCE_COMPLETION_CONTINUATION === "1";
}
