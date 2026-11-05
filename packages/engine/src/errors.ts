/** The message of anything that was thrown: an Error's message, a thrown object's `message`, else the value as text. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e && e.message !== undefined && e.message !== null) return String(e.message);
  return String(e);
}
