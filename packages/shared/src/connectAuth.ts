export const DEFAULT_HOSTED_APP_URL = "https://example.com";

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
}

/**
 * The CLI routes through the hosted /connect page rather than hitting Clerk's
 * /oauth/authorize directly: a signed-out browser sent straight to
 * /oauth/authorize goes through Clerk's sign-in redirect, which does not
 * reliably preserve the authorize query parameters (state, response_type,
 * code_challenge).
 */

/**
 * Redirect URI for the CLI's local callback listener. Must stay in sync with
 * the redirect URI registered on the Clerk CLI OAuth application.
 */
