// Calls the local manager API. The header marks the request as coming from this computer's manager page.
export async function managerApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/manager/${path}`, { headers: { "X-Nightwatch-Local": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The request failed. Please try again.");
  return data;
}
