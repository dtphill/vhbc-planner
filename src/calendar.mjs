export const TIME_ZONE = 'Australia/Melbourne';

export function localDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function fourthSunday(year, month) {
  const weekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 22 + (7 - weekday) % 7)).toISOString().slice(0, 10);
}

export function nextMeeting(now = new Date()) {
  const today = localDate(now);
  const [year, month] = today.split('-').map(Number);
  let date = fourthSunday(year, month - 1);
  if (date < today) date = fourthSunday(year, month);
  return {
    date,
    label: new Intl.DateTimeFormat('en-AU', {timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'}).format(new Date(`${date}T00:00:00Z`)),
    startTime: '10 am', timeZone: TIME_ZONE,
  };
}
