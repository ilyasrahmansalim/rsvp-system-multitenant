const TZ = 'Asia/Jakarta';

export function formatDate(d: Date): string {
  return d.toLocaleDateString('id-ID', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':') + ' WIB';
}
