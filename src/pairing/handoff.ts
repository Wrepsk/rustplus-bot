// Companion auth tokens are opaque. Upstream forwards them unchanged; they are
// not necessarily JWT/base64url strings. Permit bounded printable ASCII, including
// standard Base64 + / =, and reject whitespace/control characters. URLSearchParams
// and JSON encode the value at transport boundaries; never log it.
export const companionTokenPattern = /^[\x21-\x7e]{20,10000}$/;

// Only fixed, non-sensitive diagnostics may cross the extension/page boundary.
export const handoffErrors = {
  AUTH_PAYLOAD: 'Facepunch returned an unsupported login message.',
  AUTH_STEAM_ID: 'Facepunch returned an invalid Steam ID.',
  AUTH_TOKEN_FORMAT:
    'Facepunch returned an unsupported token format. Update both the website and extension.',
  MESSAGE_PORT:
    'The extension message channel closed. Reload the extension and start a fresh login.',
  NO_SESSION:
    'This login tab is no longer linked to a pairing session. Start from the website again.',
  SESSION_EXPIRED: 'The extension login session expired. Start a fresh sign-in.',
  WEBSITE_CLOSED: 'The original pairing website tab was closed. Start a fresh sign-in.',
  WEBSITE_NAVIGATED: 'The original pairing website tab changed pages. Start a fresh sign-in.',
  WEBSITE_RECEIVER:
    'The original website document is unavailable. Refresh the website and start a fresh sign-in.',
  WEBSITE_REJECTED:
    'The website did not acknowledge the login result. Refresh it and start a fresh sign-in.',
  CALLBACK_MISMATCH: 'The returned login belongs to a different pairing attempt.',
  DELIVERY_FAILED:
    'The extension could not return this login. Keep the original website tab open and start a fresh sign-in.',
  WORKER_ERROR:
    'The extension worker could not complete the handoff. Reload the extension and start a fresh sign-in.',
} as const;
