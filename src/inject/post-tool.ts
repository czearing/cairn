const matches = (tool: string, name: string): boolean =>
  tool === name || tool.endsWith(name) || tool.includes(name);

const task = (tool: string): boolean =>
  /^(task|agent)$/i.test(tool) || tool === "Task" || tool === "Agent";

export function postToolPromptFiles(tool: string, _answer = ""): string[] {
  if (matches(tool, "brain_search")) return ["search-results.md"];
  if (matches(tool, "brain_create")) return ["node-created.md"];
  if (matches(tool, "brain_mutate")) return [];
  if (task(tool)) return ["orchestrate.md", "subtask-spawned.md"];
  return [];
}
