/**
 * Kontrak API antara frontend (Astro) dan backend (backend/Code.gs).
 * Jika Anda mengubah nama action / field di sini, ubah juga di backend/Code.gs.
 */

export const ACTIONS = {
  REGISTER: 'register',
  LOGIN: 'login',
  ME: 'me',
  SUBMIT_ASSIGNMENT: 'submit_assignment',
  LOGOUT: 'logout',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

/** Status pendaftaran yang disimpan di kolom `status` pada sheet Users. */
export type RegistrationStatus = 'registered' | 'assignment_submitted' | 'checked_in';

export interface RsvpUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: RegistrationStatus;
  created_at: string;
  assignment_url: string;
  assignment_name: string;
  assignment_submitted_at: string;
  /** Kosong selama tiket masih terkunci (ditentukan oleh server). */
  ticket_code: string;
  ticket_unlocked: boolean;
}

export interface ApiRequest<T = Record<string, unknown>> {
  action: Action;
  /** ID Google Sheet milik event ini (dari field `spreadsheet_id` di file .toml). */
  spreadsheet_id: string;
  event_id: string;
  has_assignment: boolean;
  token?: string;
  data?: T;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AuthResult {
  token: string;
  user: RsvpUser;
}

export interface AssignmentPayload {
  filename: string;
  mime_type: string;
  base64: string;
  note?: string;
}

export const MAX_ASSIGNMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_ASSIGNMENT_EXT = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'png', 'jpg', 'jpeg'] as const;

/** Isi QR Code tiket. Panitia memindai string ini saat check-in. */
export function ticketPayload(eventId: string, ticketCode: string): string {
  return `RSVP:${eventId}:${ticketCode}`;
}
