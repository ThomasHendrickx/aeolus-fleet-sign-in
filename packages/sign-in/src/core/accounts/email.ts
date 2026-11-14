/** An account's email identifies its sign-in whatever case it is typed in: it is stored and compared in one form. */
export function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}
