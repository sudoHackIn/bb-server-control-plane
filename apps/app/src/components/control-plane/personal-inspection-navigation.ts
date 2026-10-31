export function personalInspectionSearch(
  search: string,
  runId: string,
  callId: string | null = null,
) {
  const query = new URLSearchParams(search);
  query.set("inspectRun", runId);
  query.delete("inspectThread");
  if (callId) query.set("inspectCall", callId);
  else query.delete("inspectCall");
  return `?${query}`;
}
