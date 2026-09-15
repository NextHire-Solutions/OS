/*
 * What a self-chosen password must be. Pure, so it is tested without a server.
 *
 * Length is the rule that matters; character-class rules make people write
 * "Password1!" and remember nothing. 12 characters of anything is far past
 * what a hashed comparison behind a rate-limited sign-in can be searched.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validateNewPassword(next: string, current: string): string | null {
  if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (next.length > 200) return "That is longer than 200 characters.";
  if (next === current) return "Choose a password different from the current one.";
  if (/^(.)\1+$/.test(next)) return "That is one character repeated.";
  return null;
}
