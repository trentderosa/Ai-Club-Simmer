/** "Evening, Jordan." or "Good evening." when we don't know a name. */
export function greetingFor(date: Date, firstName: string | null): string {
  const h = date.getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  if (!firstName) return `Good ${part}.`;
  return `${part[0].toUpperCase()}${part.slice(1)}, ${firstName}.`;
}

/** "Sunday, November 15" in the device locale's English form. */
export function formatToday(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
