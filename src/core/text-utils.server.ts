const MAX_FIRST_MESSAGE_LENGTH = 4000;

/** Caps arbitrary pasted-in prompt text so one oversized paste can't blow up RPC payloads or the DB. */
export function capFirstMessage(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_FIRST_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_FIRST_MESSAGE_LENGTH)}...` : trimmed;
}
